"""Speech-to-text using faster-whisper."""

import logging
from typing import BinaryIO

from faster_whisper import WhisperModel

logger = logging.getLogger(__name__)


class Transcriber:
    """Wraps a faster-whisper model loaded once and reused for every request."""

    def __init__(self, model_name: str, device: str, compute_type: str) -> None:
        """Load the model (downloads from Hugging Face on first run)."""
        self._model = WhisperModel(model_name, device=device, compute_type=compute_type)

    def transcribe(self, audio: BinaryIO) -> str:
        """Transcribe an audio file-like object (webm/ogg/wav...) to plain text.

        The container is decoded in memory by PyAV and resampled to 16 kHz mono.
        """
        segments, info = self._model.transcribe(
            audio,
            language="en",
            beam_size=1,
            vad_filter=True,
        )
        # `segments` is a lazy generator: the actual decoding happens while iterating.
        text = " ".join(segment.text.strip() for segment in segments).strip()
        logger.info("Transcribed %.1fs of audio -> %d chars", info.duration, len(text))
        return text
