const $ = (id) => document.getElementById(id);

const IN_RATE = 24000;
const FRAME_MS = 20;
const SAMPLES_PER_FRAME = Math.round((IN_RATE * FRAME_MS) / 1000);

let ws = null;
let audioCtx = null;
let micStream = null;
let sourceNode = null;
let processorNode = null;
let playing = false;

// Reconnect backoff
let reconnectAttempt = 0;
let reconnectTimer = null;

function scheduleReconnect() {
  if (!playing) return;
  if (reconnectTimer) return;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), 15000);
  reconnectAttempt += 1;
  log(`[ws] reconnect in ${delay}ms`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    try {
      start();
    } catch (_) {
      scheduleReconnect();
    }
  }, delay);
}

// ===== audio playback queue (prevents overlapping responses) =====
let playQueue = [];
let playingSource = null;
let playPumpRunning = false;

function clearPlayback() {
  playQueue = [];
  try {
    if (playingSource) {
      playingSource.onended = null;
      playingSource.stop();
      playingSource.disconnect();
    }
  } catch (_) {
    // ignore
  }
  playingSource = null;
}

async function pumpPlayback() {
  if (playPumpRunning) return;
  playPumpRunning = true;

  try {
    const ctx = ensureAudioCtx();
    await resumeAudioIfNeeded();

    while (playing && playQueue.length) {
      // If context got suspended mid-play, resume.
      if (ctx.state !== "running") {
        await resumeAudioIfNeeded();
      }

      const { b64, sampleRate } = playQueue.shift();
      const bytes = b64ToBytes(b64);
      const pcm16 = new Int16Array(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength / 2
      );

      const audioBuffer = ctx.createBuffer(1, pcm16.length, sampleRate);
      const channel = audioBuffer.getChannelData(0);
      for (let i = 0; i < pcm16.length; i++) channel[i] = pcm16[i] / 32768;

      await new Promise((resolve) => {
        const src = ctx.createBufferSource();
        playingSource = src;
        src.buffer = audioBuffer;
        src.connect(ctx.destination);
        src.onended = () => resolve();
        src.start();
      });

      playingSource = null;
    }
  } finally {
    playPumpRunning = false;

    // If queue still has items but we exited (rare), restart.
    if (playing && playQueue.length) {
      void pumpPlayback();
    }
  }
}

function enqueuePcm16Base64(b64, sampleRate = 44100) {
  playQueue.push({ b64, sampleRate });
  void pumpPlayback();
}

// ===== utils =====
function log(...args) {
  const el = $("log");
  const line = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  el.textContent += line + "\n";
  el.scrollTop = el.scrollHeight;
}

function setStatus(s) {
  $("status").textContent = s;
}

function floatToPCM16Bytes(float32Array) {
  const out = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    let x = float32Array[i];
    x = Math.max(-1, Math.min(1, x));
    out[i] = x < 0 ? x * 0x8000 : x * 0x7fff;
  }
  return new Uint8Array(out.buffer);
}

function b64EncodeBytes(u8) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

function ensureAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: "interactive",
    });

    // If the context gets suspended (mobile/tab switch), try to resume.
    audioCtx.onstatechange = () => {
      log(`[audio] state=${audioCtx.state}`);
      if (audioCtx.state === "suspended" && playing) {
        void audioCtx.resume().catch(() => {});
      }
    };
  }
  return audioCtx;
}

async function resumeAudioIfNeeded() {
  const ctx = ensureAudioCtx();
  if (ctx.state !== "running") {
    try {
      await ctx.resume();
      log("[audio] resumed");
    } catch {
      // ignore
    }
  }
}

function playPcm16Base64(b64, sampleRate = 44100) {
  // Deprecated direct playback; keep for compatibility.
  enqueuePcm16Base64(b64, sampleRate);
}

function getModalities() {
  // Some backends expect exactly one modality per request.
  // Keep audio as default to avoid 'Modalities can be either audio or text' errors.
  return ["audio"];
}

// ===== session init =====
function sendSessionUpdate() {
  const instructions = $("txtInstructions").value || "";
  const voice = ($("selVoice")?.value || "dasha").trim();

  const payload = {
    type: "session.update",
    session: {
      instructions,
      output_modalities: getModalities(),
      audio: {
        input: {
          format: { type: "audio/pcm", rate: IN_RATE, channels: 1 },
          turn_detection: { type: "server_vad", threshold: 0.5, silence_duration_ms: 400 },
        },
        output: {
          format: { type: "audio/pcm", rate: 44100 },
          voice,
        },
      },
    },
  };

  ws.send(JSON.stringify(payload));
}

// When user changes voice while connected: restart the session cleanly.
$("selVoice")?.addEventListener("change", async () => {
  const v = $("selVoice")?.value;
  log(`[ui] voice = ${v}`);

  // No active session: nothing else to do.
  if (!playing) return;

  // Restart everything so new voice is guaranteed to apply.
  setStatus("restarting...");

  try {
    await stopMic();
  } catch {
    // ignore
  }

  clearPlayback();

  try {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.onopen = null;
      ws.close();
    }
  } catch {
    // ignore
  }

  ws = null;

  // Reconnect with updated voice
  reconnectAttempt = 0;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  // Start a fresh session
  playing = false;
  start();
});

function maybeAutoResponseCreate() {
  if (!$("chkAutoResponse").checked) return;
  const payload = {
    type: "response.create",
    response: { modalities: getModalities(), conversation: "default" },
  };
  ws.send(JSON.stringify(payload));
}

// Improve server error visibility
function logServerError(msg) {
  const e = msg?.error;
  const message = e?.message || "unknown";
  log(`[error] ${message}`);
}

// ===== mic capture =====
async function startMic() {
  const ctx = ensureAudioCtx();
  await ctx.resume();

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  sourceNode = ctx.createMediaStreamSource(micStream);

  // ScriptProcessor is deprecated, but simplest for a minimal demo.
  // Works in Chromium-based browsers and Safari.
  processorNode = ctx.createScriptProcessor(4096, 1, 1);

  // We'll do naive resampling to 24kHz.
  const inRate = ctx.sampleRate;
  let ring = new Float32Array(0);

  processorNode.onaudioprocess = (event) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const input = event.inputBuffer.getChannelData(0);

    // append to ring
    const merged = new Float32Array(ring.length + input.length);
    merged.set(ring, 0);
    merged.set(input, ring.length);
    ring = merged;

    // ratio from input rate to 24k
    const ratio = inRate / IN_RATE;

    // while enough samples for one 20ms frame at 24k
    const neededIn = Math.ceil(SAMPLES_PER_FRAME * ratio);

    while (ring.length >= neededIn) {
      const chunk = ring.subarray(0, neededIn);
      ring = ring.subarray(neededIn);

      // downsample using linear interpolation
      const out = new Float32Array(SAMPLES_PER_FRAME);
      for (let i = 0; i < SAMPLES_PER_FRAME; i++) {
        const t = i * ratio;
        const i0 = Math.floor(t);
        const i1 = Math.min(i0 + 1, chunk.length - 1);
        const a = t - i0;
        out[i] = chunk[i0] * (1 - a) + chunk[i1] * a;
      }

      const pcmBytes = floatToPCM16Bytes(out);
      const b64 = b64EncodeBytes(pcmBytes);
      ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
    }
  };

  // connect (we don't want to playback mic, so don't connect to destination)
  sourceNode.connect(processorNode);
  processorNode.connect(ctx.destination); // keep processor alive
}

async function stopMic() {
  try {
    if (processorNode) {
      processorNode.disconnect();
      processorNode.onaudioprocess = null;
      processorNode = null;
    }
    if (sourceNode) {
      sourceNode.disconnect();
      sourceNode = null;
    }
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }
  } catch (_) {
    // ignore
  }
}

// ===== ws handling =====
function start() {
  if (playing) return;
  playing = true;
  reconnectAttempt = 0;

  $("btnToggle").classList.add("on");
  $("btnToggle").textContent = "Stop";
  setStatus("connecting...");

  const wsScheme = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${wsScheme}://${location.host}/ws`);

  ws.onopen = async () => {
    setStatus("connected");
    log("WS connected");

    await resumeAudioIfNeeded();

    sendSessionUpdate();

    // start mic after session update
    await startMic();
    log("Mic started");
  };

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    const t = msg.type;

    if (t === "conversation.item.input_audio_transcription.completed") {
      if (msg.transcript) log(`[user] ${msg.transcript}`);
      return;
    }

    if (t === "response.output_text.delta") {
      if (msg.delta) log(`[agent] ${msg.delta}`);
      return;
    }

    if (t === "response.output_audio.delta") {
      if (msg.delta) enqueuePcm16Base64(msg.delta, 44100);
      return;
    }

    // Clear playback when user starts speaking or on new response start,
    // so old TTS doesn't bleed into the new one.
    if (t === "input_audio_buffer.speech_started" || t === "response.created") {
      clearPlayback();
      return;
    }

    if (t === "input_audio_buffer.commit") {
      // server vad committed
      maybeAutoResponseCreate();
      return;
    }

    if (t === "error") {
      logServerError(msg);
      return;
    }

    // Uncomment for debugging
    // log("[event]", t);
  };

  ws.onclose = (ev) => {
    clearPlayback();
    const reason = (ev && typeof ev.reason === "string" ? ev.reason : "").trim();
    log(`WS closed (code=${ev.code}, reason=${reason})`);
    setStatus("closed");

    // Auto-reconnect if it dropped unexpectedly.
    scheduleReconnect();
  };

  ws.onerror = (e) => {
    log("WS error", e);
    setStatus("ws error");
  };
}

async function stop() {
  if (!playing) return;
  playing = false;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  $("btnToggle").classList.remove("on");
  $("btnToggle").textContent = "Start";
  setStatus("stopping...");

  await stopMic();
  clearPlayback();

  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  } catch (_) {
    // ignore
  }

  ws = null;
  setStatus("idle");
}

// Try to keep AudioContext alive (tab switching may suspend it)
setInterval(() => {
  if (!playing) return;
  void resumeAudioIfNeeded();
}, 3000);

$("btnToggle").addEventListener("click", async () => {
  if (!playing) start();
  else await stop();
});
