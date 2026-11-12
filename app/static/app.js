"use strict";

/**
 * Voice assistant frontend (vanilla JS, no build step).
 *
 * Flow: MediaRecorder -> POST /api/transcribe -> POST /api/chat (with history)
 *       -> optional POST /api/tts when the user presses Play on an answer.
 *
 * The conversation history lives only in this page (`history`) and is sent with
 * every /api/chat request, so the server stays stateless. Reloading the page or
 * pressing "New chat" starts over.
 */

const MAX_RECORDING_MS = 30_000; // one sentence; also keeps uploads far below the 10 MB limit
const MIN_RECORDING_MS = 400;

const $ = (id) => document.getElementById(id);
const chatEl = $("chat");
const emptyEl = $("empty");
const turnsEl = $("turns");
const recorderEl = document.querySelector(".recorder");
const recordBtn = $("record-btn");
const waveCanvas = $("wave");
const statusEl = $("status");
const errorEl = $("error");
const errorText = $("error-text");
const resetBtn = $("reset-btn");
const healthEl = $("health");
const healthLabel = $("health-label");
const chips = document.querySelectorAll(".chip");

/** @type {{role: "user" | "assistant", content: string}[]} */
let history = [];
let busy = false;

// ---------- Small UI helpers ----------

const ICONS = {
  spark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 10v4M9 7v10M13 5v14M17 8v8M21 11v2"/></svg>',
  play: '<svg class="icon-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/></svg>',
  eq: '<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>',
};

function setStatus(text) {
  statusEl.textContent = text;
}

function setIdleStatus() {
  statusEl.replaceChildren(document.createTextNode("Tap the microphone"));
  const hint = document.createElement("span");
  hint.className = "kbd-hint";
  hint.append(" or press ");
  const kbd = document.createElement("kbd");
  kbd.textContent = "Space";
  hint.append(kbd);
  statusEl.append(hint);
}

function showError(message) {
  errorText.textContent = message;
  errorEl.hidden = false;
}

function clearError() {
  errorEl.hidden = true;
  errorText.textContent = "";
}

function seconds(ms) {
  return (ms / 1000).toFixed(1) + " s";
}

function scrollToBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

/** Lock or unlock every control that starts a new request. */
function setBusy(value) {
  busy = value;
  recorderEl.classList.toggle("is-busy", value);
  recordBtn.disabled = value;
  chips.forEach((chip) => (chip.disabled = value));
  resetBtn.disabled = value || turnsEl.children.length === 0;
}

function updateEmptyState() {
  emptyEl.hidden = turnsEl.children.length > 0;
  resetBtn.disabled = busy || turnsEl.children.length === 0;
}

// ---------- Conversation rendering ----------

/** Create a turn element; `pending` shows a placeholder until fill*() is called. */
function addTurn(role, { pending = false } = {}) {
  const item = document.createElement("li");
  item.className = "turn turn-" + role;

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  if (role === "assistant") avatar.innerHTML = ICONS.spark; // static markup, no user data
  else avatar.textContent = "You";

  const bubble = document.createElement("div");
  bubble.className = "bubble" + (pending ? " pending" : "");

  if (pending && role === "assistant") {
    bubble.innerHTML = '<div class="typing" aria-label="Thinking"><span></span><span></span><span></span></div>';
  } else if (pending) {
    const p = document.createElement("p");
    p.className = "shimmer";
    p.textContent = "Transcribing…";
    bubble.append(p);
  }

  item.append(avatar, bubble);
  turnsEl.append(item);
  updateEmptyState();
  scrollToBottom();
  return item;
}

function fillUserTurn(item, text, asrMs) {
  const bubble = item.querySelector(".bubble");
  bubble.classList.remove("pending");
  const p = document.createElement("p");
  p.textContent = text; // textContent, never innerHTML: transcripts are untrusted
  bubble.replaceChildren(p);
  if (asrMs != null) {
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = "Transcribed in " + seconds(asrMs);
    bubble.append(meta);
  }
}

function fillAssistantTurn(item, text, llmMs) {
  const bubble = item.querySelector(".bubble");
  bubble.classList.remove("pending");
  const p = document.createElement("p");
  p.textContent = text; // model output is untrusted
  const footer = document.createElement("div");
  footer.className = "bubble-footer";
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = "Answered in " + seconds(llmMs);
  footer.append(createPlayButton(text), meta);
  bubble.replaceChildren(p, footer);
  scrollToBottom();
}

function removeTurn(item) {
  if (item) item.remove();
  updateEmptyState();
}

// ---------- Text-to-speech playback ----------

/** One shared player: only one answer plays at a time. */
const player = new Audio();
/** Button of the answer that is currently loading or playing. */
let activeButton = null;
/** WAV object URLs per answer button, so replaying does not call the server again. */
const audioCache = new WeakMap();

function setPlayState(button, state) {
  const labels = { idle: "Play", loading: "Loading…", playing: "Stop" };
  button.dataset.state = state;
  button.querySelector(".label").textContent = labels[state];
  button.setAttribute("aria-label", state === "playing" ? "Stop playback" : "Play this answer");
}

function stopPlayback() {
  player.pause();
  player.currentTime = 0;
  if (activeButton) setPlayState(activeButton, "idle");
  activeButton = null;
}

/** Fetch (once) and play the speech for one answer; clicking again stops it. */
async function togglePlayback(button, text) {
  if (activeButton === button) {
    stopPlayback();
    return;
  }
  stopPlayback();
  clearError();
  activeButton = button;

  try {
    let url = audioCache.get(button);
    if (!url) {
      setPlayState(button, "loading");
      const response = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.detail || "Speech request failed (" + response.status + ")");
      }
      url = URL.createObjectURL(await response.blob());
      audioCache.set(button, url);
    }
    if (activeButton !== button) return; // another answer was chosen while loading

    player.src = url;
    setPlayState(button, "playing");
    await player.play();
  } catch (err) {
    if (activeButton === button) {
      setPlayState(button, "idle");
      activeButton = null;
    }
    showError(err.message);
  }
}

player.addEventListener("ended", () => {
  if (activeButton) setPlayState(activeButton, "idle");
  activeButton = null;
});

function createPlayButton(text) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "play-btn";
  button.innerHTML = ICONS.play + ICONS.eq + '<span class="label"></span>'; // static markup
  setPlayState(button, "idle");
  button.addEventListener("click", () => togglePlayback(button, text));
  return button;
}

// ---------- Recording ----------

let mediaRecorder = null;
let chunks = [];
let recordingStartedAt = 0;
let timerId = null;
let autoStopId = null;
let audioContext = null;
let analyser = null;
let waveFrame = null;

/** Pick a container/codec the current browser can record. */
function pickMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function isRecording() {
  return mediaRecorder !== null && mediaRecorder.state === "recording";
}

function formatClock(ms) {
  const total = Math.floor(ms / 1000);
  return Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
}

/** Live waveform of the microphone using the Web Audio API (AnalyserNode). */
function startWaveform(stream) {
  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    audioContext.createMediaStreamSource(stream).connect(analyser);
  } catch {
    return; // purely visual: recording still works without it
  }

  const ctx = waveCanvas.getContext("2d");
  const samples = new Uint8Array(analyser.fftSize);
  const color = getComputedStyle(document.documentElement).getPropertyValue("--danger").trim() || "#e11d48";
  let level = 0;
  const bars = [];

  const draw = () => {
    const dpr = window.devicePixelRatio || 1;
    const width = waveCanvas.clientWidth;
    const height = waveCanvas.clientHeight;
    if (waveCanvas.width !== width * dpr) {
      waveCanvas.width = width * dpr;
      waveCanvas.height = height * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // RMS loudness of the current frame, smoothed.
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const s of samples) sum += ((s - 128) / 128) ** 2;
    level = level * 0.6 + Math.sqrt(sum / samples.length) * 0.4;

    // Scrolling bars on both sides of the button (newest bars nearest to it).
    const barWidth = 3;
    const gap = 3;
    const perSide = Math.max(0, Math.floor((width / 2 - 52) / (barWidth + gap)));
    bars.unshift(Math.min(1, level * 4.5));
    bars.length = Math.min(bars.length, perSide);

    ctx.fillStyle = color;
    bars.forEach((value, i) => {
      const barHeight = Math.max(3, value * (height - 16));
      const y = (height - barHeight) / 2;
      ctx.globalAlpha = 1 - i / (perSide + 4);
      const offset = 52 + i * (barWidth + gap);
      ctx.fillRect(width / 2 + offset, y, barWidth, barHeight);
      ctx.fillRect(width / 2 - offset - barWidth, y, barWidth, barHeight);
    });
    ctx.globalAlpha = 1;
    waveFrame = requestAnimationFrame(draw);
  };
  draw();
}

function stopWaveform() {
  if (waveFrame) cancelAnimationFrame(waveFrame);
  waveFrame = null;
  if (audioContext) audioContext.close().catch(() => {});
  audioContext = null;
  analyser = null;
  const ctx = waveCanvas.getContext("2d");
  ctx.clearRect(0, 0, waveCanvas.width, waveCanvas.height);
}

async function startRecording() {
  clearError();
  stopPlayback(); // don't record the assistant's own voice
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    showError("This browser does not support audio recording. Try a recent Chrome, Edge or Firefox.");
    return;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    showError(
      err.name === "NotAllowedError"
        ? "Microphone access was blocked. Allow it from the icon in the address bar, then try again."
        : err.name === "NotFoundError"
          ? "No microphone was found. Connect one and try again."
          : "Could not access the microphone: " + err.message
    );
    return;
  }

  chunks = [];
  mediaRecorder = new MediaRecorder(stream, { mimeType: pickMimeType() || undefined });
  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  mediaRecorder.onstop = () => {
    stream.getTracks().forEach((track) => track.stop()); // release the microphone
    const durationMs = performance.now() - recordingStartedAt;
    const blob = new Blob(chunks, { type: mediaRecorder.mimeType });
    if (durationMs < MIN_RECORDING_MS || blob.size === 0) {
      showError("That was too short. Hold on a moment longer while you speak.");
      setIdleStatus();
      return;
    }
    handleRecording(blob);
  };

  mediaRecorder.start();
  recordingStartedAt = performance.now();
  recorderEl.classList.add("is-recording");
  recordBtn.setAttribute("aria-label", "Stop recording");
  startWaveform(stream);

  const tick = () => setStatus("Listening… " + formatClock(performance.now() - recordingStartedAt) + " · tap to stop");
  tick();
  timerId = setInterval(tick, 250);
  autoStopId = setTimeout(stopRecording, MAX_RECORDING_MS);
}

function stopRecording() {
  clearInterval(timerId);
  clearTimeout(autoStopId);
  stopWaveform();
  recorderEl.classList.remove("is-recording");
  recordBtn.setAttribute("aria-label", "Start recording");
  if (isRecording()) mediaRecorder.stop(); // triggers onstop -> handleRecording
}

// ---------- Requests ----------

/** Send a request and return parsed JSON, throwing the server's error message on failure. */
async function requestJson(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new Error("Cannot reach the server. Is it still running?");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = Array.isArray(data.detail) ? data.detail[0]?.msg : data.detail;
    throw new Error(detail || "Request failed (" + response.status + ")");
  }
  return data;
}

/** Recording -> transcript -> answer. */
async function handleRecording(blob) {
  setBusy(true);
  setStatus("Transcribing…");
  const userTurn = addTurn("user", { pending: true });

  try {
    const form = new FormData();
    form.append("audio", blob, "recording." + (blob.type.includes("ogg") ? "ogg" : "webm"));
    const started = performance.now();
    const { text } = await requestJson("/api/transcribe", { method: "POST", body: form });
    const asrMs = performance.now() - started;

    if (!text) {
      removeTurn(userTurn);
      showError("No speech was recognised. Try again a little closer to the microphone.");
      return;
    }
    fillUserTurn(userTurn, text, asrMs);
    await askAssistant(text, userTurn);
  } catch (err) {
    removeTurn(userTurn);
    showError(err.message);
  } finally {
    setBusy(false);
    setIdleStatus();
  }
}

/** Typed question (example chips) -> answer, skipping speech-to-text. */
async function handleTypedQuestion(text) {
  clearError();
  stopPlayback();
  setBusy(true);
  const userTurn = addTurn("user");
  fillUserTurn(userTurn, text, null);
  try {
    await askAssistant(text, userTurn);
  } catch (err) {
    removeTurn(userTurn);
    showError(err.message);
  } finally {
    setBusy(false);
    setIdleStatus();
  }
}

/** Ask the LLM with the conversation so far; only a completed exchange enters the history. */
async function askAssistant(text, userTurn) {
  setStatus("Thinking…");
  const assistantTurn = addTurn("assistant", { pending: true });
  try {
    const started = performance.now();
    const { answer } = await requestJson("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, history }),
    });
    fillAssistantTurn(assistantTurn, answer, performance.now() - started);
    history.push({ role: "user", content: text }, { role: "assistant", content: answer });
  } catch (err) {
    removeTurn(assistantTurn);
    throw err; // caller removes the unanswered question
  }
}

function resetConversation() {
  stopPlayback();
  turnsEl.querySelectorAll(".play-btn").forEach((button) => {
    const url = audioCache.get(button);
    if (url) URL.revokeObjectURL(url); // free the WAV blobs of the old conversation
  });
  history = [];
  turnsEl.replaceChildren();
  clearError();
  updateEmptyState();
  setIdleStatus();
}

// ---------- Server health ----------

async function checkHealth() {
  try {
    const response = await fetch("/health", { cache: "no-store" });
    const data = await response.json();
    if (response.ok && data.models_loaded) {
      healthEl.dataset.state = "ready";
      healthLabel.textContent = "Models ready";
      return;
    }
    healthEl.dataset.state = "loading";
    healthLabel.textContent = "Loading models…";
  } catch {
    healthEl.dataset.state = "error";
    healthLabel.textContent = "Server offline";
  }
  setTimeout(checkHealth, 4000); // keep checking until the models are ready
}

// ---------- Wiring ----------

function toggleRecording() {
  if (isRecording()) stopRecording();
  else if (!busy) startRecording();
}

recordBtn.addEventListener("click", toggleRecording);
resetBtn.addEventListener("click", resetConversation);
$("error-close").addEventListener("click", clearError);
chips.forEach((chip) => chip.addEventListener("click", () => handleTypedQuestion(chip.textContent.trim())));

// Space toggles recording, unless focus is on a control that uses Space itself.
document.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || event.repeat) return;
  if (event.target.closest("button, input, textarea, select, [contenteditable]")) return;
  event.preventDefault();
  toggleRecording();
});

setIdleStatus();
updateEmptyState();
checkHealth();
