"""Download a Piper voice (.onnx + .onnx.json) from Hugging Face into models/piper/.

Usage:
    python scripts/download_voice.py                       # en_US-lessac-medium
    python scripts/download_voice.py --voice en_GB-alan-medium

Files come from the "rhasspy/piper-voices" repo, e.g.
en/en_US/lessac/medium/en_US-lessac-medium.onnx. Downloads go through
huggingface_hub, so HF_ENDPOINT / HTTPS_PROXY and resumable downloads work.
"""

import argparse
import logging
import shutil
import sys
from pathlib import Path

from huggingface_hub import hf_hub_download

REPO_ID = "rhasspy/piper-voices"
DEFAULT_VOICE = "en_US-lessac-medium"
DEFAULT_OUTPUT_DIR = Path(__file__).resolve().parent.parent / "models" / "piper"

logger = logging.getLogger("download_voice")


def voice_repo_dir(voice: str) -> str:
    """Map a voice name like "en_US-lessac-medium" to its folder "en/en_US/lessac/medium"."""
    try:
        lang_code, name, quality = voice.split("-")
    except ValueError:
        raise ValueError(f"Voice must look like '<lang_code>-<name>-<quality>', got '{voice}'") from None
    lang_family = lang_code.split("_")[0]
    return f"{lang_family}/{lang_code}/{name}/{quality}"


def download_voice(voice: str, output_dir: Path) -> list[Path]:
    """Download the voice model and its config into ``output_dir``; skip files already present."""
    output_dir.mkdir(parents=True, exist_ok=True)
    repo_dir = voice_repo_dir(voice)
    saved: list[Path] = []
    for extension in (".onnx", ".onnx.json"):
        filename = f"{voice}{extension}"
        target = output_dir / filename
        if target.exists() and target.stat().st_size > 0:
            logger.info("Already present: %s", target)
        else:
            logger.info("Downloading %s/%s ...", repo_dir, filename)
            cached = hf_hub_download(repo_id=REPO_ID, filename=f"{repo_dir}/{filename}")
            # Copy to a temporary name first so an interrupted copy never looks complete.
            partial = target.with_name(target.name + ".part")
            shutil.copyfile(cached, partial)
            partial.replace(target)
            logger.info("Saved %s (%.1f MB)", target, target.stat().st_size / 1e6)
        saved.append(target)
    return saved


def main() -> int:
    """Parse arguments and download the requested voice."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--voice", default=DEFAULT_VOICE, help=f"Piper voice name (default: {DEFAULT_VOICE})")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR, help="Where to save the files")
    args = parser.parse_args()

    try:
        download_voice(args.voice, args.output_dir)
    except Exception as exc:  # report a readable message instead of a traceback
        logger.error("Download failed: %s", exc)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
