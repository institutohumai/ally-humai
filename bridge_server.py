"""
Bridge Server Stateless para AWS Lambda.
Recibe candidatos, los transforma y los pasa inmediatamente a la Edge Function de Supabase.
"""

import logging
import os
import requests
from fastapi import FastAPI, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, EmailStr, Field, HttpUrl
from typing import List, Optional, Dict, Any
from mangum import Mangum  # NECESARIO PARA AWS LAMBDA

# Configuración de Logs
LOG = logging.getLogger("bridge")
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="Ally Humai Bridge Stateless", version="2.0.0")

# CORS: Permite que la extensión hable con el servidor
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], 
    allow_methods=["*"],
    allow_headers=["*"]
)

# --- VARIABLES DE ENTORNO ---
# En local las toma de tu archivo .env o del sistema. En AWS se configuran en la consola.
SUPABASE_URL = os.getenv("SUPABASE_URL", "https://wiqehffqymegcbqgggjk.supabase.co")
SUPABASE_ANON_KEY = os.getenv(
    "SUPABASE_ANON_KEY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndpcWVoZmZxeW1lZ2NicWdnZ2prIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjEwNTYwMDEsImV4cCI6MjA3NjYzMjAwMX0.9R9VviyjfNIhPLyos05FGGm2yHH41sjgWj-NFApSNto"
)
# La URL de la función que Lovable configuró/modificó
SUPABASE_FUNCTION_URL = f"{SUPABASE_URL}/functions/v1/import-candidates"

# --- MODELOS DE DATOS (Igual que antes) ---
class ExperiencePayload(BaseModel):
    title: Optional[str] = None
    company: Optional[str] = None
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    location: Optional[str] = None
    description: Optional[str] = None
    model_config = ConfigDict(str_strip_whitespace=True)

class EducationPayload(BaseModel):
    institution: Optional[str] = None
    degree: Optional[str] = None
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    model_config = ConfigDict(str_strip_whitespace=True)

class CandidatePayload(BaseModel):
    name: str = Field(..., min_length=1)
    linkedin_url: Optional[HttpUrl] = None
    role: Optional[str] = None
    organization: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[EmailStr] = None
    location: Optional[str] = None
    last_name: Optional[str] = None
    place_of_residency: Optional[str] = None
    alternative_cv: Optional[HttpUrl] = None
    work_experience: Optional[List[ExperiencePayload]] = None
    education: Optional[List[EducationPayload]] = None
    level_of_english: Optional[str] = None
    # Agregamos proyectos y skills por si el scraper los envía
    projects: Optional[List[Dict[str, Any]]] = None 
    skills: Optional[List[str]] = None
    certifications: Optional[List[Dict[str, Any]]] = None
    languages: Optional[List[Dict[str, Any]]] = None
    about: Optional[str] = None
    model_config = ConfigDict(str_strip_whitespace=True)

# --- LÓGICA DE TRANSFORMACIÓN ---
def _transform_candidate_for_supabase(candidate: Dict[str, Any]) -> Dict[str, Any]:
    """Adapta el JSON de la extensión al formato que espera la DB."""
    transformed = {}
    
    # Mapeo directo
    transformed["name"] = candidate.get("name")
    transformed["email"] = candidate.get("email")
    transformed["phone"] = candidate.get("phone", "N/A")
    transformed["place_of_residency"] = candidate.get("place_of_residency") or candidate.get("location") or "N/A"
    
    if "linkedin_url" in candidate:
        transformed["linkedin_url"] = str(candidate["linkedin_url"])
    if "alternative_cv" in candidate:
        transformed["alternative_cv_portfolio"] = str(candidate["alternative_cv"])
    
    # Apellido inteligente
    if "last_name" in candidate and candidate["last_name"]:
        transformed["lastname"] = candidate["last_name"]
    elif "name" in candidate:
        parts = candidate["name"].split()
        transformed["lastname"] = parts[-1] if len(parts) > 1 else ""
    else:
        transformed["lastname"] = "N/A"

    # Experiencia
    work_exp = candidate.get("work_experience", [])
    if work_exp:
        transformed["work_experience"] = work_exp # Pasamos la lista de dicts
    else:
        transformed["work_experience"] = []

    # Educación (Formato texto legacy o lista si la DB lo soporta)
    # Por ahora mantenemos tu lógica de convertir a string para asegurar compatibilidad
    education = candidate.get("education", [])
    if education and isinstance(education, list):
        edu_strings = []
        for edu in education:
            parts = []
            if edu.get("degree"): parts.append(edu["degree"])
            if edu.get("institution"): parts.append(edu["institution"])
            if edu.get("date_from") or edu.get("date_to"):
                date_range = f"{edu.get('date_from', '')} - {edu.get('date_to', '')}".strip(" -")
                if date_range: parts.append(f"({date_range})")
            if parts: edu_strings.append(" - ".join(parts))
        transformed["education"] = " | ".join(edu_strings) if edu_strings else "N/A"
    else:
        transformed["education"] = "N/A"

    # Otros campos
    if "level_of_english" in candidate: transformed["level_of_english"] = candidate["level_of_english"]
    if "skills" in candidate: transformed["main_skills"] = candidate["skills"]
    if "certifications" in candidate: transformed["certifications"] = candidate["certifications"]
    if "languages" in candidate: transformed["languages"] = candidate["languages"]
    if "about" in candidate: transformed["about"] = candidate["about"]
    
    # IMPORTANTE: Si Lovable actualizó la Edge Function para aceptar 'projects' o 'languages', 
    # agrégalos aquí. Si no, Supabase los ignorará.
    
    return transformed

# --- ENDPOINTS ---

@app.get("/health")
def health():
    return {"status": "ok", "mode": "stateless_lambda"}

@app.post("/candidates", status_code=202)
async def receive_candidate(
    candidate: CandidatePayload,
    authorization: str | None = Header(default=None),
    x_ally_user_id: str | None = Header(default=None),
    x_ally_agency_id: str | None = Header(default=None),
):
    """
    Recibe el candidato y lo reenvía a la Edge Function de Supabase.
    La Edge Function se encargará del Upsert (evitar duplicados).
    """
    LOG.info(f"[Bridge] Procesando candidato: {candidate.name}")

    
    if not authorization:
        raise HTTPException(status_code=401, detail="Missing Authorization header")

    # 1. Transformar datos
    candidate_dict = candidate.model_dump(exclude_none=True, mode="json")
    transformed_payload = _transform_candidate_for_supabase(candidate_dict)

    # 2. Preparar payload para la Edge Function
    # La Edge Function espera: { "agency_id": "...", "created_by": "...", "candidates": [...] }
    # Podemos pasar agency_id y created_by en el cuerpo si la función lo requiere,
    # o confiar en que la función extraiga el usuario del token JWT (Authorization).
    # Por seguridad y compatibilidad con tu código anterior, los pasamos si vienen en el header.
    
    edge_payload = {
        "candidates": [transformed_payload]
    }
    
    if x_ally_agency_id:
        edge_payload["agency_id"] = x_ally_agency_id
    if x_ally_user_id:
        edge_payload["created_by"] = x_ally_user_id

    # 3. Enviar a Supabase (El "Pasamanos")
    headers = {
        "Content-Type": "application/json",
        "Authorization": authorization, # Pasamos el token del usuario tal cual llegó
        "apikey": SUPABASE_ANON_KEY
    }

    try:
        response = requests.post(SUPABASE_FUNCTION_URL, json=edge_payload, headers=headers, timeout=15)
        
        if response.status_code == 200:
            LOG.info("[Bridge] Éxito: Candidato entregado a Supabase.")
            return {"status": "processed", "detail": "Forwarded to DB"}
        else:
            LOG.error(f"[Bridge] Error desde Supabase: {response.status_code} - {response.text}")
            # Devolvemos error a la extensión para que ella sepa que falló
            raise HTTPException(status_code=response.status_code, detail=f"Supabase Error: {response.text}")

    except requests.RequestException as e:
        LOG.error(f"[Bridge] Error de conexión con Supabase: {e}")
        raise HTTPException(status_code=502, detail="Failed to connect to database function")

# Adaptador para AWS Lambda
handler = Mangum(app)