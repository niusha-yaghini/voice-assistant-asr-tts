Build a simple, clean, portfolio-quality voice assistant web app in this repository.
It must use only open-source models running locally (no API keys, no paid services).

## Goal
The user speaks one English sentence at a time in the browser. The app:
1. Transcribes it to text (ASR) and shows the transcript.
2. Generates a short text answer with a small local LLM and shows it. Follow-up questions keep the
   context of the current conversation (e.g. "What is the capital of France?" then "Is it beautiful there?").
3. Every answer has its own play button. Clicking it converts that specific answer to speech (TTS) and plays it.

## Stack (keep exactly this, do not over-engineer)
- Backend: Python 3.10 (the project venv uses 3.10.9; 3.11 is not installed and the user chose to keep 3.10),
  FastAPI, Uvicorn.
- ASR: faster-whisper, model "base.en", device="cpu", compute_type="int8".
- Answer generation: Hugging Face transformers with "Qwen/Qwen2.5-0.5B-Instruct" on CPU.
  Use the chat template, a short system prompt ("You are a helpful assistant. Answer in 1-3 short sentences."),
  max_new_tokens around 120, greedy decoding. Install the CPU-only build of torch
  (pip install torch --index-url https://download.pytorch.org/whl/cpu) and document this in the README.
- TTS: piper-tts 1.8.0 (GPL-3.0) with the voice "en_US-lessac-medium" (.onnx + .onnx.json).
  In 1.8 `PiperVoice.synthesize(text)` is a generator of per-sentence `AudioChunk`s (no file argument);
  `Synthesizer` writes the chunks into one in-memory WAV and raises ValueError if no audio is produced.
  The voice is warmed up once at startup (first ONNX run is ~5 s, later ones ~0.2 s).
- Frontend: one HTML page + one vanilla JS file + one CSS file. No frameworks, no build step.
  Record audio with the MediaRecorder API.
- No database, no authentication, no Docker.

## Project structure
voice-assistant-asr-tts/
├── app/
│   ├── __init__.py
│   ├── main.py          # FastAPI app, lifespan that loads all models once at startup, routes,
│   │                    # Cache-Control middleware, recent_history() helper
│   ├── config.py        # pydantic-settings; env vars with prefix VA_ (or .env), sensible defaults
│   ├── asr.py           # Transcriber class wrapping faster-whisper
│   ├── llm.py           # Responder class wrapping the Qwen model; answer(question, history)
│   ├── tts.py           # Synthesizer class wrapping Piper, returns WAV bytes
│   ├── schemas.py       # Pydantic request/response models (incl. ChatMessage)
│   ├── templates/index.html
│   └── static/app.js, static/style.css
├── scripts/download_voice.py   # downloads the Piper voice from the Hugging Face repo
│                               # "rhasspy/piper-voices" (path en/en_US/lessac/medium/) into models/piper/
├── tests/test_api.py           # minimal pytest: /health returns ok, /api/chat rejects empty text
├── docs/screenshots/           # UI screenshots used by the README (added by the user)
├── docs/*.docx, docs/*.pdf     # generated project report (git-ignored)
├── requirements.txt
├── .env.example
├── .gitignore                  # includes .venv/, models/, __pycache__/, .env, *.wav (and more)
└── README.md

## API
- GET  /                -> serves the HTML page
- GET  /health          -> {"status": "ok", "models_loaded": true}
- POST /api/transcribe  -> multipart upload field "audio" (browser webm/ogg/wav). Returns {"text": "..."}
- POST /api/chat        -> JSON {"text": "...", "history": [{"role": "user"|"assistant", "content": "..."}]}.
                           "history" is optional (oldest first). Returns {"answer": "..."}
- POST /api/tts         -> JSON {"text": "..."}. Returns audio/wav bytes

Rules:
- Load every model once at startup in the lifespan handler, never per request. Log loading time for each model.
- Model inference is blocking: define these endpoints with plain `def` (not `async def`)
  so FastAPI runs them in its threadpool.
- Validation: reject empty audio, audio larger than 10 MB, empty text, and text longer than 500 characters,
  with clear 400 errors. Undecodable audio is a 400. Return 500 with a readable message if inference fails,
  and log the exception.
- /api/tts has its own limit VA_MAX_TTS_CHARS (default 1000), because a 120-token answer can exceed
  500 characters. Text that produces no audio (e.g. only punctuation) is a 400.
- Relative paths in settings (e.g. VA_PIPER_MODEL_DIR) are resolved from the project root, not the cwd.
- Never write uploaded audio to disk if not needed; use in-memory buffers or a temp file that is always cleaned up.
- Conversation history: the server is stateless. The browser keeps the history and sends it with every
  /api/chat request. History roles are only "user" or "assistant" (a client must never inject "system");
  each history message is at most 2000 characters (422 otherwise). The server keeps only the newest
  VA_LLM_MAX_HISTORY_MESSAGES (default 12) non-empty messages and drops a leading assistant message so the
  history always starts with a user turn.

## Frontend behaviour
- Chat-app layout: top bar (brand, live model-status pill polling /health, "New chat"), scrollable
  conversation, bottom dock with a large round mic button.
- Recording: click the mic or press Space (ignored when focus is on a control). While recording the button
  turns red with a pulsing ring, a live waveform (Web Audio AnalyserNode, RMS level) and a timer are shown.
  Auto-stop after 30 s; recordings shorter than 0.4 s are rejected with a message.
- After stopping: a "Transcribing…" placeholder bubble, then the transcript ("You", right), then a typing
  indicator, then the answer ("Assistant", left). Each bubble shows its stage time (Transcribed / Answered in X s).
- Welcome screen (shown while the conversation is empty): three clickable example questions that skip ASR and
  call /api/chat directly, plus a three-card pipeline overview (Whisper -> Qwen -> Piper).
- The history lives only in page memory: reloading the page or clicking "New chat" starts over.
  A question enters the history only after it was answered; on error its bubbles are removed.
- Each answer has its own Play button (Play -> Loading… -> Stop with an equaliser animation). Only one answer
  plays at a time, the WAV is fetched once per answer and cached as a blob URL (revoked on New chat), and
  starting a recording stops playback.
- Errors appear in a dismissible box above the mic (blocked mic, no mic, server unreachable, nothing recognised).
- Render model output with textContent, never innerHTML.
- Light/dark theme via prefers-color-scheme, mobile layout below 600 px, prefers-reduced-motion respected,
  aria-live regions and aria-labels. No external fonts, CDNs or icon libraries (inline SVG, system font).
- The page and /static files are served with "Cache-Control: no-cache" so edits show up without a hard refresh.

## Local environment notes (this machine)
- Run the server from the project venv: `python -m uvicorn app.main:app --reload --port 8001`.
  A plain `uvicorn` command may resolve to Anaconda's uvicorn, which lacks the project packages.
- Port 8000 is taken by Docker Desktop (another Django project), so this app runs on port 8001.
- Run only ONE server at a time: two `--reload` servers restarting together download the same model
  concurrently and can deadlock on the Hugging Face cache lock.
- After the models are cached, `HF_HUB_OFFLINE=1` skips network checks at startup.
  The Windows "symlinks not supported" warning from huggingface_hub is harmless.
- Known-good versions so far: fastapi 0.162.5, uvicorn 0.54.0, pydantic-settings 2.15.0,
  python-multipart 0.0.32, faster-whisper 1.2.1, torch 2.14.1+cpu, transformers 5.20.2, piper-tts 1.8.0.

## README
Written for GitHub. Include: short description, screenshots (stored in docs/screenshots/: home.png =
welcome screen, conversation.png = chat with follow-up and Play buttons), features, architecture diagram (Mermaid: Browser -> FastAPI -> ASR / LLM / TTS),
why each model was chosen (size, CPU speed, open-source), setup steps for Windows PowerShell and Linux,
how to download the voice, how to run (with the --port note), the note that models are downloaded from
Hugging Face on first run, configuration (VA_ variables), API reference, how conversation history works,
troubleshooting, known limitations (English only, CPU latency, small LLM quality, history lost on reload),
licences of the models/libraries, and possible next steps (streaming, Persian ASR/TTS, Docker).

## Project report
docs/Voice_Assistant_Project_Report.docx and .pdf are generated (git-ignored). Regenerate both when a step is
finished. Date format on the documents: Persian calendar in English, e.g. "Aban 1405".
One content source feeds two renderers: docx-js for the .docx, and print-CSS HTML printed by headless Chrome
for the PDF (two passes, so the table of contents has real page numbers). Word on this machine is unactivated
(reduced-functionality mode) and cannot save or export via COM, so it is not part of the pipeline.
Sections: summary with key numbers, overview, architecture (diagram + sequence), technology stack, phases,
UI with screenshots, API, security, configuration, testing, performance, challenges (symptom / root cause /
resolution / lesson), interview concepts (Q&A), limitations, licences, appendices.

## How to work
- Steps: 1) project skeleton + /health, 2) ASR, 3) LLM, 4) TTS, 5) frontend polish, 6) README + tests.
  The frontend is built incrementally: recording UI came with step 2, answers and history with step 3.
- Status: steps 1-5 and conversation history are done and committed; the README is written.
  Remaining: tests/test_api.py (step 6).
- After each step, tell me the exact command to run and what I should see, and wait for my confirmation
  before moving on. Commit after I confirm a step.
- Explanations to me are in Persian; code, comments, commit messages and README are in English.
- For each step, briefly explain the key concept behind it (e.g. why models load in lifespan,
  how MediaRecorder works, what int8 quantization does) because I am preparing for an AI engineering interview.
- Code must be complete and runnable: type hints, short docstrings, logging, no TODOs or placeholders.
- Pin package versions in requirements.txt only after confirming they install together.
