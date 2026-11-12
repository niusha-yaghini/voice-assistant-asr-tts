"""Pydantic request/response models."""

from pydantic import BaseModel


class HealthResponse(BaseModel):
    """Response of GET /health."""

    status: str
    models_loaded: bool


class TranscribeResponse(BaseModel):
    """Response of POST /api/transcribe."""

    text: str
