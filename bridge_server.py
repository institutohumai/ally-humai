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
    english_level: Optional[str] = None

    model_config = ConfigDict(str_strip_whitespace=True)


async def _flush_queue_locked() -> None:
    """Flush the buffered candidates to Supabase in batches."""
    global total_queue_length

    if total_queue_length == 0:
        return

    pending: Dict[QueueKey, List[Dict[str, Any]]] = {
        key: entries.copy() for key, entries in candidate_queues.items() if entries
    }

    if not pending:
        total_queue_length = 0
        return

    for key in list(candidate_queues.keys()):
        candidate_queues[key].clear()

    total_queue_length = 0

    for key, candidates in pending.items():
        if not candidates:
            continue

        agency_id, created_by = key
        total_batches = (len(candidates) + BATCH_SIZE - 1) // BATCH_SIZE
        batch_index = 0

        while batch_index < total_batches:
            start = batch_index * BATCH_SIZE
            end = min(start + BATCH_SIZE, len(candidates))
            batch_payload = [deepcopy(item) for item in candidates[start:end]]

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
                    "Batch %s for agency %s failed with status %s",
                    batch_index + 1,
                    agency_id,
                    status_detail,
                )
                _requeue_pending_batches(pending, key, start)
                raise RuntimeError("Supabase delivery failed")

            if batch_index + 1 < total_batches:
                await asyncio.sleep(WAIT_TIME_MS / 1000.0)

            batch_index += 1

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
    profile = await asyncio.to_thread(_resolve_supabase_profile, authorization, x_ally_user_id)

    agency_id = str(profile["agency_id"])
    created_by = str(profile["id"])

    if x_ally_agency_id and x_ally_agency_id != agency_id:
        raise HTTPException(status_code=403, detail="agency mismatch")

    candidate_dict = candidate.model_dump(exclude_none=True, mode="json")

    async with queue_lock:
        global total_queue_length

        url_key = candidate_dict.get("linkedin_url")
        duplicate_key = (agency_id, url_key) if url_key else None
        if duplicate_key and duplicate_key in processed_urls:
            LOG.info("Duplicate candidate ignored for %s (%s)", url_key, agency_id)
            return {"status": "ignored", "reason": "duplicate"}

        LOG.info("Candidate received for agency %s: %s", agency_id, candidate_dict)
        key = (agency_id, created_by)
        candidate_queues[key].append(candidate_dict)
        total_queue_length += 1

        if duplicate_key:
            processed_urls.add(duplicate_key)

        LOG.info("Candidate buffered. Queue length: %s", total_queue_length)

        if total_queue_length >= BATCH_SIZE:
            try:
                await _flush_queue_locked()
            except RuntimeError as exc:
                LOG.exception("Immediate flush failed")
                raise HTTPException(status_code=502, detail=str(exc))

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
