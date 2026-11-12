"""Pydantic request/response models."""

from pydantic import BaseModel


class HealthResponse(BaseModel):
    """Response of GET /health."""

    status: str
    models_loaded: bool


class TranscribeResponse(BaseModel):
    """Response of POST /api/transcribe."""

    text: str


class ChatRequest(BaseModel):
    """Request body of POST /api/chat."""

    text: str


class ChatResponse(BaseModel):
    """Response of POST /api/chat."""

    answer: str
