"use strict";

/**
 * Voice assistant frontend: record with MediaRecorder, transcribe, ask the LLM.
 *
 * The conversation history lives only in this page (the `history` array) and is
 * sent with every /api/chat request, so the server stays stateless. Reloading
 * the page or clicking "New conversation" starts over.
 */

const recordBtn = document.getElementById("record-btn");
const recordLabel = document.getElementById("record-label");
const statusEl = document.getElementById("status");
const errorEl = document.getElementById("error");
const conversationEl = document.getElementById("conversation");
const turnsEl = document.getElementById("turns");
const resetBtn = document.getElementById("reset-btn");

/** @type {{role: "user" | "assistant", content: string}[]} */
let history = [];
let mediaRecorder = null;
let chunks = [];

function setStatus(message) {
  statusEl.textContent = message;
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function clearError() {
  errorEl.hidden = true;
  errorEl.textContent = "";
}

/** Append one message bubble to the conversation and return it. */
function addTurn(role, text) {
  const item = document.createElement("li");
  item.className = "turn turn-" + role;

  const label = document.createElement("span");
  label.className = "turn-label";
  label.textContent = role === "user" ? "You" : "Assistant";

  const body = document.createElement("p");
  body.textContent = text; // textContent, never innerHTML: model output is untrusted

  item.append(label, body);
  if (role === "assistant") item.append(createPlayButton(text));
  turnsEl.append(item);
  conversationEl.hidden = false;
  item.scrollIntoView({ behavior: "smooth", block: "nearest" });
  return item;
}

// ---------- Text-to-speech playback ----------

/** The single shared player: only one answer plays at a time. */
const player = new Audio();
/** Button of the answer that is currently loading or playing. */
let activeButton = null;
/** WAV object URLs per answer button, so replaying does not call the server again. */
const audioCache = new WeakMap();

function setPlayState(button, state) {
  const labels = { idle: "▶ Play", loading: "… Loading", playing: "■ Stop" };
  button.dataset.state = state;
  button.textContent = labels[state];
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
    stopPlayback(); // second click on the same answer = stop
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
    if (activeButton !== button) return; // another answer was clicked while loading

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
  setPlayState(button, "idle");
  button.addEventListener("click", () => togglePlayback(button, text));
  return button;
}

function resetConversation() {
  stopPlayback();
  turnsEl.querySelectorAll(".play-btn").forEach((button) => {
    const url = audioCache.get(button);
    if (url) URL.revokeObjectURL(url); // free the WAV blobs of the old conversation
  });
  history = [];
  turnsEl.replaceChildren();
  conversationEl.hidden = true;
  clearError();
  setStatus("");
}

/** Pick a container/codec the current browser can record. */
function pickMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

async function startRecording() {
  clearError();
  stopPlayback(); // don't record the assistant's own voice
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    showError("Your browser does not support audio recording.");
    return;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    showError(
      err.name === "NotAllowedError"
        ? "Microphone permission was denied. Allow it in the browser address bar and try again."
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
    handleRecording(new Blob(chunks, { type: mediaRecorder.mimeType }));
  };

  mediaRecorder.start();
  recordBtn.classList.add("recording");
  recordLabel.textContent = "Stop recording";
  setStatus("Recording... speak now.");
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop();
  recordBtn.classList.remove("recording");
  recordLabel.textContent = "Start recording";
}

/** Send a request and return parsed JSON, throwing the server's error message on failure. */
async function requestJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || "Request failed (" + response.status + ")");
  return data;
}

/** Upload the recording, show the transcript, then ask the LLM with the conversation so far. */
async function handleRecording(blob) {
  recordBtn.disabled = true;
  resetBtn.disabled = true;
  setStatus("Transcribing...");
  let userTurn = null;

  try {
    const form = new FormData();
    form.append("audio", blob, "recording." + (blob.type.includes("ogg") ? "ogg" : "webm"));
    const { text } = await requestJson("/api/transcribe", { method: "POST", body: form });

    if (!text) {
      setStatus("Nothing was recognised. Please try again.");
      return;
    }
    userTurn = addTurn("user", text);

    setStatus("Thinking...");
    const { answer } = await requestJson("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, history }),
    });
    addTurn("assistant", answer);

    // Only a completed exchange becomes context for the next question.
    history.push({ role: "user", content: text }, { role: "assistant", content: answer });
    setStatus("");
  } catch (err) {
    if (userTurn) userTurn.remove(); // the question was not answered, so drop it
    if (!turnsEl.children.length) conversationEl.hidden = true;
    showError(err.message);
    setStatus("");
  } finally {
    recordBtn.disabled = false;
    resetBtn.disabled = false;
  }
}

recordBtn.addEventListener("click", () => {
  if (mediaRecorder && mediaRecorder.state === "recording") stopRecording();
  else startRecording();
});

resetBtn.addEventListener("click", resetConversation);
