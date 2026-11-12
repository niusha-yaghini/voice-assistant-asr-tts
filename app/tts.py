"""Text-to-speech using Piper (piper-tts 1.8 API)."""

import io
import logging
import wave
from pathlib import Path

from piper import PiperVoice

logger = logging.getLogger(__name__)


class Synthesizer:
    """Wraps a Piper ONNX voice loaded once and reused for every request."""

    def __init__(self, model_dir: str | Path, voice: str) -> None:
        """Load ``<model_dir>/<voice>.onnx`` and its ``.onnx.json`` config.

        Raises FileNotFoundError with setup instructions if the voice is missing.
        """
        model_path = Path(model_dir) / f"{voice}.onnx"
        config_path = model_path.with_name(model_path.name + ".json")
        missing = [p for p in (model_path, config_path) if not p.is_file()]
        if missing:
            raise FileNotFoundError(
                f"Piper voice files not found: {', '.join(str(p) for p in missing)}. "
                f"Run: python scripts/download_voice.py --voice {voice}"
            )
        self._voice = PiperVoice.load(model_path, config_path=config_path)
        self.sample_rate: int = self._voice.config.sample_rate

    def warm_up(self) -> None:
        """Run one tiny synthesis so the first real request does not pay ONNX/espeak init cost."""
        self.synthesize("Ready.")

    def synthesize(self, text: str) -> bytes:
        """Convert ``text`` to a complete WAV file (16-bit PCM, mono) in memory.

        Piper yields one audio chunk per sentence; the chunks are written into a
        single WAV container held in a BytesIO buffer, so nothing touches the disk.

        Raises ValueError if the text produces no audio (e.g. only punctuation).
        """
        buffer = io.BytesIO()
        frames = 0
        with wave.open(buffer, "wb") as wav:
            for chunk in self._voice.synthesize(text):
                if frames == 0:
                    # The format comes from the first chunk (same for all chunks of a voice).
                    wav.setnchannels(chunk.sample_channels)
                    wav.setsampwidth(chunk.sample_width)
                    wav.setframerate(chunk.sample_rate)
                pcm = chunk.audio_int16_bytes
                wav.writeframes(pcm)
                frames += len(pcm) // (chunk.sample_width * chunk.sample_channels)
            if frames == 0:
                # Close needs a valid format; set one so the context manager exits cleanly.
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(self.sample_rate)

        if frames == 0:
            raise ValueError("The text contains nothing that can be spoken.")
        logger.info("Synthesized %.1fs of audio for %d chars", frames / self.sample_rate, len(text))
        return buffer.getvalue()
