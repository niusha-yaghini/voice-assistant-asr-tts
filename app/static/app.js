"use strict";

/** Voice assistant frontend: record with MediaRecorder, upload, show transcript. */

const recordBtn = document.getElementById("record-btn");
const recordLabel = document.getElementById("record-label");
const statusEl = document.getElementById("status");
const errorEl = document.getElementById("error");
const transcriptBlock = document.getElementById("transcript-block");
const transcriptEl = document.getElementById("transcript");

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

/** Pick a container/codec the current browser can record. */
function pickMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

async function startRecording() {
  clearError();
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

/** Upload the recording and display the transcript. */
async function handleRecording(blob) {
  recordBtn.disabled = true;
  transcriptBlock.hidden = true;
  setStatus("Transcribing...");

  try {
    const form = new FormData();
    form.append("audio", blob, "recording." + (blob.type.includes("ogg") ? "ogg" : "webm"));
    const response = await fetch("/api/transcribe", { method: "POST", body: form });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || "Request failed (" + response.status + ")");

    transcriptEl.textContent = data.text || "(nothing was recognised)";
    transcriptBlock.hidden = false;
    setStatus("");
  } catch (err) {
    showError(err.message);
    setStatus("");
  } finally {
    recordBtn.disabled = false;
  }
}

recordBtn.addEventListener("click", () => {
  if (mediaRecorder && mediaRecorder.state === "recording") stopRecording();
  else startRecording();
});
