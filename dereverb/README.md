# EchoStrip — AI Audio De-reverberation (Echo Removal)

A production-ready MVP micro-SaaS: drop in a reverberant recording, get a clean,
echo-free file back in one click — plus a **Competitor Comparison Matrix** that
benchmarks your file's real processing numbers against the legacy desktop tools.

```
dereverb/
├── main.py              FastAPI app: routing, upload limits, benchmarks, matrix, cleanup
├── audio_processor.py   DeepFilterNet pipeline: decode → enhance → (tail gate) → encode
├── templates/
│   └── index.html       Tailwind dashboard: dropzone, progress, A/B players, matrix
├── requirements.txt     Python dependencies
└── README.md
```

---

## Quick start

```bash
# 1. System dependency (decoding mp3/m4a and normalising to 48 kHz mono)
sudo apt-get install -y ffmpeg

# 2. Python dependencies (pulls torch + torchaudio via deepfilternet — large)
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 3. Run
uvicorn main:app --host 0.0.0.0 --port 8000
#    …or: python main.py
```

Open <http://localhost:8000>.

Check readiness at any time:

```bash
curl -s localhost:8000/healthz | python -m json.tool
```

`"status": "degraded"` means DeepFilterNet is not importable and no `deepFilter`
binary is on `PATH`. The app still boots and the dashboard still renders, but
uploads return **503** with an actionable message instead of silently failing.

---

## How it works

```
upload (.wav/.mp3/.m4a)
   │  streamed to disk under a UUID, hard-capped at 25 MB
   ├─ probe        ffprobe → duration / sample rate / channels   (rejects >15 min)
   ├─ decode       ffmpeg  → 48 kHz mono 16-bit PCM              [timed]
   ├─ enhance      DeepFilterNet 3 strips reverb + noise         [timed]
   ├─ tail gate    optional late-reverb spectral subtraction     [timed, off by default]
   ├─ encode       ffmpeg  → browser-playable 48 kHz mono WAV    [timed]
   └─ JSON response: original + cleaned URLs, benchmarks, comparison matrix
```

Every stage is wall-clock timed with `time.perf_counter()`, so the dashboard's
numbers are measurements, not estimates.

### Engines

`audio_processor.resolve_engine()` auto-detects, in order:

| Engine | Used when | Notes |
|---|---|---|
| `DeepFilterNetPythonEngine` | `import df.enhance` succeeds | Preferred. Weights load **once** and are cached for the process lifetime; inference is serialised with a lock because the DF state object is not thread-safe. |
| `DeepFilterNetCliEngine` | `deepFilter` is on `PATH` | Fallback. Loads weights per invocation, so it is slower. |

Pin one explicitly with `DEREVERB_ENGINE=python` or `DEREVERB_ENGINE=cli`; a
misconfigured deploy then fails loudly at startup rather than silently degrading.

---

## Configuration

All settings are environment variables with production-safe defaults.

| Variable | Default | Purpose |
|---|---|---|
| `DEREVERB_MAX_UPLOAD_MB` | `25` | Upload ceiling, enforced while streaming |
| `DEREVERB_MAX_DURATION_SECONDS` | `900` | Reject very long files before processing |
| `DEREVERB_MAX_CONCURRENT_JOBS` | `2` | Inference slots; extra requests queue |
| `DEREVERB_STORAGE_DIR` | `./storage` | Where uploads/outputs live |
| `DEREVERB_RETENTION_MINUTES` | `60` | Artefacts auto-deleted after this |
| `DEREVERB_JANITOR_INTERVAL` | `300` | Seconds between retention sweeps |
| `DEREVERB_ENGINE` | `auto` | `auto` \| `python` \| `cli` |
| `DEREVERB_WARMUP` | `0` | `1` loads weights at boot, not on first request |
| `DEREVERB_ATTEN_LIMIT_DB` | unset | Cap attenuation in dB (e.g. `24` keeps some room tone) |
| `DEREVERB_TAIL_GATE` | `off` | `on` enables the late-reverb spectral gate |
| `DEREVERB_LOG_LEVEL` | `INFO` | Logging verbosity |

### The optional tail gate

DeepFilterNet removes most reverb on its own. For very live rooms a decay tail
can survive it, so `suppress_late_reverb()` implements classic statistical late-
reverberation suppression: the late tail is estimated as an exponentially
decaying, time-delayed average of past STFT magnitudes, over-subtracted from the
current magnitude, with the original phase retained and a spectral floor to
avoid musical-noise artefacts. It is **off by default** — turn it on per-deploy.

---

## API

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Dashboard |
| `POST` | `/upload` | `multipart/form-data`, field `file`. Returns the full result JSON |
| `GET` | `/jobs/{job_id}` | Stored payload for a job |
| `GET` | `/audio/{job_id}/original` | Original audio for `<audio>` playback |
| `GET` | `/audio/{job_id}/cleaned` | Cleaned audio for `<audio>` playback |
| `GET` | `/download/{job_id}` | Cleaned audio as an attachment |
| `GET` | `/healthz` | Status, engine availability, limits |

```bash
curl -F "file=@room.wav" localhost:8000/upload
```

```jsonc
{
  "job_id": "fc5bc4b1-…",
  "engine": "DeepFilterNet3 (python)",
  "original": { "filename": "room.wav", "size_mb": 0.51, "duration_seconds": 6.03, … },
  "cleaned":  { "size_mb": 0.55, "sample_rate": 48000, "url": "/audio/…/cleaned", … },
  "benchmark": {
    "audio_seconds": 6.034, "decode_seconds": 0.069, "enhance_seconds": 0.075,
    "encode_seconds": 0.071, "total_seconds": 0.317,
    "speed_ratio": 19.03,        // seconds of audio cleaned per second of compute
    "enhance_speed_ratio": 80.45 // model inference alone
  },
  "matrix": { "rows": [ … ], "edge": { … }, "notes": [ … ] }
}
```

Errors return `{"detail": "<message safe to show a user>"}`. The underlying
technical cause (ffmpeg stderr, exception repr) is logged server-side and never
sent to the browser. Status codes: `400` bad/undecodable/oversized-duration
input, `413` over the size limit, `422` missing field, `503` engine unavailable.

---

## Competitor Comparison Matrix — where the numbers come from

**Read this before changing `COMPETITOR_BASELINES` in `main.py`.**

* The **EchoStrip row is measured** live, on this server, for the user's file.
* The **competitor rows are clearly-labelled estimates**. They are *not* live
  benchmarks of competitor software. Each baseline models that product's
  published workflow — an offline desktop render (iZotope RX) versus a
  realtime-capable DAW plugin (Waves Clarity Vx DeVerb) — and is projected onto
  the user's actual audio length so every figure in the table refers to their
  file. Pricing moves with vendor promotions.

The UI renders a `MEASURED` / `ESTIMATE` badge per row and repeats these caveats
as footnotes under the table. **Keep that disclosure if you edit the data** —
presenting modelled figures as measured competitor benchmarks would be a false
advertising claim.

The matrix highlights two genuine structural advantages that do not depend on
the estimates: **cloud delivery with nothing to install**, and a **zero-slider,
1-click workflow** against the 2–4+ controls a legacy suite asks you to audition
per file. `edge.round_trip_saved` combines machine time with hands-on human time.

---

## Safety & operational notes

* **Size limit** enforced *while streaming* — a client that under-reports
  `Content-Length` still cannot exceed it. A fast header check rejects obvious
  over-limit uploads before the body is read.
* **UUID filenames** for every artefact, so concurrent uploads of identically
  named files cannot collide or overwrite each other.
* **Path traversal is structurally impossible**: every `job_id` is parsed with
  `uuid.UUID()` before touching the filesystem, and the audio variant is
  matched against an allow-list.
* **Bounded concurrency** via a semaphore; CPU-bound work runs on a worker
  thread (`asyncio.to_thread`) so the event loop stays responsive.
* **Automatic retention sweeps** delete artefacts (and orphaned scratch dirs)
  past the retention window, on a timer and after each upload.
* **Intermediates are always cleaned up**, including when a job fails.
* **Logging**: every stage logs `job=<uuid> stage=… elapsed=…`, so a failed
  conversion can be traced to the exact stage and its ffmpeg stderr.

## Frontend notes

Tailwind is loaded from the CDN as specified. The `.hidden` utility is *also*
declared in an inline `<style>` block on purpose: the dashboard's three states
(upload / processing / result) are toggled with that class, and if the CDN were
blocked or slow, every state would otherwise render stacked at once.
