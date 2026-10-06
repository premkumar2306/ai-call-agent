"""
job_store.py
============

Durable, device-scoped job history for the EchoStrip mobile app.

The web dashboard was happy with in-memory job state: a tab holds one result
and forgets it on reload. The mobile app's **History** tab is different - it
promises "re-open, compare, and re-export anything you've run" - so job records
have to outlive both the request and the server process.

Design notes
------------
* **SQLite via the stdlib.** No extra dependency, no server to run, and it is
  more than fast enough for per-device history. WAL mode keeps concurrent
  readers from blocking the writer.
* **A connection per operation.** SQLite connections are not safe to share
  across threads, and the API layer calls these helpers from a worker thread
  pool. Opening per call sidesteps the problem entirely and costs microseconds.
* **Device id is optional.** The web dashboard has no device identity, so its
  uploads are stored with ``device_id = NULL``: still recorded for operations,
  never listable by any device's History.
* **Rows outlive files.** Audio artefacts are deleted on the retention schedule,
  but the history row survives so the app can still show "Zoom Call - Sept 12,
  2:22, Done" long after the audio is gone. :meth:`JobStore.list_for_device`
  reports ``files_available`` so the UI knows whether playback is still possible.
* **Failures are history too.** The reference app shows ``Failed`` entries, so a
  job that blows up is recorded rather than silently dropped.

Device identity is an opaque UUID the app generates on first launch and sends
as ``X-Device-Id``. There are no accounts and no personal data: a device id is
the only key, and it never leaves the client except as this header.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

LOGGER = logging.getLogger("dereverb.jobs")

#: Job lifecycle states mirrored by the mobile History tab.
STATUS_DONE = "done"
STATUS_FAILED = "failed"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    job_id           TEXT PRIMARY KEY,
    device_id        TEXT,
    created_at       REAL NOT NULL,
    status           TEXT NOT NULL,
    original_name    TEXT NOT NULL,
    original_path    TEXT,
    cleaned_path     TEXT,
    duration_seconds REAL,
    size_bytes       INTEGER,
    engine           TEXT,
    error            TEXT,
    payload          TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_device_created
    ON jobs (device_id, created_at DESC);
"""


def normalise_device_id(raw: Optional[str]) -> Optional[str]:
    """Return *raw* as a canonical UUID string, or ``None`` if it is not one.

    Device ids are used as a database key and must never reach the filesystem,
    but validating them anyway keeps junk out of the table and makes the
    ``X-Device-Id`` contract explicit and testable.
    """
    if not raw:
        return None
    try:
        return str(uuid.UUID(str(raw).strip()))
    except (ValueError, AttributeError, TypeError):
        return None


@dataclass
class JobRow:
    """One history entry, as the API serialises it for the app."""

    job_id: str
    device_id: Optional[str]
    created_at: float
    status: str
    original_name: str
    original_path: Optional[str]
    cleaned_path: Optional[str]
    duration_seconds: Optional[float]
    size_bytes: Optional[int]
    engine: Optional[str]
    error: Optional[str]
    payload: Optional[Dict[str, Any]]

    @property
    def files_available(self) -> bool:
        """True when both artefacts are still on disk (i.e. replayable)."""
        if self.status != STATUS_DONE or not self.cleaned_path:
            return False
        cleaned = Path(self.cleaned_path)
        original = Path(self.original_path) if self.original_path else None
        return cleaned.is_file() and bool(original and original.is_file())

    def summary(self) -> Dict[str, Any]:
        """Compact representation for the History list."""
        return {
            "job_id": self.job_id,
            "created_at": self.created_at,
            "status": self.status,
            "original_name": self.original_name,
            "duration_seconds": self.duration_seconds,
            "size_bytes": self.size_bytes,
            "engine": self.engine,
            "error": self.error,
            "files_available": self.files_available,
            "urls": {
                "original": f"/audio/{self.job_id}/original",
                "cleaned": f"/audio/{self.job_id}/cleaned",
                "download": f"/download/{self.job_id}",
            },
        }

    def detail(self) -> Dict[str, Any]:
        """Full record, including the original upload payload when present."""
        data = self.summary()
        data["payload"] = self.payload
        return data


class JobStore:
    """SQLite-backed job history, keyed by device id."""

    def __init__(self, db_path: Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialise()

    # -- connection plumbing ------------------------------------------------ #

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=10.0)
        conn.row_factory = sqlite3.Row
        # WAL lets the History tab read while an upload is being recorded.
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        return conn

    def _initialise(self) -> None:
        with self._connect() as conn:
            conn.executescript(_SCHEMA)
        LOGGER.info("job history database ready at %s", self.db_path)

    @staticmethod
    def _to_row(record: sqlite3.Row) -> JobRow:
        payload_raw = record["payload"]
        payload: Optional[Dict[str, Any]] = None
        if payload_raw:
            try:
                payload = json.loads(payload_raw)
            except json.JSONDecodeError:  # pragma: no cover - defensive
                LOGGER.warning("job=%s has unreadable payload json", record["job_id"])
        return JobRow(
            job_id=record["job_id"],
            device_id=record["device_id"],
            created_at=record["created_at"],
            status=record["status"],
            original_name=record["original_name"],
            original_path=record["original_path"],
            cleaned_path=record["cleaned_path"],
            duration_seconds=record["duration_seconds"],
            size_bytes=record["size_bytes"],
            engine=record["engine"],
            error=record["error"],
            payload=payload,
        )

    # -- writes ------------------------------------------------------------- #

    def record_success(
        self,
        *,
        job_id: str,
        device_id: Optional[str],
        original_name: str,
        original_path: Path,
        cleaned_path: Path,
        duration_seconds: float,
        size_bytes: int,
        engine: str,
        payload: Dict[str, Any],
    ) -> None:
        """Persist a completed job so it shows up in History as ``Done``."""
        with self._connect() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO jobs (
                    job_id, device_id, created_at, status, original_name,
                    original_path, cleaned_path, duration_seconds, size_bytes,
                    engine, error, payload
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
                """,
                (
                    job_id,
                    device_id,
                    time.time(),
                    STATUS_DONE,
                    original_name,
                    str(original_path),
                    str(cleaned_path),
                    duration_seconds,
                    size_bytes,
                    engine,
                    json.dumps(payload),
                ),
            )
        LOGGER.info("job=%s recorded status=done device=%s", job_id, device_id)

    def record_failure(
        self,
        *,
        job_id: str,
        device_id: Optional[str],
        original_name: str,
        error: str,
        size_bytes: Optional[int] = None,
    ) -> None:
        """Persist a failed job so History can show it as ``Failed``.

        *error* must already be the browser-safe message; raw stderr never
        reaches this table because the app renders the value verbatim.
        """
        with self._connect() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO jobs (
                    job_id, device_id, created_at, status, original_name,
                    original_path, cleaned_path, duration_seconds, size_bytes,
                    engine, error, payload
                ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, ?, NULL)
                """,
                (
                    job_id,
                    device_id,
                    time.time(),
                    STATUS_FAILED,
                    original_name,
                    size_bytes,
                    error,
                ),
            )
        LOGGER.info("job=%s recorded status=failed device=%s", job_id, device_id)

    def delete(self, *, job_id: str, device_id: str) -> Optional[JobRow]:
        """Delete one job **belonging to this device** and return what it was.

        Returns ``None`` when the job does not exist or belongs to someone
        else, so the caller can answer 404 without leaking the difference.
        """
        row = self.get(job_id=job_id, device_id=device_id)
        if row is None:
            return None
        with self._connect() as conn:
            conn.execute(
                "DELETE FROM jobs WHERE job_id = ? AND device_id = ?", (job_id, device_id)
            )
        LOGGER.info("job=%s deleted by device=%s", job_id, device_id)
        return row

    def forget_missing_files(self) -> int:
        """Clear path columns whose files the retention sweep has removed.

        Keeps ``files_available`` honest without stat-ing every row on read.
        """
        cleared = 0
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT job_id, original_path, cleaned_path FROM jobs "
                "WHERE original_path IS NOT NULL OR cleaned_path IS NOT NULL"
            ).fetchall()
            for record in rows:
                original = record["original_path"]
                cleaned = record["cleaned_path"]
                gone_original = bool(original) and not Path(original).is_file()
                gone_cleaned = bool(cleaned) and not Path(cleaned).is_file()
                if gone_original or gone_cleaned:
                    conn.execute(
                        "UPDATE jobs SET original_path = NULL, cleaned_path = NULL "
                        "WHERE job_id = ?",
                        (record["job_id"],),
                    )
                    cleared += 1
        if cleared:
            LOGGER.info("history: cleared paths for %d expired job(s)", cleared)
        return cleared

    # -- reads -------------------------------------------------------------- #

    def get(self, *, job_id: str, device_id: Optional[str] = None) -> Optional[JobRow]:
        """Fetch one job, optionally constrained to a single device."""
        query = "SELECT * FROM jobs WHERE job_id = ?"
        params: List[Any] = [job_id]
        if device_id is not None:
            query += " AND device_id = ?"
            params.append(device_id)
        with self._connect() as conn:
            record = conn.execute(query, params).fetchone()
        return self._to_row(record) if record else None

    def list_for_device(self, device_id: str, *, limit: int = 50, offset: int = 0) -> List[JobRow]:
        """Newest-first history page for one device."""
        with self._connect() as conn:
            records = conn.execute(
                "SELECT * FROM jobs WHERE device_id = ? "
                "ORDER BY created_at DESC LIMIT ? OFFSET ?",
                (device_id, max(1, min(limit, 200)), max(0, offset)),
            ).fetchall()
        return [self._to_row(record) for record in records]

    def count_for_device(self, device_id: str) -> int:
        """Total history entries for a device (for pagination and Settings)."""
        with self._connect() as conn:
            return int(
                conn.execute(
                    "SELECT COUNT(*) FROM jobs WHERE device_id = ?", (device_id,)
                ).fetchone()[0]
            )

    def purge_device(self, device_id: str) -> int:
        """Delete every record for a device. Backs 'Clear history' in Settings."""
        with self._connect() as conn:
            cursor = conn.execute("DELETE FROM jobs WHERE device_id = ?", (device_id,))
            removed = cursor.rowcount or 0
        LOGGER.info("history: purged %d record(s) for device=%s", removed, device_id)
        return removed
