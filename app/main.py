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
from app.llm import Responder
from app.schemas import (
    ChatMessage,
    ChatRequest,
    ChatResponse,
    HealthResponse,
    TranscribeResponse,
)

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

    t0 = time.perf_counter()
    app.state.responder = Responder(
        cfg.llm_model, cfg.llm_system_prompt, cfg.llm_max_new_tokens
    )
    logger.info("LLM '%s' loaded in %.2fs", cfg.llm_model, time.perf_counter() - t0)

    # TTS is added here in the next step.
    logger.info("Startup finished in %.2fs", time.perf_counter() - started)
    app.state.models_loaded = True

    yield

    app.state.models_loaded = False
    logger.info("Shutdown complete")


app = FastAPI(title="Local Voice Assistant", lifespan=lifespan)
STATIC_DIR.mkdir(exist_ok=True)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.middleware("http")
async def revalidate_frontend(request: Request, call_next):
    """Make browsers revalidate the page and static files so edits show up immediately.

    ``no-cache`` still allows caching, but the browser must check the ETag /
    Last-Modified with the server first (cheap 304 if nothing changed).
    """
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/health", response_model=HealthResponse)
def health(request: Request) -> HealthResponse:
    """Report liveness and whether all models finished loading."""
    return HealthResponse(status="ok", models_loaded=request.app.state.models_loaded)


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    """Serve the single-page frontend."""
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


def recent_history(history: list[ChatMessage], max_messages: int) -> list[dict[str, str]]:
    """Keep only the newest ``max_messages`` non-empty turns, starting with a user turn.

    Truncating bounds the prompt length (CPU latency grows with prompt size).
    A leading assistant message without its question is dropped so the
    conversation passed to the chat template stays well-formed.
    """
    turns = [m for m in history if m.content.strip()]
    turns = turns[-max_messages:] if max_messages > 0 else []
    while turns and turns[0].role != "user":
        turns.pop(0)
    return [{"role": m.role, "content": m.content.strip()} for m in turns]


@app.post("/api/chat", response_model=ChatResponse)
def chat(payload: ChatRequest, request: Request) -> ChatResponse:
    """Generate a short answer for the given text, using earlier turns as context."""
    settings = request.app.state.settings
    text = payload.text.strip()
    max_chars = settings.max_text_chars
    if not text:
        raise HTTPException(status_code=400, detail="Text is empty.")
    if len(text) > max_chars:
        raise HTTPException(status_code=400, detail=f"Text is longer than {max_chars} characters.")

    history = recent_history(payload.history, settings.llm_max_history_messages)
    try:
        answer = request.app.state.responder.answer(text, history)
    except Exception:
        logger.exception("Answer generation failed")
        raise HTTPException(status_code=500, detail="Answer generation failed. See server logs.")
    return ChatResponse(answer=answer)
