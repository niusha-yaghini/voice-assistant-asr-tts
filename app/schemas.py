"""Pydantic request/response models."""

from typing import Literal

from pydantic import BaseModel, Field

# Upper bound for one stored turn; answers are ~120 tokens, so this is generous.
MAX_HISTORY_MESSAGE_CHARS = 2000


class HealthResponse(BaseModel):
    """Response of GET /health."""

    status: str
    models_loaded: bool


class TranscribeResponse(BaseModel):
    """Response of POST /api/transcribe."""

    text: str


class ChatMessage(BaseModel):
    """One previous turn of the conversation, kept by the browser."""

    # Only user/assistant: clients must not be able to inject a "system" message.
    role: Literal["user", "assistant"]
    content: str = Field(max_length=MAX_HISTORY_MESSAGE_CHARS)


class ChatRequest(BaseModel):
    """Request body of POST /api/chat.

    ``history`` holds the earlier turns (oldest first) so follow-up questions
    such as "Is it beautiful there?" can be resolved. It is optional.
    """

    text: str
    history: list[ChatMessage] = Field(default_factory=list)


class TTSRequest(BaseModel):
    """Request body of POST /api/tts."""

    text: str


class ChatResponse(BaseModel):
    """Response of POST /api/chat."""

    answer: str
