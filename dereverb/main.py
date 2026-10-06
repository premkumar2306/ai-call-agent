"""
main.py
=======

FastAPI application for **EchoStrip** - a one-click audio de-reverberation
(echo removal) micro-SaaS with a live competitor benchmarking dashboard.

Routes
------
``GET  /``                      Dashboard (upload + results single-page UI).
``POST /upload``                Accept an audio file, de-reverb it, return JSON
                                containing real benchmark numbers and the
                                Competitor Comparison Matrix.
``GET  /audio/{job_id}/original``  Stream the untouched upload.
``GET  /audio/{job_id}/cleaned``   Stream the de-reverbed result.
``GET  /download/{job_id}``        Same as above but as an attachment.
``GET  /healthz``               Liveness + engine availability for monitoring.

Operational safeguards
----------------------
* 25 MB upload ceiling, enforced while streaming (a lying ``Content-Length``
  cannot get past it) and again on the declared header for a fast rejection.
* Every artefact is named with a server-generated UUID4, so two concurrent
  uploads of ``interview.wav`` can never collide or overwrite each other.
* Path parameters are parsed as UUIDs before touching the filesystem, which
  makes path traversal structurally impossible.
* CPU-bound work runs on a thread with a concurrency semaphore, keeping the
  event loop responsive and bounding peak memory.
* A background janitor deletes artefacts older than the retention window.

Run locally::

    pip install -r requirements.txt
    uvicorn main:app --reload --port 8000
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncIterator, Dict, List, Optional

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.templating import Jinja2Templates

from audio_processor import (
    SUPPORTED_EXTENSIONS,
    AudioProcessingError,
    AudioStats,
    Benchmark,
    DereverbPipeline,
)

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #

APP_NAME = "EchoStrip"
APP_TAGLINE = "One-click AI echo & room-reverb removal"
BASE_DIR = Path(__file__).resolve().parent

#: Hard upload ceiling. Protects server memory and the processing queue.
MAX_UPLOAD_MB = float(os.getenv("DEREVERB_MAX_UPLOAD_MB", "25"))
MAX_UPLOAD_BYTES = int(MAX_UPLOAD_MB * 1024 * 1024)

#: Bytes pulled off the socket per iteration while persisting an upload.
UPLOAD_CHUNK_BYTES = 1024 * 1024

#: Where uploads and results live. Mounted volume in production.
STORAGE_ROOT = Path(os.getenv("DEREVERB_STORAGE_DIR", BASE_DIR / "storage")).resolve()
UPLOAD_DIR = STORAGE_ROOT / "uploads"
OUTPUT_DIR = STORAGE_ROOT / "outputs"

#: Artefacts are deleted this long after creation (privacy + disk hygiene).
RETENTION_MINUTES = float(os.getenv("DEREVERB_RETENTION_MINUTES", "60"))
JANITOR_INTERVAL_SECONDS = float(os.getenv("DEREVERB_JANITOR_INTERVAL", "300"))

#: How many files may be de-reverbed at once. DeepFilterNet is CPU-hungry, so
#: queueing is better than thrashing.
MAX_CONCURRENT_JOBS = int(os.getenv("DEREVERB_MAX_CONCURRENT_JOBS", "2"))

#: Set ``DEREVERB_WARMUP=1`` to load model weights at boot instead of on the
#: first customer request (recommended for production).
WARM_UP_ON_START = os.getenv("DEREVERB_WARMUP", "0").strip().lower() in {"1", "true", "yes", "on"}

logging.basicConfig(
    level=os.getenv("DEREVERB_LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)-8s [%(name)s] %(message)s",
)
LOGGER = logging.getLogger("dereverb.api")


# --------------------------------------------------------------------------- #
# Competitor baseline data
# --------------------------------------------------------------------------- #
#
# IMPORTANT, read before editing:
#
# These are *indicative reference baselines* for well-known de-reverb tools,
# not live measurements of competitor software. They model the published
# workflow of each product (offline render vs. realtime plugin) so the matrix
# can show an apples-to-apples estimate for the user's specific file. The UI
# labels them as estimates. Only the "EchoStrip" row is measured.
#
# * ``throughput_x_realtime`` - seconds of audio processed per second of
#   compute on a typical modern laptop CPU. 1.0 == realtime. Legacy desktop
#   de-reverb renders hover around realtime because the algorithms are
#   designed for interactive, in-session use.
# * ``operator_seconds`` - hands-on human time: launching the host, importing,
#   auditioning slider settings, bouncing, exporting.
#
COMPETITOR_BASELINES: List[Dict[str, Any]] = [
    {
        "key": "izotope_rx",
        "tool": "iZotope RX - De-reverb",
        "category": "Legacy desktop suite",
        "throughput_x_realtime": 0.8,
        "operator_seconds": 180,
        "manual_controls": "4+ sliders (reduction, artifact smoothing, tail, EQ)",
        "workflow": "Install, import, tune, render, export",
        "delivery": "Desktop app / DAW plugin",
        "price": "$399+ perpetual licence",
        "api_or_batch": "Batch in Advanced tier only",
        "note": "Indicative desktop-render estimate, not a live measurement.",
    },
    {
        "key": "waves_clarity_vx",
        "tool": "Waves Clarity Vx DeVerb",
        "category": "Realtime DAW plugin",
        "throughput_x_realtime": 1.0,
        "operator_seconds": 120,
        "manual_controls": "2 sliders (reverb reduction, dry/wet)",
        "workflow": "Install, host in DAW, tune, bounce",
        "delivery": "Plugin - requires a DAW host",
        "price": "$99 list (frequent promos)",
        "api_or_batch": "No HTTP API",
        "note": "Realtime-capable plugin: a render is roughly file length.",
    },
]

#: Footnotes rendered under the matrix so the numbers are never misread.
MATRIX_NOTES: List[str] = [
    f"The {APP_NAME} row is measured live from your file on this server - "
    "nothing in it is estimated.",
    "Competitor figures are indicative baselines modelled from each product's "
    "published workflow (offline render vs. realtime plugin) on a typical "
    "laptop CPU. They are not live benchmarks of competitor software, and "
    "pricing moves with vendor promotions.",
    "\"Hands-on time\" counts human minutes: launching a host, importing, "
    "auditioning slider settings and exporting.",
]


def _format_duration(seconds: float) -> str:
    """Render a duration the way a dashboard should: terse and scannable."""
    if seconds < 1:
        return f"{seconds * 1000:.0f} ms"
    if seconds < 60:
        return f"{seconds:.1f} s"
    minutes, remainder = divmod(int(round(seconds)), 60)
    return f"{minutes}m {remainder:02d}s"


def build_comparison_matrix(original: AudioStats, benchmark: Benchmark) -> Dict[str, Any]:
    """Build the Competitor Comparison Matrix for one finished job.

    The first row is this app's *measured* performance; the remaining rows
    project each competitor's baseline onto the same audio length so every
    number in the table refers to the user's actual file.
    """
    audio_seconds = max(benchmark.audio_seconds, 0.001)
    rows: List[Dict[str, Any]] = [
        {
            "key": "echostrip",
            "tool": f"{APP_NAME} (this app)",
            "category": "Cloud AI - DeepFilterNet",
            "is_self": True,
            "measured": True,
            "speed_label": f"{benchmark.speed_ratio:.1f}x realtime",
            "speed_ratio": benchmark.speed_ratio,
            "machine_time": _format_duration(benchmark.total_seconds),
            "machine_seconds": round(benchmark.total_seconds, 3),
            "operator_time": "~5 s (drag, drop, download)",
            "operator_seconds": 5,
            "manual_controls": "Zero - 1-click workflow",
            "workflow": "Drag & drop in the browser",
            "delivery": "Cloud - nothing to install",
            "price": "Usage-based, no licence",
            "api_or_batch": "HTTP API (POST /upload)",
            "note": "Measured on this server for this file.",
        }
    ]

    for baseline in COMPETITOR_BASELINES:
        throughput = max(float(baseline["throughput_x_realtime"]), 0.01)
        machine_seconds = audio_seconds / throughput
        rows.append(
            {
                "key": baseline["key"],
                "tool": baseline["tool"],
                "category": baseline["category"],
                "is_self": False,
                "measured": False,
                "speed_label": f"~{throughput:.1f}x realtime",
                "speed_ratio": round(throughput, 2),
                "machine_time": f"~{_format_duration(machine_seconds)}",
                "machine_seconds": round(machine_seconds, 3),
                "operator_time": f"~{_format_duration(float(baseline['operator_seconds']))}",
                "operator_seconds": baseline["operator_seconds"],
                "manual_controls": baseline["manual_controls"],
                "workflow": baseline["workflow"],
                "delivery": baseline["delivery"],
                "price": baseline["price"],
                "api_or_batch": baseline["api_or_batch"],
                "note": baseline["note"],
            }
        )

    self_row = rows[0]
    competitor_rows = rows[1:]
    slowest = max(competitor_rows, key=lambda row: row["machine_seconds"])

    # Headline edge: machine time saved vs. the slowest legacy render, plus the
    # total round-trip saving once human slider-tweaking time is counted.
    speed_multiple = (
        slowest["machine_seconds"] / self_row["machine_seconds"]
        if self_row["machine_seconds"] > 0
        else 0.0
    )
    self_round_trip = self_row["machine_seconds"] + self_row["operator_seconds"]
    best_competitor_round_trip = min(
        row["machine_seconds"] + float(row["operator_seconds"]) for row in competitor_rows
    )

    return {
        "rows": rows,
        "notes": MATRIX_NOTES,
        "edge": {
            "speed_multiple": round(speed_multiple, 1),
            "speed_headline": f"{speed_multiple:.1f}x faster render than {slowest['tool']}",
            "round_trip_saved": _format_duration(
                max(best_competitor_round_trip - self_round_trip, 0.0)
            ),
            "sliders_touched": 0,
            "workflow_headline": "Zero manual sliders - 1-click workflow",
        },
    }


# --------------------------------------------------------------------------- #
# Job bookkeeping
# --------------------------------------------------------------------------- #


@dataclass
class JobRecord:
    """In-memory metadata for one processed file."""

    job_id: str
    original_name: str
    original_path: Path
    cleaned_path: Path
    created_at: float
    payload: Dict[str, Any]


class JobStore:
    """Thread-safe registry of recent jobs.

    Deliberately in-memory: artefacts are short-lived by design, and file
    lookups fall back to disk so a process restart does not break an open tab.
    """

    def __init__(self) -> None:
        self._jobs: Dict[str, JobRecord] = {}
        self._lock = asyncio.Lock()

    async def put(self, record: JobRecord) -> None:
        async with self._lock:
            self._jobs[record.job_id] = record

    async def get(self, job_id: str) -> Optional[JobRecord]:
        async with self._lock:
            return self._jobs.get(job_id)

    async def forget(self, job_ids: List[str]) -> None:
        async with self._lock:
            for job_id in job_ids:
                self._jobs.pop(job_id, None)

    async def expired_ids(self, cutoff: float) -> List[str]:
        async with self._lock:
            return [jid for jid, rec in self._jobs.items() if rec.created_at < cutoff]


JOB_STORE = JobStore()
PIPELINE = DereverbPipeline()
JOB_SEMAPHORE = asyncio.Semaphore(MAX_CONCURRENT_JOBS)


# --------------------------------------------------------------------------- #
# Retention / cleanup
# --------------------------------------------------------------------------- #


def _purge_expired_files() -> int:
    """Delete artefacts older than the retention window. Returns file count."""
    cutoff = time.time() - RETENTION_MINUTES * 60
    removed = 0
    for directory in (UPLOAD_DIR, OUTPUT_DIR):
        if not directory.is_dir():
            continue
        for entry in directory.iterdir():
            try:
                if entry.is_dir():
                    if entry.stat().st_mtime < cutoff:
                        shutil.rmtree(entry, ignore_errors=True)
                        removed += 1
                elif entry.stat().st_mtime < cutoff:
                    entry.unlink(missing_ok=True)
                    removed += 1
            except OSError as exc:  # pragma: no cover - transient FS races
                LOGGER.warning("cleanup skipped %s: %s", entry, exc)
    if removed:
        LOGGER.info("retention sweep removed %d artefact(s)", removed)
    return removed


async def _run_retention_sweep() -> None:
    """Sweep expired files and drop their registry entries."""
    await asyncio.to_thread(_purge_expired_files)
    cutoff = time.time() - RETENTION_MINUTES * 60
    stale = await JOB_STORE.expired_ids(cutoff)
    if stale:
        await JOB_STORE.forget(stale)


async def _janitor_loop() -> None:
    """Periodic retention sweep; survives individual sweep failures."""
    while True:
        try:
            await asyncio.sleep(JANITOR_INTERVAL_SECONDS)
            await _run_retention_sweep()
        except asyncio.CancelledError:
            raise
        except Exception:  # pragma: no cover - keep the janitor alive
            LOGGER.exception("retention sweep failed")


# --------------------------------------------------------------------------- #
# App lifespan
# --------------------------------------------------------------------------- #


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Create storage, report engine status, warm the model, start the janitor."""
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    LOGGER.info("%s starting - storage=%s", APP_NAME, STORAGE_ROOT)
    LOGGER.info(
        "limits: max_upload=%.0fMB concurrency=%d retention=%.0fmin",
        MAX_UPLOAD_MB,
        MAX_CONCURRENT_JOBS,
        RETENTION_MINUTES,
    )

    status = PIPELINE.engine_status()
    if status["available"]:
        LOGGER.info("de-reverb engine ready: %s", status["name"])
        if WARM_UP_ON_START:
            await asyncio.to_thread(PIPELINE.warm_up)
    else:
        # Boot anyway so /healthz can report the problem instead of crash-looping.
        LOGGER.error("de-reverb engine UNAVAILABLE: %s", status["detail"])

    await _run_retention_sweep()
    janitor = asyncio.create_task(_janitor_loop())
    try:
        yield
    finally:
        janitor.cancel()
        try:
            await janitor
        except asyncio.CancelledError:
            pass
        LOGGER.info("%s shutting down", APP_NAME)


app = FastAPI(
    title=f"{APP_NAME} API",
    description=APP_TAGLINE,
    version="1.0.0",
    lifespan=lifespan,
)
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))


@app.exception_handler(AudioProcessingError)
async def audio_error_handler(request: Request, exc: AudioProcessingError) -> JSONResponse:
    """Log the technical detail, return only the browser-safe message."""
    LOGGER.error("%s %s -> %s | %s", request.method, request.url.path, exc.user_message, exc.detail)
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.user_message})


# --------------------------------------------------------------------------- #
# Upload helpers
# --------------------------------------------------------------------------- #


def _validate_filename(filename: Optional[str]) -> str:
    """Validate the client-supplied extension and return it lower-cased.

    Only the extension is trusted from the client, and only to choose a decoder
    hint; the stored filename is always a server-generated UUID. ffprobe is the
    real gatekeeper for content.
    """
    if not filename or not filename.strip():
        raise HTTPException(status_code=400, detail="No file was selected.")
    suffix = Path(filename).suffix.lower()
    if suffix not in SUPPORTED_EXTENSIONS:
        allowed = ", ".join(SUPPORTED_EXTENSIONS)
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '{suffix or 'unknown'}'. Allowed: {allowed}.",
        )
    return suffix


async def _persist_upload(upload: UploadFile, destination: Path) -> int:
    """Stream *upload* to *destination*, aborting past the size ceiling.

    Streaming (rather than ``await upload.read()``) keeps peak memory at one
    chunk and means a client that under-reports ``Content-Length`` still cannot
    exceed the limit.
    """
    destination.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    try:
        with destination.open("wb") as sink:
            while True:
                chunk = await upload.read(UPLOAD_CHUNK_BYTES)
                if not chunk:
                    break
                written += len(chunk)
                if written > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail=f"File is larger than the {MAX_UPLOAD_MB:.0f} MB limit.",
                    )
                sink.write(chunk)
    except HTTPException:
        destination.unlink(missing_ok=True)
        raise
    except OSError as exc:
        destination.unlink(missing_ok=True)
        LOGGER.exception("failed to persist upload")
        raise HTTPException(status_code=500, detail="Could not save the upload.") from exc

    if written == 0:
        destination.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")
    return written


def _safe_download_stem(original_name: str) -> str:
    """Derive a filesystem- and header-safe stem from a user-supplied filename.

    The upload's name is attacker-controlled and ends up in a
    ``Content-Disposition`` header, where a bare quote would inject a second
    ``filename=`` parameter. Restricting it to a conservative character set
    removes that class of bug entirely (and keeps the name readable).
    """
    stem = Path(original_name or "").stem
    cleaned = re.sub(r"[^A-Za-z0-9._ -]+", "_", stem).strip(" ._-")
    return cleaned[:80] or "audio"


def _parse_job_id(job_id: str) -> str:
    """Reject anything that is not a UUID, which rules out path traversal."""
    try:
        return str(uuid.UUID(job_id))
    except (ValueError, AttributeError, TypeError) as exc:
        raise HTTPException(status_code=404, detail="Unknown job.") from exc


async def _locate(job_id: str, kind: str) -> Path:
    """Resolve the on-disk path for a job's ``original`` or ``cleaned`` file.

    Checks the in-memory registry first, then falls back to a UUID-prefixed
    disk lookup so links keep working across a process restart.
    """
    safe_id = _parse_job_id(job_id)
    record = await JOB_STORE.get(safe_id)
    if record:
        path = record.original_path if kind == "original" else record.cleaned_path
        if path.is_file():
            return path

    directory = UPLOAD_DIR if kind == "original" else OUTPUT_DIR
    matches = sorted(directory.glob(f"{safe_id}*")) if directory.is_dir() else []
    for candidate in matches:
        if candidate.is_file():
            return candidate

    raise HTTPException(status_code=404, detail="That file has expired or never existed.")


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #


@app.get("/")
async def dashboard(request: Request):
    """Render the single-page dashboard."""
    engine = PIPELINE.engine_status()
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={
            "app_name": APP_NAME,
            "tagline": APP_TAGLINE,
            "max_upload_mb": int(MAX_UPLOAD_MB),
            "accepted_extensions": list(SUPPORTED_EXTENSIONS),
            "accept_attribute": ",".join(SUPPORTED_EXTENSIONS),
            "retention_minutes": int(RETENTION_MINUTES),
            "engine_ready": engine["available"],
            "engine_name": engine["name"] or "unavailable",
            "competitor_baselines": COMPETITOR_BASELINES,
            "matrix_notes": MATRIX_NOTES,
        },
    )


@app.get("/healthz")
async def healthz() -> Dict[str, Any]:
    """Liveness probe that also surfaces engine and queue state."""
    engine = PIPELINE.engine_status()
    return {
        "status": "ok" if engine["available"] else "degraded",
        "engine": engine,
        "limits": {
            "max_upload_mb": MAX_UPLOAD_MB,
            "max_concurrent_jobs": MAX_CONCURRENT_JOBS,
            "retention_minutes": RETENTION_MINUTES,
            "accepted_extensions": list(SUPPORTED_EXTENSIONS),
        },
    }


@app.post("/upload")
async def upload(
    background_tasks: BackgroundTasks,
    request: Request,
    file: UploadFile = File(..., description="Audio file: .wav, .mp3 or .m4a"),
) -> JSONResponse:
    """Accept an audio file, de-reverb it, and return results + benchmarks.

    The response is returned only once processing has finished, which lets the
    browser show a determinate upload progress bar followed by rotating
    "analysing acoustics..." status copy while it awaits the JSON body.
    """
    # Fast rejection before reading the body at all.
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_UPLOAD_BYTES * 1.05:
        raise HTTPException(
            status_code=413,
            detail=f"File is larger than the {MAX_UPLOAD_MB:.0f} MB limit.",
        )

    suffix = _validate_filename(file.filename)
    job_id = str(uuid.uuid4())
    stored_upload = UPLOAD_DIR / f"{job_id}_original{suffix}"

    request_started = time.perf_counter()
    try:
        size_bytes = await _persist_upload(file, stored_upload)
        LOGGER.info(
            "job=%s received name=%r bytes=%d (%.2f MB)",
            job_id,
            file.filename,
            size_bytes,
            size_bytes / (1024 * 1024),
        )
        upload_seconds = time.perf_counter() - request_started

        queue_started = time.perf_counter()
        async with JOB_SEMAPHORE:
            queue_seconds = time.perf_counter() - queue_started
            if queue_seconds > 0.25:
                LOGGER.info("job=%s queued for %.2fs", job_id, queue_seconds)
            result = await asyncio.to_thread(
                PIPELINE.process, stored_upload, job_id=job_id, work_dir=OUTPUT_DIR
            )
    except (HTTPException, AudioProcessingError):
        stored_upload.unlink(missing_ok=True)
        raise
    except Exception as exc:  # pragma: no cover - last-resort safety net
        stored_upload.unlink(missing_ok=True)
        LOGGER.exception("job=%s unexpected failure", job_id)
        raise HTTPException(
            status_code=500, detail="Processing failed unexpectedly. Please try again."
        ) from exc
    finally:
        await file.close()

    payload: Dict[str, Any] = result.as_dict()
    payload["original"]["filename"] = file.filename
    payload["original"]["url"] = f"/audio/{job_id}/original"
    payload["cleaned"]["url"] = f"/audio/{job_id}/cleaned"
    payload["cleaned"]["download_url"] = f"/download/{job_id}"
    payload["timings"] = {
        "upload_seconds": round(upload_seconds, 3),
        "queue_seconds": round(queue_seconds, 3),
        "request_seconds": round(time.perf_counter() - request_started, 3),
    }
    payload["matrix"] = build_comparison_matrix(result.original, result.benchmark)
    payload["retention_minutes"] = int(RETENTION_MINUTES)

    await JOB_STORE.put(
        JobRecord(
            job_id=job_id,
            original_name=file.filename or f"{job_id}{suffix}",
            original_path=stored_upload,
            cleaned_path=result.cleaned.path,
            created_at=time.time(),
            payload=payload,
        )
    )
    # Housekeeping runs after the response is flushed, never on the hot path.
    background_tasks.add_task(_run_retention_sweep)
    return JSONResponse(content=payload)


@app.get("/jobs/{job_id}")
async def job_details(job_id: str) -> Dict[str, Any]:
    """Return the stored payload for a job (handy for the API and for polling)."""
    record = await JOB_STORE.get(_parse_job_id(job_id))
    if not record:
        raise HTTPException(status_code=404, detail="That job has expired or never existed.")
    return record.payload


@app.get("/audio/{job_id}/{kind}")
async def stream_audio(job_id: str, kind: str) -> FileResponse:
    """Serve the original or cleaned audio for inline ``<audio>`` playback."""
    if kind not in {"original", "cleaned"}:
        raise HTTPException(status_code=404, detail="Unknown audio variant.")
    path = await _locate(job_id, kind)
    return FileResponse(path, filename=path.name, headers={"Cache-Control": "private, max-age=600"})


@app.get("/download/{job_id}")
async def download_cleaned(job_id: str) -> FileResponse:
    """Download the cleaned file, named after the user's original upload."""
    path = await _locate(job_id, "cleaned")
    record = await JOB_STORE.get(_parse_job_id(job_id))
    stem = _safe_download_stem(record.original_name) if record else "audio"
    # `filename=` lets Starlette build (and correctly quote) Content-Disposition;
    # setting that header by hand is what allowed injection.
    return FileResponse(
        path,
        media_type="audio/wav",
        filename=f"{stem}_dereverbed.wav",
    )


if __name__ == "__main__":  # pragma: no cover - convenience runner
    import uvicorn

    uvicorn.run(
        "main:app",
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "8000")),
        reload=os.getenv("DEREVERB_RELOAD", "0") == "1",
    )
