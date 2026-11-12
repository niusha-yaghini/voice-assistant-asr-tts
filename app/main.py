"""FastAPI application: lifespan (model loading) and routes."""

import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.config import get_settings
from app.schemas import HealthResponse

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

    started = time.perf_counter()
    # Models are added here in the next steps (ASR, LLM, TTS).
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
