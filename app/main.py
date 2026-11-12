"""FastAPI application: lifespan (model loading) and routes."""

import io
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path

from av.error import InvalidDataError
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.asr import Transcriber
from app.config import get_settings
from app.schemas import HealthResponse, TranscribeResponse

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("voice_assistant")

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
TEMPLATES_DIR = BASE_DIR / "templates"


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load all models once at startup and release them at shutdown.

    Models are expensive to load (seconds, hundreds of MB), so they live on
    ``app.state`` and are shared by every request instead of being loaded per call.
    """
    app.state.settings = get_settings()
    app.state.models_loaded = False

    cfg = app.state.settings
    started = time.perf_counter()

    t0 = time.perf_counter()
    app.state.transcriber = Transcriber(
        cfg.whisper_model, cfg.whisper_device, cfg.whisper_compute_type
    )
    logger.info("ASR model '%s' loaded in %.2fs", cfg.whisper_model, time.perf_counter() - t0)

    # LLM and TTS are added here in the next steps.
    logger.info("Startup finished in %.2fs", time.perf_counter() - started)
    app.state.models_loaded = True

    yield

    app.state.models_loaded = False
    logger.info("Shutdown complete")


app = FastAPI(title="Local Voice Assistant", lifespan=lifespan)
STATIC_DIR.mkdir(exist_ok=True)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/health", response_model=HealthResponse)
def health(request: Request) -> HealthResponse:
    """Report liveness and whether all models finished loading."""
    return HealthResponse(status="ok", models_loaded=request.app.state.models_loaded)


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    """Serve the single-page frontend (added in step 5)."""
    return FileResponse(TEMPLATES_DIR / "index.html")


@app.post("/api/transcribe", response_model=TranscribeResponse)
def transcribe(request: Request, audio: UploadFile = File(...)) -> TranscribeResponse:
    """Transcribe an uploaded recording. Plain ``def`` so FastAPI uses its threadpool."""
    max_bytes = request.app.state.settings.max_audio_bytes
    data = audio.file.read(max_bytes + 1)  # read one extra byte to detect oversize
    if not data:
        raise HTTPException(status_code=400, detail="Audio file is empty.")
    if len(data) > max_bytes:
        raise HTTPException(
            status_code=400, detail=f"Audio file is larger than {max_bytes // (1024 * 1024)} MB."
        )

    try:
        text = request.app.state.transcriber.transcribe(io.BytesIO(data))
    except InvalidDataError:
        raise HTTPException(status_code=400, detail="Could not decode the audio file.")
    except Exception:
        logger.exception("Transcription failed")
        raise HTTPException(status_code=500, detail="Transcription failed. See server logs.")
    return TranscribeResponse(text=text)
