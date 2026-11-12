Build a simple, clean, portfolio-quality voice assistant web app in this repository.
It must use only open-source models running locally (no API keys, no paid services).

## Goal
The user speaks one English sentence in the browser. The app:
1. Transcribes it to text (ASR) and shows the transcript.
2. Generates a short text answer with a small local LLM and shows it.
3. When the user clicks a "Play answer" button, converts the answer to speech (TTS) and plays it.

## Stack (keep exactly this, do not over-engineer)
- Backend: Python 3.11, FastAPI, Uvicorn.
- ASR: faster-whisper, model "base.en", device="cpu", compute_type="int8".
- Answer generation: Hugging Face transformers with "Qwen/Qwen2.5-0.5B-Instruct" on CPU.
  Use the chat template, a short system prompt ("You are a helpful assistant. Answer in 1-3 short sentences."),
  max_new_tokens around 120. Install the CPU-only build of torch
  (pip install torch --index-url https://download.pytorch.org/whl/cpu) and document this in the README.
- TTS: piper-tts with the voice "en_US-lessac-medium" (.onnx + .onnx.json).
  Check the installed piper-tts version and use its current Python API correctly.
- Frontend: one HTML page + one vanilla JS file + one CSS file. No frameworks, no build step.
  Record audio with the MediaRecorder API.
- No database, no authentication, no Docker.

## Project structure
voice-assistant-asr-tts/
├── app/
│   ├── __init__.py
│   ├── main.py          # FastAPI app, lifespan that loads all models once at startup, routes
│   ├── config.py        # settings read from environment variables with sensible defaults
│   ├── asr.py           # Transcriber class wrapping faster-whisper
│   ├── llm.py           # Responder class wrapping the Qwen model
│   ├── tts.py           # Synthesizer class wrapping Piper, returns WAV bytes
│   ├── schemas.py       # Pydantic request/response models
│   ├── templates/index.html
│   └── static/app.js, static/style.css
├── scripts/download_voice.py   # downloads the Piper voice from the Hugging Face repo
│                               # "rhasspy/piper-voices" (path en/en_US/lessac/medium/) into models/piper/
├── tests/test_api.py           # minimal pytest: /health returns ok, /api/chat rejects empty text
├── requirements.txt
├── .env.example
├── .gitignore                  # include .venv/, models/, __pycache__/, .env, *.wav
└── README.md

## API
- GET  /                -> serves the HTML page
- GET  /health          -> {"status": "ok", "models_loaded": true}
- POST /api/transcribe  -> multipart upload field "audio" (browser webm/ogg/wav). Returns {"text": "..."}
- POST /api/chat        -> JSON {"text": "..."}. Returns {"answer": "..."}
- POST /api/tts         -> JSON {"text": "..."}. Returns audio/wav bytes

Rules:
- Load every model once at startup in the lifespan handler, never per request. Log loading time for each model.
- Model inference is blocking: define these endpoints with plain `def` (not `async def`)
  so FastAPI runs them in its threadpool.
- Validation: reject empty audio, audio larger than 10 MB, empty text, and text longer than 500 characters,
  with clear 400 errors. Return 500 with a readable message if inference fails, and log the exception.
- Never write uploaded audio to disk if not needed; use in-memory buffers or a temp file that is always cleaned up.

## Frontend behaviour
- A "Hold to talk" or "Start / Stop recording" button, with a visible recording indicator.
- After stopping: show "Transcribing...", then the transcript, then "Thinking...", then the answer.
- A "Play answer" button that appears only after an answer exists; it calls /api/tts and plays the audio.
- Show errors to the user in a simple message box (e.g. microphone permission denied).
- Clean, minimal, responsive design. Readable on mobile.

## README
Include: short description, architecture diagram (Mermaid: Browser -> FastAPI -> ASR / LLM / TTS),
why each model was chosen (size, CPU speed, open-source), setup steps for Windows PowerShell and Linux,
how to download the voice, how to run (uvicorn app.main:app --reload), the note that models are
downloaded from Hugging Face on first run, known limitations (English only, CPU latency, small LLM quality),
and possible next steps (streaming, Persian ASR/TTS, Docker).

## How to work
- Work step by step: 1) project skeleton + /health, 2) ASR, 3) LLM, 4) TTS, 5) frontend, 6) README + tests.
- After each step, tell me the exact command to run and what I should see, and wait for my confirmation
  before moving on.
- For each step, briefly explain the key concept behind it (e.g. why models load in lifespan,
  how MediaRecorder works, what int8 quantization does) because I am preparing for an AI engineering interview.
- Code must be complete and runnable: type hints, short docstrings, logging, no TODOs or placeholders.
- Pin package versions in requirements.txt only after confirming they install together.