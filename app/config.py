"""Application settings, read from environment variables (or a .env file)."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration with sensible defaults for CPU-only inference."""

    model_config = SettingsConfigDict(env_file=".env", env_prefix="VA_", extra="ignore")

    # ASR (faster-whisper)
    whisper_model: str = "base.en"
    whisper_device: str = "cpu"
    whisper_compute_type: str = "int8"

    # LLM (transformers)
    llm_model: str = "Qwen/Qwen2.5-0.5B-Instruct"
    llm_system_prompt: str = "You are a helpful assistant. Answer in 1-3 short sentences."
    llm_max_new_tokens: int = 120

    # TTS (Piper)
    piper_voice: str = "en_US-lessac-medium"
    piper_model_dir: str = "models/piper"

    # Validation limits
    max_audio_bytes: int = 10 * 1024 * 1024
    max_text_chars: int = 500


@lru_cache
def get_settings() -> Settings:
    """Return a cached Settings instance (built once per process)."""
    return Settings()
