"""FastAPI bridge server that buffers candidates coming from the Chrome extension
and forwards them in batches to the Supabase import endpoint.
"""

import asyncio
from collections import defaultdict
from copy import deepcopy
import logging
import os
from typing import Any, Dict, List, Optional, Tuple

import requests
from fastapi import FastAPI, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, EmailStr, Field, HttpUrl

from import_candidates import (
    BATCH_SIZE,
    WAIT_TIME_MS,
    send_batch_to_api,
)

app = FastAPI(title="Ally Humai Bridge", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"]
)

# Queue state shared across requests
QueueKey = Tuple[str, str]
candidate_queues: Dict[QueueKey, List[Dict[str, Any]]] = defaultdict(list)
processed_urls: set[Tuple[str, str]] = set()
queue_lock = asyncio.Lock()
FLUSH_INTERVAL_SECONDS = 30  # Flush even if batch size not reached
LOG = logging.getLogger("bridge")
logging.basicConfig(level=logging.INFO)
total_queue_length = 0

SUPABASE_URL = os.getenv("SUPABASE_URL", "https://wiqehffqymegcbqgggjk.supabase.co")
SUPABASE_REST_URL = f"{SUPABASE_URL}/rest/v1"
SUPABASE_ANON_KEY = os.getenv(
    "SUPABASE_ANON_KEY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndpcWVoZmZxeW1lZ2NicWdnZ2prIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjEwNTYwMDEsImV4cCI6MjA3NjYzMjAwMX0.9R9VviyjfNIhPLyos05FGGm2yHH41sjgWj-NFApSNto"
)


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
    level_of_english: Optional[str] = None  # Updated field name

    model_config = ConfigDict(str_strip_whitespace=True)


async def _flush_queue_locked() -> None:
    """Flush the buffered candidates to Supabase in batches."""
    global total_queue_length

    if total_queue_length == 0:
        LOG.debug("[Bridge] Flush solicitado pero la cola está vacía")
        return

    pending: Dict[QueueKey, List[Dict[str, Any]]] = {
        key: entries.copy() for key, entries in candidate_queues.items() if entries
    }

    if not pending:
        total_queue_length = 0
        return

    for key in list(candidate_queues.keys()):
        candidate_queues[key].clear()

    LOG.info("[Bridge] Cola de candidatos limpiada tras flush")
    total_queue_length = 0

    for key, candidates in pending.items():
        if not candidates:
            continue

        agency_id, created_by = key
        total_batches = (len(candidates) + BATCH_SIZE - 1) // BATCH_SIZE
        batch_index = 0

        LOG.info("[Bridge] Flusheando %d candidatos para agency %s (creado por %s) en %d batches", len(candidates), agency_id, created_by, total_batches)

        while batch_index < total_batches:
            start = batch_index * BATCH_SIZE
            end = min(start + BATCH_SIZE, len(candidates))
            # Transformar cada candidato al formato de Supabase
            batch_payload = [_transform_candidate_for_supabase(deepcopy(item)) for item in candidates[start:end]]
            
            # Log de TODOS los objetos transformados para debugging
            for idx, transformed in enumerate(batch_payload):
                LOG.info("[Bridge] Candidato #%d transformado: %s", idx + 1, transformed)

            LOG.info("[Bridge] Enviando batch %d/%d a Supabase para agency %s", batch_index + 1, total_batches, agency_id)
            success, response = await asyncio.to_thread(
                send_batch_to_api,
                batch_payload,
                batch_index + 1,
                total_batches,
                agency_id,
                created_by,
            )

            if not success:
                status_detail = response.status_code if response else "no response"
                LOG.error(
                    "[Bridge] Batch %s para agency %s falló con status %s",
                    batch_index + 1,
                    agency_id,
                    status_detail,
                )
                _requeue_pending_batches(pending, key, start)
                raise RuntimeError("Supabase delivery failed")

            LOG.info("[Bridge] Batch %d/%d enviado correctamente", batch_index + 1, total_batches)

            if batch_index + 1 < total_batches:
                await asyncio.sleep(WAIT_TIME_MS / 1000.0)

            batch_index += 1

        LOG.info("[Bridge] Todos los batches enviados para agency %s", agency_id)
        pending[key] = []


async def _flush_queue_if_needed() -> None:
    async with queue_lock:
        try:
            await _flush_queue_locked()
        except RuntimeError:
            LOG.exception("Deferred flush failed")


async def periodic_flush_worker() -> None:
    """Background task that flushes queued candidates at intervals."""
    while True:
        await asyncio.sleep(FLUSH_INTERVAL_SECONDS)
        if total_queue_length == 0:
            continue
        await _flush_queue_if_needed()


@app.on_event("startup")
async def startup_event() -> None:
    asyncio.create_task(periodic_flush_worker())


@app.post("/candidates", status_code=202)
async def receive_candidate(
    candidate: CandidatePayload,
    authorization: str | None = Header(default=None),
    x_ally_user_id: str | None = Header(default=None),
    x_ally_agency_id: str | None = Header(default=None),
) -> Dict[str, str]:
    LOG.info("[Bridge] Payload recibido: %s", candidate.model_dump(exclude_none=True, mode="json"))
    profile = await asyncio.to_thread(_resolve_supabase_profile, authorization, x_ally_user_id)

    agency_id = str(profile["agency_id"])
    created_by = str(profile["id"])

    if x_ally_agency_id and x_ally_agency_id != agency_id:
        LOG.warning("[Bridge] Agency mismatch: header %s vs profile %s", x_ally_agency_id, agency_id)
        raise HTTPException(status_code=403, detail="agency mismatch")

    candidate_dict = candidate.model_dump(exclude_none=True, mode="json")
    LOG.info("[Bridge] Validando candidato para agency_id=%s, created_by=%s", agency_id, created_by)

    async with queue_lock:
        global total_queue_length

        url_key = candidate_dict.get("linkedin_url")
        duplicate_key = (agency_id, url_key) if url_key else None
        if duplicate_key and duplicate_key in processed_urls:
            LOG.info("[Bridge] Candidato duplicado ignorado para %s (%s)", url_key, agency_id)
            return {"status": "ignored", "reason": "duplicate"}

        LOG.info("[Bridge] Candidato recibido para agency %s: %s", agency_id, candidate_dict)
        key = (agency_id, created_by)
        candidate_queues[key].append(candidate_dict)
        total_queue_length += 1

        if duplicate_key:
            processed_urls.add(duplicate_key)

        LOG.info("[Bridge] Candidato bufferizado. Largo de la cola: %s", total_queue_length)

        if total_queue_length >= BATCH_SIZE:
            LOG.info("[Bridge] Se alcanzó el tamaño de batch. Flusheando candidatos...")
            try:
                await _flush_queue_locked()
                LOG.info("[Bridge] Flush inmediato exitoso")
            except RuntimeError as exc:
                LOG.exception("[Bridge] Error en flush inmediato")
                raise HTTPException(status_code=502, detail=str(exc))

    LOG.info("[Bridge] Candidato aceptado y encolado. Total en cola: %s", total_queue_length)
    return {"status": "accepted", "queued": str(total_queue_length)}


@app.get("/health")
async def healthcheck() -> Dict[str, str]:
    return {"status": "ok", "queued": str(total_queue_length)}


@app.get("/config")
async def bridge_config(
    authorization: str | None = Header(default=None),
    x_ally_user_id: str | None = Header(default=None),
) -> Dict[str, str]:
    profile = await asyncio.to_thread(_resolve_supabase_profile, authorization, x_ally_user_id)
    return {
        "agency_id": str(profile["agency_id"]),
        "created_by": str(profile["id"])
    }


def _transform_candidate_for_supabase(candidate: Dict[str, Any]) -> Dict[str, Any]:
    """Transforma el candidato al formato esperado por Supabase."""
    transformed = {}
    
    # Nombre completo y apellido
    if "name" in candidate:
        transformed["name"] = candidate["name"]
    
    # Apellido (requerido): usar last_name o extraer del nombre completo
    if "last_name" in candidate:
        transformed["lastname"] = candidate["last_name"]
    elif "name" in candidate:
        parts = candidate["name"].split()
        transformed["lastname"] = parts[-1] if len(parts) > 1 else candidate["name"]
    else:
        transformed["lastname"] = "N/A"
    
    # Email (opcional)
    if "email" in candidate:
        transformed["email"] = candidate["email"]
    
    # Teléfono (requerido)
    transformed["phone"] = candidate.get("phone", "N/A")
    
    # Lugar de residencia (requerido)
    transformed["place_of_residency"] = (
        candidate.get("place_of_residency") or 
        candidate.get("location") or 
        "N/A"
    )
    
    # LinkedIn URL (opcional)
    if "linkedin_url" in candidate:
        transformed["linkedin_url"] = candidate["linkedin_url"]
    
    # Portfolio alternativo (opcional)
    if "alternative_cv" in candidate:
        transformed["alternative_cv_portfolio"] = candidate["alternative_cv"]
    
    # Work Experience (requerido como JSONB)
    work_exp = candidate.get("work_experience", [])
    if work_exp and isinstance(work_exp, list):
        # Transformar al formato esperado
        transformed["work_experience"] = [
            {
                "title": exp.get("title", ""),
                "company": exp.get("company", ""),
                "date_from": exp.get("date_from", ""),
                "date_to": exp.get("date_to", ""),
                "description": exp.get("description", "")
            }
            for exp in work_exp
        ]
    else:
        transformed["work_experience"] = []
    
    # Education (requerido como TEXT): convertir array a string
    education = candidate.get("education", [])
    if education and isinstance(education, list):
        edu_strings = []
        for edu in education:
            parts = []
            if edu.get("degree"):
                parts.append(edu["degree"])
            if edu.get("institution"):
                parts.append(edu["institution"])
            if edu.get("date_from") or edu.get("date_to"):
                date_range = f"{edu.get('date_from', '')} - {edu.get('date_to', '')}".strip(" -")
                if date_range:
                    parts.append(f"({date_range})")
            if parts:
                edu_strings.append(" - ".join(parts))
        transformed["education"] = " | ".join(edu_strings) if edu_strings else "N/A"
    else:
        transformed["education"] = education if isinstance(education, str) else "N/A"
    
    # Nivel de inglés (mapeo de valores de LinkedIn a valores aceptados)
    english_level_map = {
        "competencia básica": "basic",
        "competencia básica limitada": "basic",
        "competencia básica profesional": "intermediate",
        "competencia profesional completa": "advanced",
        "competencia bilingüe o nativa": "native"
    }

    english_level = candidate.get("level_of_english", "").strip().lower()
    LOG.info("[Bridge] Nivel de inglés recibido: '%s'", english_level)

    transformed["level_of_english"] = english_level_map.get(english_level, "")

    
    # Main skills (opcional, array)
    if "skills" in candidate:
        transformed["main_skills"] = candidate["skills"]

    # Certifications (opcional, array)
    if "certifications" in candidate:
        transformed["certifications"] = candidate["certifications"]

    return transformed


def _requeue_pending_batches(
    pending: Dict[QueueKey, List[Dict[str, Any]]],
    failed_key: QueueKey,
    failed_start_index: int,
) -> None:
    global total_queue_length

    for key, items in pending.items():
        if key == failed_key:
            requeue_items = items[failed_start_index:]
        else:
            requeue_items = items

        if not requeue_items:
            continue

        candidate_queues[key].extend(requeue_items)
        total_queue_length += len(requeue_items)


def _resolve_supabase_profile(
    authorization_header: Optional[str],
    user_id_header: Optional[str],
) -> Dict[str, Any]:
    if not authorization_header:
        raise HTTPException(status_code=401, detail="missing authorization header")

    token = _strip_bearer_token(authorization_header)
    params = {"select": "id,agency_id", "limit": 1}
    if user_id_header:
        params["id"] = f"eq.{user_id_header}"

    try:
        response = requests.get(
            f"{SUPABASE_REST_URL}/profiles",
            params=params,
            headers={
                "apikey": SUPABASE_ANON_KEY,
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
            },
            timeout=10,
        )
    except requests.RequestException as error:
        LOG.error("Supabase profile request failed: %s", error)
        raise HTTPException(status_code=502, detail="supabase profile request failed") from error

    if response.status_code != 200:
        LOG.error("Supabase profile request status %s", response.status_code)
        raise HTTPException(status_code=502, detail="invalid supabase response")

    try:
        data = response.json()
    except ValueError as error:
        LOG.error("Supabase profile response not JSON: %s", error)
        raise HTTPException(status_code=502, detail="invalid supabase response") from error

    if not data:
        raise HTTPException(status_code=404, detail="profile not found")

    profile = data[0]
    if "agency_id" not in profile or "id" not in profile:
        raise HTTPException(status_code=502, detail="profile missing required fields")

    return profile


def _strip_bearer_token(header_value: str) -> str:
    if header_value.lower().startswith("bearer "):
        return header_value[7:]
    return header_value


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("bridge_server:app", host="0.0.0.0", port=8000, reload=True)
