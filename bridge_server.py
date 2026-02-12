import logging
import os
import json
import requests
import google.generativeai as genai
from fastapi import FastAPI, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict
from typing import Optional, Dict, Any
from mangum import Mangum

# Configuración de Logs
LOG = logging.getLogger("bridge")
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="Ally Humai AI Bridge (Gemini)", version="3.3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], 
    allow_methods=["*"],
    allow_headers=["*"]
)

# --- CONFIGURACIÓN DE CREDENCIALES ---

SUPABASE_URL = os.getenv("SUPABASE_URL", "https://wiqehffqymegcbqgggjk.supabase.co")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY")
SUPABASE_FUNCTION_URL = f"{SUPABASE_URL}/functions/v1/import-candidates"

# 1. Intentamos leer la clave del entorno (Lo correcto para Prod)
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")

# 2. Si no existe (Debug Local), usamos la clave directa
if not GOOGLE_API_KEY:
    # REEMPLAZA CON TU KEY SI LA NECESITAS EN LOCAL
    GOOGLE_API_KEY = "AIzaSyCaXUclGZAlHiJpawZlXH_2p9BFB5GAifI" 

# 3. Validación final y Configuración
if not GOOGLE_API_KEY:
    raise RuntimeError("GOOGLE_API_KEY no encontrada. Configúrala en variables de entorno o en el código.")

genai.configure(api_key=GOOGLE_API_KEY)


# --- MODELOS ---
class RawProfilePayload(BaseModel):
    raw_text: str
    linkedin_url: str
    known_name: Optional[str] = None 
    model_config = ConfigDict(str_strip_whitespace=True)

# --- LÓGICA IA (GEMINI) ---
def _parse_profile_with_ai(text: str, url: str) -> Dict[str, Any]:
    LOG.info(f"[AI] Procesando perfil: {url}")
    
    generation_config = {
        "temperature": 0.1,
        "response_mime_type": "application/json",
    }

    # --- PROMPT ACTUALIZADO ---
    system_prompt = """
    Eres un experto reclutador IT. Tu trabajo es extraer datos estructurados de un texto desordenado de un perfil de LinkedIn.
    Extrae la información y devuélvela en formato JSON.
    
    Campos requeridos:
    - name (string)
    - role (string, último cargo)
    - email (string o null)
    - phone (string o null)
    - location (string)
    - level_of_english (string. Si no se menciona, string vacío)
    - languages (lista de objetos con: language, description. Ejemplo: [{"language": "Francés", "description": "Nativo o Bilingüe"}])
    - skills (lista de strings)
    - other_relevant_data (string. Aquí pon TODO el texto de la sección "Acerca de" o "About". Si es muy largo, resúmelo manteniendo las tecnologías y logros clave.)
    - certifications (lista de objetos con: name, issuer, issue_date. Si no encuentras, lista vacía)
    - work_experience (lista de objetos con: title, company, date_from, date_to, description)
    - education (lista de objetos con: institution, degree, date_from, date_to)

    Si no encuentras un dato, usa null o lista vacía. Intenta formatear fechas como YYYY-MM.
    """

    try:
        model = genai.GenerativeModel(
            model_name="gemini-2.0-flash",
            system_instruction=system_prompt,
            generation_config=generation_config
        )

        prompt = f"URL del perfil: {url}\n\nTEXTO DEL PERFIL:\n{text[:25000]}" 

        LOG.info("[AI] Enviando a Google...")
        response = model.generate_content(prompt)
        LOG.info("[AI] Respuesta recibida.")
        
        return json.loads(response.text)

    except Exception as e:
        LOG.error(f"[AI] Error crítico con Gemini: {e}")
        return {"_error": str(e)}

# --- ENDPOINTS ---
@app.get("/health")
def health():
    return {"status": "ok", "mode": "gemini_powered"}

@app.post("/candidates", status_code=202)
async def receive_candidate(
    payload: RawProfilePayload,
    authorization: str | None = Header(default=None),
    x_ally_user_id: str | None = Header(default=None),
    x_ally_agency_id: str | None = Header(default=None),
):
    LOG.info(f"[Bridge] Recibido RAW de: {payload.linkedin_url}")

    # 1. IA
    extracted_data = _parse_profile_with_ai(payload.raw_text, payload.linkedin_url)

    if not extracted_data:
        raise HTTPException(status_code=500, detail="AI returned empty response")
    
    if "_error" in extracted_data:
        raise HTTPException(status_code=500, detail=f"AI Error: {extracted_data['_error']}")

    # 2. PROCESAMIENTO
    final_candidate = extracted_data
    final_candidate["linkedin_url"] = payload.linkedin_url
    if payload.known_name: 
        final_candidate["name"] = payload.known_name

    # 3. MAPEO (Separar nombre/apellido)
    full_name = final_candidate.get("name", "")
    name_parts = full_name.split()
    if len(name_parts) > 1:
        final_candidate["name"] = " ".join(name_parts[:-1]) 
        final_candidate["lastname"] = name_parts[-1] 
    else:
        final_candidate["lastname"] = "" 

    # --- PAYLOAD FINAL A SUPABASE ---
    supabase_payload = {
        "name": final_candidate.get("name"),
        "lastname": final_candidate.get("lastname"),
        "email": final_candidate.get("email"),
        "phone": final_candidate.get("phone", "N/A"),
        "place_of_residency": final_candidate.get("location", "N/A"),
        "linkedin_url": final_candidate.get("linkedin_url"),
        "work_experience": final_candidate.get("work_experience", []),
        "education": str(final_candidate.get("education", [])),
        "main_skills": final_candidate.get("skills", []),
        
        # Inglés (String simple)
        "level_of_english": final_candidate.get("level_of_english", ""),
        
        # Otros Idiomas (Lista de objetos) - NUEVO
        "languages": final_candidate.get("languages", []),

        # Datos adicionales
        "other_relevant_data": final_candidate.get("other_relevant_data", ""),
        "certifications": final_candidate.get("certifications", []) 
    }

    # 4. ENVÍO A SUPABASE
    edge_payload = {
        "candidates": [supabase_payload],
        "agency_id": x_ally_agency_id,
        "created_by": x_ally_user_id
    }
    
    headers = {
        "Content-Type": "application/json",
        "Authorization": authorization or "",
        "apikey": SUPABASE_ANON_KEY
    }

    LOG.info(f"[Bridge] Objeto de candidato enviado a Supabase: {edge_payload}")

    try:
        resp = requests.post(SUPABASE_FUNCTION_URL, json=edge_payload, headers=headers, timeout=20)
        if resp.status_code >= 400:
             LOG.error(f"Supabase Error {resp.status_code}: {resp.text}")
             raise HTTPException(status_code=resp.status_code, detail=f"DB Error: {resp.text}")
             
        LOG.info("[Bridge] Éxito total.")
        return {"status": "processed_with_gemini", "data": final_candidate}
        
    except requests.RequestException as e:
        LOG.error(f"[Bridge] Error red Supabase: {e}")
        raise HTTPException(status_code=502, detail="Failed to reach DB")

handler = Mangum(app)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("bridge_server:app", host="0.0.0.0", port=8000, reload=True)