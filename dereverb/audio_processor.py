"""
audio_processor.py
==================

Audio de-reverberation pipeline for the EchoStrip micro-SaaS.

Responsibilities
----------------
1. Normalise any accepted upload (``.wav`` / ``.mp3`` / ``.m4a``) into the
   48 kHz mono PCM form DeepFilterNet expects, using ``ffmpeg``.
2. Invoke DeepFilterNet to strip room reverb / echo from the normalised file.
   Two interchangeable engines are supported and auto-detected:

   * :class:`DeepFilterNetPythonEngine` - in-process ``df.enhance`` bindings.
     Fastest option because the model is loaded once and cached for the
     lifetime of the process.
   * :class:`DeepFilterNetCliEngine` - shells out to the ``deepFilter``
     console script shipped with the ``deepfilternet`` wheel. Used when the
     Python bindings cannot be imported (e.g. a slim container that only has
     the CLI on ``PATH``).

3. Optionally apply a late-reverberation spectral gate (off by default) that
   removes the reverb *tail* DeepFilterNet leaves behind in very live rooms.
4. Measure the wall-clock duration of every stage so the web layer can render
   the "Competitor Comparison Matrix" from real numbers.

Nothing in this module knows about HTTP; it is deliberately importable and
testable on its own::

    from audio_processor import DereverbPipeline
    pipeline = DereverbPipeline()
    result = pipeline.process(Path("room.wav"), job_id="...", work_dir=Path("/tmp/x"))
    print(result.benchmark.speed_ratio)
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import shutil
import subprocess
import threading
import time
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Protocol, Sequence

import numpy as np

LOGGER = logging.getLogger("dereverb.audio")

# --------------------------------------------------------------------------- #
# Constants / tunables
# --------------------------------------------------------------------------- #

#: DeepFilterNet 3 operates natively at 48 kHz; resampling anything else keeps
#: the model in its trained regime and guarantees a browser-playable output.
TARGET_SAMPLE_RATE = 48_000
TARGET_CHANNELS = 1

#: Extensions the pipeline knows how to decode. Mirrored by the HTTP layer.
SUPPORTED_EXTENSIONS: tuple[str, ...] = (".wav", ".mp3", ".m4a")

#: Hard ceilings so a pathological upload cannot pin a worker forever.
FFMPEG_TIMEOUT_SECONDS = int(os.getenv("DEREVERB_FFMPEG_TIMEOUT", "300"))
ENGINE_TIMEOUT_SECONDS = int(os.getenv("DEREVERB_ENGINE_TIMEOUT", "900"))
MAX_DURATION_SECONDS = float(os.getenv("DEREVERB_MAX_DURATION_SECONDS", "900"))

#: ``auto`` (default) | ``python`` | ``cli`` - lets ops pin a specific engine.
ENGINE_PREFERENCE = os.getenv("DEREVERB_ENGINE", "auto").strip().lower()

#: Upper bound (dB) on how much DeepFilterNet may attenuate. ``None`` = no
#: limit (maximum echo removal). A value such as ``24`` keeps a little room
#: tone, which some voice-over clients prefer.
_ATTEN_LIMIT_RAW = os.getenv("DEREVERB_ATTEN_LIMIT_DB", "").strip()
ATTEN_LIMIT_DB: Optional[float] = float(_ATTEN_LIMIT_RAW) if _ATTEN_LIMIT_RAW else None

#: Opt-in late-reverb tail gate (see :func:`suppress_late_reverb`).
TAIL_GATE_ENABLED = os.getenv("DEREVERB_TAIL_GATE", "off").strip().lower() in {
    "1",
    "on",
    "true",
    "yes",
}


# --------------------------------------------------------------------------- #
# Errors
# --------------------------------------------------------------------------- #


class AudioProcessingError(RuntimeError):
    """Base class for every failure the pipeline can surface.

    Carries two messages on purpose:

    ``user_message``
        Safe to show in the browser.
    ``detail``
        Full technical context (stderr, exception text). Logged server side,
        never rendered verbatim to end users.
    """

    status_code = 500

    def __init__(self, user_message: str, detail: str = "") -> None:
        super().__init__(user_message if not detail else f"{user_message} :: {detail}")
        self.user_message = user_message
        self.detail = detail or user_message


class UnsupportedAudioError(AudioProcessingError):
    """The upload could not be decoded, or is longer than the duration cap."""

    status_code = 400


class EngineUnavailableError(AudioProcessingError):
    """Neither DeepFilterNet engine could be resolved on this host."""

    status_code = 503


# --------------------------------------------------------------------------- #
# Value objects
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class AudioStats:
    """Objective facts about one audio file on disk."""

    path: Path
    size_bytes: int
    duration_seconds: float
    sample_rate: int
    channels: int

    @property
    def size_mb(self) -> float:
        return round(self.size_bytes / (1024 * 1024), 3)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "filename": self.path.name,
            "size_bytes": self.size_bytes,
            "size_mb": self.size_mb,
            "duration_seconds": round(self.duration_seconds, 3),
            "sample_rate": self.sample_rate,
            "channels": self.channels,
        }


@dataclass
class Benchmark:
    """Wall-clock measurements for a single job.

    ``speed_ratio`` is the realtime factor operators actually care about:
    *seconds of audio cleaned per second of compute*. ``12.4`` means the job
    finished 12.4x faster than playing the file back.
    """

    audio_seconds: float
    decode_seconds: float
    enhance_seconds: float
    postprocess_seconds: float
    encode_seconds: float
    total_seconds: float

    @property
    def speed_ratio(self) -> float:
        if self.total_seconds <= 0:
            return 0.0
        return round(self.audio_seconds / self.total_seconds, 2)

    @property
    def enhance_speed_ratio(self) -> float:
        """Realtime factor of the model inference stage alone."""
        if self.enhance_seconds <= 0:
            return 0.0
        return round(self.audio_seconds / self.enhance_seconds, 2)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "audio_seconds": round(self.audio_seconds, 3),
            "decode_seconds": round(self.decode_seconds, 3),
            "enhance_seconds": round(self.enhance_seconds, 3),
            "postprocess_seconds": round(self.postprocess_seconds, 3),
            "encode_seconds": round(self.encode_seconds, 3),
            "total_seconds": round(self.total_seconds, 3),
            "speed_ratio": self.speed_ratio,
            "enhance_speed_ratio": self.enhance_speed_ratio,
        }


@dataclass
class ProcessingResult:
    """Everything the HTTP layer needs after a successful run."""

    job_id: str
    engine: str
    original: AudioStats
    cleaned: AudioStats
    benchmark: Benchmark
    tail_gate_applied: bool = False
    warnings: List[str] = field(default_factory=list)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "job_id": self.job_id,
            "engine": self.engine,
            "original": self.original.as_dict(),
            "cleaned": self.cleaned.as_dict(),
            "benchmark": self.benchmark.as_dict(),
            "tail_gate_applied": self.tail_gate_applied,
            "warnings": list(self.warnings),
        }


class _Stopwatch:
    """Tiny context manager that records a monotonic elapsed time."""

    def __init__(self, label: str) -> None:
        self.label = label
        self.elapsed = 0.0
        self._start = 0.0

    def __enter__(self) -> "_Stopwatch":
        self._start = time.perf_counter()
        return self

    def __exit__(self, *exc_info: Any) -> None:
        self.elapsed = time.perf_counter() - self._start
        LOGGER.info("stage=%s elapsed=%.3fs", self.label, self.elapsed)


# --------------------------------------------------------------------------- #
# ffmpeg / ffprobe helpers
# --------------------------------------------------------------------------- #


def _require_binary(name: str) -> str:
    """Return the absolute path to ``name`` or raise a readable error."""
    resolved = shutil.which(name)
    if not resolved:
        raise AudioProcessingError(
            "This server is missing its audio toolchain. Please contact support.",
            f"`{name}` was not found on PATH. Install ffmpeg (apt install ffmpeg).",
        )
    return resolved


def _run(
    cmd: Sequence[str],
    *,
    timeout: int,
    what: str,
    error_class: type[AudioProcessingError] = AudioProcessingError,
    user_message: Optional[str] = None,
) -> subprocess.CompletedProcess:
    """Run a subprocess, log it, and convert failures into readable errors.

    :param error_class: raised on failure. Pass :class:`UnsupportedAudioError`
        when the likely cause is the user's file (-> HTTP 400) rather than the
        server (-> HTTP 500).
    :param user_message: overrides the browser-safe message.
    """
    LOGGER.debug("exec %s", " ".join(cmd))
    try:
        proc = subprocess.run(
            list(cmd),
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise error_class(
            user_message or f"{what} timed out. Try a shorter file.",
            f"timeout after {timeout}s: {' '.join(cmd)}",
        ) from exc
    except OSError as exc:  # pragma: no cover - defensive
        raise AudioProcessingError(f"{what} could not be started.", str(exc)) from exc

    if proc.returncode != 0:
        stderr = (proc.stderr or "").strip()
        LOGGER.error("%s failed rc=%s stderr=%s", what, proc.returncode, stderr[-2000:])
        raise error_class(
            user_message
            or f"{what} failed. The file may be corrupt or use an unsupported codec.",
            f"rc={proc.returncode} stderr={stderr[-2000:]}",
        )
    return proc


def probe_audio(path: Path, *, user_input: bool = True) -> AudioStats:
    """Read duration / sample rate / channel count from a media file.

    Uses ``ffprobe`` first (handles every accepted container) and falls back to
    the stdlib :mod:`wave` parser so the function still works if ffprobe is
    momentarily unavailable but the file happens to be PCM wav.

    :param user_input: ``True`` when *path* is the customer's upload, so an
        unreadable file is reported as a 400. ``False`` when inspecting a file
        this pipeline produced, where a failure is a server-side bug (500).
    """
    path = Path(path)
    error_class: type[AudioProcessingError] = (
        UnsupportedAudioError if user_input else AudioProcessingError
    )
    unreadable = (
        "We could not read that audio file - it may be corrupt or use an "
        "unsupported codec."
        if user_input
        else "The processed audio could not be verified."
    )
    if not path.is_file():
        raise UnsupportedAudioError("The uploaded file is missing.", f"not a file: {path}")

    size_bytes = path.stat().st_size
    if size_bytes == 0:
        raise UnsupportedAudioError("The uploaded file is empty.", f"0 bytes: {path}")

    ffprobe = shutil.which("ffprobe")
    if ffprobe:
        proc = _run(
            [
                ffprobe,
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=sample_rate,channels:format=duration",
                "-of",
                "json",
                str(path),
            ],
            timeout=60,
            what="Audio inspection",
            error_class=error_class,
            user_message=unreadable,
        )
        try:
            payload = json.loads(proc.stdout or "{}")
        except json.JSONDecodeError as exc:  # pragma: no cover - defensive
            raise error_class(unreadable, f"bad ffprobe json: {exc}") from exc

        streams = payload.get("streams") or []
        if not streams:
            raise error_class(
                "That file does not contain an audio track.",
                f"ffprobe found no audio stream in {path.name}",
            )
        stream = streams[0]
        duration_raw = (payload.get("format") or {}).get("duration")
        try:
            duration = float(duration_raw)
        except (TypeError, ValueError):
            duration = 0.0
        stats = AudioStats(
            path=path,
            size_bytes=size_bytes,
            duration_seconds=duration,
            sample_rate=int(stream.get("sample_rate") or 0),
            channels=int(stream.get("channels") or 0),
        )
    else:  # pragma: no cover - only hit on hosts without ffprobe
        stats = _probe_wav_with_stdlib(path, size_bytes)

    if stats.duration_seconds <= 0:
        # Some VBR mp3s omit container duration; decode-count as a last resort.
        stats = AudioStats(
            path=stats.path,
            size_bytes=stats.size_bytes,
            duration_seconds=_duration_by_decoding(path),
            sample_rate=stats.sample_rate,
            channels=stats.channels,
        )

    if stats.duration_seconds <= 0:
        raise error_class(
            "That file has no playable audio.",
            f"duration resolved to 0 for {path.name}",
        )
    if stats.duration_seconds > MAX_DURATION_SECONDS:
        raise UnsupportedAudioError(
            f"Audio is longer than the {int(MAX_DURATION_SECONDS // 60)}-minute limit "
            f"({stats.duration_seconds / 60:.1f} min). Split it and try again.",
            f"duration={stats.duration_seconds:.1f}s cap={MAX_DURATION_SECONDS}s",
        )
    return stats


def _probe_wav_with_stdlib(path: Path, size_bytes: int) -> AudioStats:
    """Minimal PCM-wav probe used when ffprobe is unavailable."""
    try:
        with wave.open(str(path), "rb") as handle:
            frames = handle.getnframes()
            rate = handle.getframerate() or 1
            return AudioStats(
                path=path,
                size_bytes=size_bytes,
                duration_seconds=frames / float(rate),
                sample_rate=rate,
                channels=handle.getnchannels(),
            )
    except wave.Error as exc:
        raise UnsupportedAudioError(
            "We could not read that audio file. Upload a .wav, .mp3 or .m4a.",
            f"wave parser rejected {path.name}: {exc}",
        ) from exc


def _duration_by_decoding(path: Path) -> float:
    """Measure duration by fully decoding to the null muxer.

    Needed for VBR mp3/m4a files whose container omits a duration field.
    ffmpeg reports the final timestamp it decoded on stderr as
    ``time=HH:MM:SS.ss``; the last such value is the true duration.
    """
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:  # pragma: no cover - defensive
        return 0.0
    try:
        proc = subprocess.run(
            [ffmpeg, "-hide_banner", "-nostdin", "-i", str(path), "-vn", "-f", "null", "-"],
            capture_output=True,
            text=True,
            timeout=FFMPEG_TIMEOUT_SECONDS,
            check=False,
        )
    except (subprocess.TimeoutExpired, OSError) as exc:
        LOGGER.warning("duration decode failed for %s: %s", path.name, exc)
        return 0.0

    stamps = re.findall(r"time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)", proc.stderr or "")
    if not stamps:
        return 0.0
    hours, minutes, seconds = stamps[-1]
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def transcode_to_model_input(src: Path, dest: Path, *, user_input: bool = True) -> None:
    """Decode *src* into 48 kHz mono 16-bit PCM wav at *dest*.

    This single step gives us container independence (mp3/m4a/wav all collapse
    to the same representation) and puts DeepFilterNet in its native format.

    :param user_input: see :func:`probe_audio`. Controls whether a decode
        failure is reported as a client (400) or server (500) error.
    """
    ffmpeg = _require_binary("ffmpeg")
    error_class: type[AudioProcessingError] = (
        UnsupportedAudioError if user_input else AudioProcessingError
    )
    failure_message = (
        "We could not decode that audio file - it may be corrupt or use an "
        "unsupported codec."
        if user_input
        else "The cleaned audio could not be encoded."
    )
    dest.parent.mkdir(parents=True, exist_ok=True)
    _run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
            "-i",
            str(src),
            "-vn",
            "-map_metadata",
            "-1",
            "-ac",
            str(TARGET_CHANNELS),
            "-ar",
            str(TARGET_SAMPLE_RATE),
            "-c:a",
            "pcm_s16le",
            str(dest),
        ],
        timeout=FFMPEG_TIMEOUT_SECONDS,
        what="Audio decoding",
        error_class=error_class,
        user_message=failure_message,
    )
    if not dest.is_file() or dest.stat().st_size == 0:
        raise error_class(
            failure_message,
            f"ffmpeg produced no output for {src.name}",
        )


# --------------------------------------------------------------------------- #
# Wav I/O for the optional numpy post-stage
# --------------------------------------------------------------------------- #


def read_pcm_wav(path: Path) -> tuple[np.ndarray, int]:
    """Read a mono 16-bit PCM wav into float32 samples in ``[-1, 1]``."""
    with wave.open(str(path), "rb") as handle:
        if handle.getsampwidth() != 2:
            raise AudioProcessingError(
                "Internal audio format error.",
                f"expected 16-bit PCM, got {handle.getsampwidth() * 8}-bit",
            )
        channels = handle.getnchannels()
        rate = handle.getframerate()
        raw = handle.readframes(handle.getnframes())

    samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    return samples, rate


def write_pcm_wav(path: Path, samples: np.ndarray, sample_rate: int) -> None:
    """Write float samples back out as mono 16-bit PCM wav."""
    clipped = np.clip(samples, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm.tobytes())


def _stft(samples: np.ndarray, frame_size: int, hop: int) -> tuple[np.ndarray, np.ndarray]:
    """Hann-windowed STFT implemented with numpy only (no scipy dependency)."""
    window = np.hanning(frame_size).astype(np.float32)
    pad = frame_size
    padded = np.concatenate(
        [np.zeros(pad, np.float32), samples.astype(np.float32), np.zeros(pad * 2, np.float32)]
    )
    n_frames = 1 + max(0, (len(padded) - frame_size) // hop)
    frames = np.lib.stride_tricks.as_strided(
        padded,
        shape=(n_frames, frame_size),
        strides=(padded.strides[0] * hop, padded.strides[0]),
        writeable=False,
    )
    spectra = np.fft.rfft(frames * window, axis=1)
    return spectra, window


def _istft(spectra: np.ndarray, window: np.ndarray, hop: int, length: int) -> np.ndarray:
    """Inverse of :func:`_stft` via weighted overlap-add."""
    frame_size = window.size
    out_len = (spectra.shape[0] - 1) * hop + frame_size
    accum = np.zeros(out_len, np.float32)
    norm = np.zeros(out_len, np.float32)
    frames = np.fft.irfft(spectra, n=frame_size, axis=1).astype(np.float32) * window
    for index, frame in enumerate(frames):
        start = index * hop
        accum[start : start + frame_size] += frame
        norm[start : start + frame_size] += window**2
    signal = accum / np.maximum(norm, 1e-8)
    return signal[frame_size : frame_size + length]


def suppress_late_reverb(
    path: Path,
    *,
    strength: float = 1.1,
    decay_ms: float = 110.0,
    floor_db: float = -16.0,
    frame_size: int = 1024,
) -> None:
    """Remove the residual late-reverberation tail from a cleaned wav, in place.

    Implements classic statistical late-reverb suppression: the late tail at
    frame *t* is estimated as an exponentially decaying, time-delayed average of
    past magnitudes, then over-subtracted from the current magnitude while the
    original phase is retained. A spectral floor (``floor_db``) prevents the
    musical-noise artefacts naive subtraction produces.

    Disabled by default (``DEREVERB_TAIL_GATE=off``) because DeepFilterNet
    already removes most reverb; enable it for very live rooms where a tail
    survives the model.

    :param strength: over-subtraction factor; >1 removes more tail.
    :param decay_ms: assumed reverberation decay constant of the room.
    :param floor_db: lowest gain any bin may be pushed to, in dB.
    """
    samples, rate = read_pcm_wav(path)
    if samples.size < frame_size * 4:
        LOGGER.info("tail gate skipped: clip shorter than 4 STFT frames")
        return

    hop = frame_size // 4
    spectra, window = _stft(samples, frame_size, hop)
    magnitude = np.abs(spectra)

    hop_seconds = hop / float(rate)
    # Per-frame decay of the assumed exponential room response.
    alpha = float(math.exp(-hop_seconds / max(decay_ms / 1000.0, 1e-3)))
    delay_frames = max(1, int(round(0.025 / hop_seconds)))  # 25 ms direct-sound guard

    late_estimate = np.zeros_like(magnitude)
    running = np.zeros(magnitude.shape[1], np.float32)
    for frame in range(magnitude.shape[0]):
        source = frame - delay_frames
        observed = magnitude[source] if source >= 0 else np.zeros_like(running)
        running = alpha * running + (1.0 - alpha) * observed
        late_estimate[frame] = running

    floor_gain = float(10.0 ** (floor_db / 20.0))
    cleaned_mag = np.maximum(magnitude - strength * late_estimate, floor_gain * magnitude)
    gain = cleaned_mag / np.maximum(magnitude, 1e-9)
    write_pcm_wav(path, _istft(spectra * gain, window, hop, samples.size), rate)
    LOGGER.info(
        "tail gate applied strength=%.2f decay_ms=%.0f floor_db=%.1f frames=%d",
        strength,
        decay_ms,
        floor_db,
        magnitude.shape[0],
    )


# --------------------------------------------------------------------------- #
# DeepFilterNet engines
# --------------------------------------------------------------------------- #


class DereverbEngine(Protocol):
    """Minimal contract every de-reverberation backend implements."""

    name: str

    def is_available(self) -> bool:
        """True when this engine can run on the current host."""

    def warm_up(self) -> None:
        """Pre-load weights so the first real request is not penalised."""

    def enhance(self, src_wav: Path, dest_wav: Path) -> None:
        """Read 48 kHz mono *src_wav*, write the de-reverbed result to *dest_wav*."""


class DeepFilterNetPythonEngine:
    """In-process DeepFilterNet via the ``df.enhance`` bindings.

    The model and its DF state are loaded exactly once and reused across
    requests. ``_lock`` serialises inference because a single ``DF`` state
    object is not safe to share between threads.
    """

    name = "DeepFilterNet3 (python)"

    def __init__(self, atten_limit_db: Optional[float] = ATTEN_LIMIT_DB) -> None:
        self.atten_limit_db = atten_limit_db
        self._model: Any = None
        self._state: Any = None
        self._api: Dict[str, Any] = {}
        self._lock = threading.Lock()

    def is_available(self) -> bool:
        try:
            import df.enhance  # noqa: F401  (import probe only)
        except Exception as exc:  # pragma: no cover - env dependent
            LOGGER.debug("DeepFilterNet python bindings unavailable: %s", exc)
            return False
        return True

    def _load(self) -> None:
        """Import and initialise DeepFilterNet (idempotent, thread-safe)."""
        if self._model is not None:
            return
        try:
            from df.enhance import enhance, init_df, load_audio, save_audio
        except Exception as exc:
            raise EngineUnavailableError(
                "The de-reverberation engine is not installed on this server.",
                f"import df.enhance failed: {exc!r}. "
                "Install it with `pip install deepfilternet`.",
            ) from exc

        LOGGER.info("loading DeepFilterNet weights (first call only)...")
        started = time.perf_counter()
        try:
            model, state, _ = init_df(config_allow_defaults=True)
        except Exception as exc:
            raise AudioProcessingError(
                "The de-reverberation model failed to load.",
                f"init_df raised {exc!r}",
            ) from exc
        self._model, self._state = model, state
        self._api = {"enhance": enhance, "load_audio": load_audio, "save_audio": save_audio}
        LOGGER.info(
            "DeepFilterNet ready in %.2fs (sr=%d)", time.perf_counter() - started, state.sr()
        )

    def warm_up(self) -> None:
        with self._lock:
            self._load()

    def enhance(self, src_wav: Path, dest_wav: Path) -> None:
        with self._lock:
            self._load()
            load_audio = self._api["load_audio"]
            enhance_fn = self._api["enhance"]
            save_audio = self._api["save_audio"]
            try:
                audio, _ = load_audio(str(src_wav), sr=self._state.sr())
                kwargs = {}
                if self.atten_limit_db is not None:
                    kwargs["atten_lim_db"] = self.atten_limit_db
                enhanced = enhance_fn(self._model, self._state, audio, **kwargs)
                dest_wav.parent.mkdir(parents=True, exist_ok=True)
                save_audio(str(dest_wav), enhanced, self._state.sr())
            except Exception as exc:
                raise AudioProcessingError(
                    "De-reverberation failed while processing your file.",
                    f"df.enhance raised {exc!r}",
                ) from exc

        if not dest_wav.is_file() or dest_wav.stat().st_size == 0:
            raise AudioProcessingError(
                "De-reverberation produced no audio.",
                f"df.enhance wrote nothing to {dest_wav}",
            )


class DeepFilterNetCliEngine:
    """DeepFilterNet via the ``deepFilter`` console script.

    Used when the Python bindings are not importable. The CLI writes
    ``<stem>_DeepFilterNet3.wav`` into an output directory, so we hand it a
    private scratch directory and pick up whatever wav appears there - that
    keeps us independent of the suffix the installed version happens to use.
    """

    name = "DeepFilterNet3 (cli)"

    def __init__(
        self,
        binary: Optional[str] = None,
        atten_limit_db: Optional[float] = ATTEN_LIMIT_DB,
    ) -> None:
        self.binary = binary or os.getenv("DEREVERB_CLI_BINARY", "deepFilter")
        self.atten_limit_db = atten_limit_db

    def _resolve(self) -> Optional[str]:
        return shutil.which(self.binary)

    def is_available(self) -> bool:
        return self._resolve() is not None

    def warm_up(self) -> None:
        """No-op: the CLI loads weights per invocation and cannot be warmed."""
        LOGGER.debug("CLI engine needs no warm-up")

    def enhance(self, src_wav: Path, dest_wav: Path) -> None:
        binary = self._resolve()
        if not binary:
            raise EngineUnavailableError(
                "The de-reverberation engine is not installed on this server.",
                f"`{self.binary}` not found on PATH. Install `pip install deepfilternet`.",
            )

        scratch = dest_wav.parent / f"{dest_wav.stem}__df"
        if scratch.exists():
            shutil.rmtree(scratch, ignore_errors=True)
        scratch.mkdir(parents=True, exist_ok=True)

        cmd = [binary, "--output-dir", str(scratch)]
        if self.atten_limit_db is not None:
            cmd += ["--atten-lim", str(int(self.atten_limit_db))]
        cmd.append(str(src_wav))

        try:
            _run(cmd, timeout=ENGINE_TIMEOUT_SECONDS, what="De-reverberation")
            produced = sorted(scratch.glob("*.wav"))
            if not produced:
                raise AudioProcessingError(
                    "De-reverberation produced no audio.",
                    f"{binary} wrote no wav into {scratch}",
                )
            if len(produced) > 1:
                LOGGER.warning("CLI produced %d wavs, using %s", len(produced), produced[0].name)
            dest_wav.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(produced[0]), str(dest_wav))
        finally:
            shutil.rmtree(scratch, ignore_errors=True)


def resolve_engine(preference: str = ENGINE_PREFERENCE) -> DereverbEngine:
    """Pick a DeepFilterNet engine, honouring ``DEREVERB_ENGINE``.

    ``auto`` prefers the in-process bindings (no per-request model load) and
    falls back to the CLI. Explicit ``python`` / ``cli`` values raise when the
    requested engine is missing, so a misconfigured deploy fails loudly.
    """
    python_engine = DeepFilterNetPythonEngine()
    cli_engine = DeepFilterNetCliEngine()

    if preference == "python":
        if not python_engine.is_available():
            raise EngineUnavailableError(
                "The de-reverberation engine is not installed on this server.",
                "DEREVERB_ENGINE=python but `import df.enhance` failed. "
                "Install it with `pip install -r requirements.txt`.",
            )
        return python_engine
    if preference == "cli":
        if not cli_engine.is_available():
            raise EngineUnavailableError(
                "The de-reverberation engine is not installed on this server.",
                "DEREVERB_ENGINE=cli but `deepFilter` is not on PATH. "
                "Install it with `pip install -r requirements.txt`.",
            )
        return cli_engine

    for candidate in (python_engine, cli_engine):
        if candidate.is_available():
            LOGGER.info("selected de-reverberation engine: %s", candidate.name)
            return candidate

    raise EngineUnavailableError(
        "The de-reverberation engine is not installed on this server.",
        "Neither `df.enhance` nor the `deepFilter` CLI is available. "
        "Install with `pip install -r requirements.txt`.",
    )


# --------------------------------------------------------------------------- #
# Pipeline
# --------------------------------------------------------------------------- #


class DereverbPipeline:
    """Orchestrates decode -> DeepFilterNet -> (optional gate) -> encode.

    The pipeline is synchronous and CPU-bound by design; the FastAPI layer runs
    it on a worker thread so the event loop stays responsive.
    """

    def __init__(
        self,
        engine: Optional[DereverbEngine] = None,
        *,
        tail_gate: bool = TAIL_GATE_ENABLED,
        keep_intermediates: bool = False,
    ) -> None:
        self._engine = engine
        self.tail_gate = tail_gate
        self.keep_intermediates = keep_intermediates

    # -- engine plumbing ---------------------------------------------------- #

    @property
    def engine(self) -> DereverbEngine:
        """Lazily resolve the engine so importing this module never fails."""
        if self._engine is None:
            self._engine = resolve_engine()
        return self._engine

    def engine_status(self) -> Dict[str, Any]:
        """Describe engine availability for ``/healthz`` without raising."""
        try:
            engine = self.engine
        except EngineUnavailableError as exc:
            return {"available": False, "name": None, "detail": exc.detail}
        return {"available": True, "name": engine.name, "detail": ""}

    def warm_up(self) -> None:
        """Load model weights ahead of the first request (best effort)."""
        try:
            self.engine.warm_up()
        except AudioProcessingError as exc:
            LOGGER.warning("engine warm-up skipped: %s", exc.detail)

    # -- main entry point --------------------------------------------------- #

    def process(self, source: Path, *, job_id: str, work_dir: Path) -> ProcessingResult:
        """De-reverberate *source* and return the cleaned file plus timings.

        :param source: the uploaded file, already persisted to disk.
        :param job_id: UUID used for every derived filename.
        :param work_dir: directory the cleaned output is written into.
        :raises AudioProcessingError: with a browser-safe ``user_message``.
        """
        source = Path(source)
        work_dir = Path(work_dir)
        work_dir.mkdir(parents=True, exist_ok=True)

        warnings: List[str] = []
        LOGGER.info("job=%s start source=%s bytes=%d", job_id, source.name, source.stat().st_size)
        total = _Stopwatch(f"job[{job_id}].total")

        with total:
            original_stats = probe_audio(source)
            LOGGER.info(
                "job=%s probe duration=%.2fs sr=%d ch=%d",
                job_id,
                original_stats.duration_seconds,
                original_stats.sample_rate,
                original_stats.channels,
            )

            model_input = work_dir / f"{job_id}__model_input.wav"
            raw_output = work_dir / f"{job_id}__model_output.wav"
            cleaned = work_dir / f"{job_id}_cleaned.wav"

            try:
                # 1. Decode / resample into DeepFilterNet's native format.
                with _Stopwatch(f"job[{job_id}].decode") as decode:
                    transcode_to_model_input(source, model_input)

                # 2. Strip the room: DeepFilterNet inference.
                with _Stopwatch(f"job[{job_id}].enhance") as enhance:
                    self.engine.enhance(model_input, raw_output)

                # 3. Optional late-reverb tail gate on the model output.
                postprocess_elapsed = 0.0
                tail_applied = False
                if self.tail_gate:
                    with _Stopwatch(f"job[{job_id}].tailgate") as gate:
                        try:
                            suppress_late_reverb(raw_output)
                            tail_applied = True
                        except AudioProcessingError as exc:
                            # Never fail a job over an optional enhancement.
                            LOGGER.warning("job=%s tail gate failed: %s", job_id, exc.detail)
                            warnings.append("Reverb-tail gate skipped for this file.")
                    postprocess_elapsed = gate.elapsed

                # 4. Normalise to a predictable, browser-playable wav.
                with _Stopwatch(f"job[{job_id}].encode") as encode:
                    transcode_to_model_input(raw_output, cleaned, user_input=False)
            finally:
                if not self.keep_intermediates:
                    for scratch in (model_input, raw_output):
                        scratch.unlink(missing_ok=True)

            cleaned_stats = probe_audio(cleaned, user_input=False)

        benchmark = Benchmark(
            audio_seconds=original_stats.duration_seconds,
            decode_seconds=decode.elapsed,
            enhance_seconds=enhance.elapsed,
            postprocess_seconds=postprocess_elapsed,
            encode_seconds=encode.elapsed,
            total_seconds=total.elapsed,
        )
        LOGGER.info(
            "job=%s done total=%.2fs audio=%.2fs speed=%.2fx engine=%s",
            job_id,
            benchmark.total_seconds,
            benchmark.audio_seconds,
            benchmark.speed_ratio,
            self.engine.name,
        )

        return ProcessingResult(
            job_id=job_id,
            engine=self.engine.name,
            original=original_stats,
            cleaned=cleaned_stats,
            benchmark=benchmark,
            tail_gate_applied=tail_applied,
            warnings=warnings,
        )
