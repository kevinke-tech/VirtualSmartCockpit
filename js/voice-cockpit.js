/**
 * Virtual cockpit voice — derived from::
 *
 *   E:\\21_Coding\\vui\\js\\voice-doubao.js   (Adaptive VAD + TTS + media echo suppression)
 *
 * Improvements over v3:
 *  1. Adaptive noise floor — threshold tracks ambient RMS, no more false triggers
 *  2. Pre-speech ring buffer — captures ~300ms before speech onset, no clipped starts
 *  3. TTS echo suppression — mutes VAD while TTS is playing through speakers
 *  4. Barge-in / interrupt — if user speaks loudly during TTS, TTS stops immediately
 *  5. Debounced speech end — requires longer continuous silence to cut off
 */

(function () {
  "use strict";

  var BACKEND =
    typeof window.__COCKPIT_API_BASE !== "undefined" && window.__COCKPIT_API_BASE !== null
      ? String(window.__COCKPIT_API_BASE)
      : "";
  var VOX_BACKEND_STORAGE_KEY = "cockpit_vox_backend";
  var VOX_BACKEND_DEFAULT = "http://127.0.0.1:5001";
  var TARGET_SAMPLE_RATE = 16000;

  // ── VAD tuning ────────────────────────────────────────────────────
  var NOISE_FLOOR_INIT = 0.008;
  var NOISE_FLOOR_ALPHA = 0.03;       // EMA smoothing for noise tracking
  var SPEECH_THRESHOLD_RATIO = 3.0;   // speech must be N× above noise floor
  var SPEECH_THRESHOLD_MIN = 0.012;   // absolute minimum threshold
  var SPEECH_START_THRESHOLD_RATIO = 3.6; // stricter threshold to enter speaking state
  var SILENCE_DURATION_MS = 500;      // silence after last speech frame to trigger end
  var MIN_SPEECH_DURATION_MS = 250;   // ignore very short bursts
  var MAX_SPEECH_DURATION_MS = 15000;
  var PRE_BUFFER_FRAMES = 4;          // keep N frames before speech onset (~370ms at 4096/48kHz)
  var START_CONSEC_FRAMES = 2;        // require continuous voiced frames before start
  var MIN_VOICED_FRAMES = 4;          // require enough voiced frames before sending ASR
  var BARGE_IN_RATIO = 5.0;           // during TTS, user must be N× above noise to interrupt

  // ── state ───────────────────────────────────────────────────────────
  var audioCtx = null;
  var mediaStream = null;
  var scriptNode = null;
  var isActive = false;
  var isSpeaking = false;
  var speechStart = 0;
  var lastSpeechTime = 0;
  var speechBuffer = [];
  var speechVoicedFrames = 0;
  var speechConsecFrames = 0;
  var speechStartThreshold = SPEECH_THRESHOLD_MIN;
  var processing = false;

  // Adaptive noise floor
  var noiseFloor = NOISE_FLOOR_INIT;
  var noiseFrameCount = 0;

  // Pre-speech ring buffer
  var preBuffer = [];

  // TTS state
  var currentTTSAudio = null;
  var ttsPlaying = false;

  function syncTtsGlobal() {
    try {
      window.__cockpitTtsPlaying = !!ttsPlaying;
    } catch (e) {}
  }

  // Video playback echo suppression
  var videoPlaying = false;
  var videoNoiseLevel = 0;
  var VIDEO_NOISE_ALPHA = 0.08;  // faster EMA tracking so quiet moments are caught sooner
  var VIDEO_SPEECH_RATIO = 1.4;  // user voice must be 1.4× above video noise (was 2.0)

  // ── DOM helpers ─────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }

  function updateVUI(status, message) {
    var statusEl = $("vuiStatusText");
    var micCore = $("vuiMicCore");
    var cmdEl = $("vuiCommandText");
    var waves = $("listeningWaves");
    var proc = $("processingIndicator");
    var vadDot = $("vuiVadIndicator");

    var labels = {
      idle:       "\u{1F534} \u5F85\u547D\u4EE4",
      connecting: "\u{1F4E1} \u542F\u52A8\u4E2D\u2026",
      ready:      "\u{1F7E2} \u8BF7\u8BF4\u8BDD",
      listening:  "\u{1F50A} \u8046\u542C\u4E2D\u2026",
      processing: "\u2699\uFE0F \u8BC6\u522B\u4E2D\u2026",
      success:    "\u2714 " + (message || ""),
      error:      "\u2716 " + (message || ""),
      no_support: "\u26A0\uFE0F \u6D4F\u89C8\u5668\u4E0D\u652F\u6301",
    };

    if (statusEl) statusEl.textContent = labels[status] || message || "";
    if (micCore) micCore.className = "vui-mic-core " + status;
    if (waves) waves.style.display = status === "listening" ? "flex" : "none";
    if (proc) proc.style.display = status === "processing" ? "flex" : "none";

    if (vadDot) {
      var dot = vadDot.querySelector(".vad-dot");
      var txt = vadDot.querySelector(".vad-text");
      if (status === "listening") {
        if (dot) dot.classList.add("active");
        if (txt) txt.textContent = "\u8BED\u97F3\u68C0\u6D4B\u4E2D";
      } else {
        if (dot) dot.classList.remove("active");
        if (txt) txt.textContent = status === "ready" ? "\u7B49\u5F85\u8BED\u97F3\u2026" : "";
      }
    }

    if (cmdEl && message && (status === "success" || status === "error")) {
      cmdEl.textContent = status === "success" ? "\u300C" + message + "\u300D" : message;
      cmdEl.className = "vui-command-text show " + (status === "success" ? "success" : "");
      setTimeout(function () { cmdEl.className = "vui-command-text"; }, 4000);
    }

    console.log("[Voice]", status, message || "");
  }

  // ── page context ────────────────────────────────────────────────────
  function getPageContext() {
    return window.Cockpit && typeof window.Cockpit.getVoiceContext === "function"
      ? window.Cockpit.getVoiceContext()
      : {};
  }

  function normalizeBackend(raw, fallback) {
    var v = String(raw || fallback || "").trim();
    return v.replace(/\/+$/, "");
  }

  function getVoxBackend() {
    var stored = "";
    try {
      stored = localStorage.getItem(VOX_BACKEND_STORAGE_KEY) || "";
    } catch (_e) {}
    return normalizeBackend(stored, VOX_BACKEND_DEFAULT);
  }

  function actionCanReuseCockpitUi(action) {
    if (!action) return false;
    if (action === "none" || action === "unknown" || action === "chat") return false;
    return true;
  }

  async function callVoxPlanFallback(transcript) {
    var vox = getVoxBackend();
    var resp = await fetch(vox + "/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript: transcript,
        image_b64: null,
        context: {
          source: "virtual-smart-cockpit-voice",
          cockpit: getPageContext(),
        },
      }),
    });
    if (!resp.ok) throw new Error("VOX /plan " + resp.status);
    return resp.json();
  }

  async function tryVoxFallbackForIntent(text, intentData) {
    var action = intentData && intentData.action ? String(intentData.action).trim() : "";
    if (action === "none") return false;
    if (actionCanReuseCockpitUi(action)) return false;
    if (!text) return false;
    try {
      var plan = await callVoxPlanFallback(text);
      var speak = (plan && plan.speak ? String(plan.speak) : "").trim();
      var render = (plan && plan.render ? String(plan.render) : "").trim();
      var kind = (plan && plan.kind ? String(plan.kind) : "unknown").trim();
      console.log("[Voice] VOX fallback:", kind, render || speak || "(empty)");
      if (speak) {
        if (window.CockpitTTS && window.CockpitTTS.speak)
          window.CockpitTTS.speak(speak, { interrupt: true });
        else if (typeof window.speakTTS === "function")
          window.speakTTS(speak, { interrupt: true });
      }
      updateVUI("success", speak || render || ("VOX: " + kind));
      setTimeout(function () { updateVUI("ready"); }, 3500);
      return true;
    } catch (e) {
      console.warn("[Voice] VOX fallback failed:", e.message);
      return false;
    }
  }

  // ── WAV encoding ────────────────────────────────────────────────────
  function float32ToWav16Mono(samples, sampleRate) {
    var n = samples.length;
    var buf = new ArrayBuffer(44 + n * 2);
    var v = new DataView(buf);
    function w(o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }
    w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, "data"); v.setUint32(40, n * 2, true);
    for (var i = 0; i < n; i++) {
      var s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buf], { type: "audio/wav" });
  }

  function resampleLinear(input, fromRate, toRate) {
    if (fromRate === toRate) return input;
    var ratio = fromRate / toRate;
    var outLen = Math.round(input.length / ratio);
    var output = new Float32Array(outLen);
    for (var i = 0; i < outLen; i++) {
      var srcIdx = i * ratio;
      var idx0 = Math.floor(srcIdx);
      var idx1 = Math.min(idx0 + 1, input.length - 1);
      var frac = srcIdx - idx0;
      output[i] = input[idx0] * (1 - frac) + input[idx1] * frac;
    }
    return output;
  }

  function mergeBuffers(buffers) {
    var total = 0;
    for (var i = 0; i < buffers.length; i++) total += buffers[i].length;
    var result = new Float32Array(total);
    var off = 0;
    for (var j = 0; j < buffers.length; j++) { result.set(buffers[j], off); off += buffers[j].length; }
    return result;
  }

  // ── TTS：由 js/tts-one-mouth.js 串行编排；此处只负责拉流 / Audio / 回声标志 ─────────
  function stopPlaybackHardwareOnly() {
    if (currentTTSAudio) {
      currentTTSAudio.pause();
      currentTTSAudio.src = "";
      currentTTSAudio = null;
    }
    try {
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    } catch (_c) {}
    ttsPlaying = false;
    syncTtsGlobal();
  }

  /** 供队列编排器调用：开始一条服务端 TTS → Audio；失败则兜底 speechSynthesis */
  function playOneSentenceFromBackend(text, cbs) {
    text = text ? String(text).trim() : "";
    var cbEnd = cbs && typeof cbs.onEnd === "function" ? cbs.onEnd : null;
    var cbErr = cbs && typeof cbs.onError === "function" ? cbs.onError : null;

    if (!text) {
      try {
        if (cbEnd) cbEnd();
      } catch (_skip) {}
      return;
    }

    var finished = false;
    function terminate(ok) {
      if (finished) return;
      finished = true;
      ttsPlaying = false;
      syncTtsGlobal();
      try {
        if (ok) {
          if (cbEnd) cbEnd();
        } else if (cbErr) {
          cbErr();
        } else if (cbEnd) cbEnd();
      } catch (_eFinish) {}
    }

    ttsPlaying = true;
    syncTtsGlobal();

    fetch(BACKEND + "/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text }),
    })
      .then(function (resp) {
        if (resp.ok && (resp.headers.get("content-type") || "").includes("audio")) {
          return resp.blob();
        }
        return null;
      })
      .then(function (blob) {
        if (!blob) {
          if ("speechSynthesis" in window) {
            try {
              window.speechSynthesis.cancel();
              var u = new SpeechSynthesisUtterance(text);
              u.lang = "zh-CN";
              u.onend = function () {
                terminate(true);
              };
              u.onerror = function () {
                terminate(false);
              };
              window.speechSynthesis.speak(u);
            } catch (e2) {
              terminate(false);
            }
          } else {
            terminate(false);
          }
          return;
        }
        var url = URL.createObjectURL(blob);
        var a = new Audio(url);
        currentTTSAudio = a;
        a.onended = function () {
          URL.revokeObjectURL(url);
          currentTTSAudio = null;
          terminate(true);
        };
        a.onerror = function () {
          URL.revokeObjectURL(url);
          currentTTSAudio = null;
          terminate(false);
        };
        a.play().catch(function () {
          URL.revokeObjectURL(url);
          currentTTSAudio = null;
          terminate(false);
        });
      })
      .catch(function () {
        terminate(false);
      });
  }

  /** 语音识别抢话：清空队列并由 tts-one-mouth 静音 */
  function stopTTSForBargeIn() {
    if (window.CockpitTTS && CockpitTTS.abortFromUserBargeIn)
      CockpitTTS.abortFromUserBargeIn();
    else stopPlaybackHardwareOnly();
  }

  // ── action execution ────────────────────────────────────────────────
  function executeAction(msg) {
    var action = msg.action;
    var response = (msg.response || "").trim();
    var params = msg.params || {};

    if (action === "none") {
      updateVUI("ready");
      return;
    }
    if (action === "chat") {
      updateVUI("success", response || msg.text);
      var lineChat = response || msg.text;
      if (window.CockpitTTS && window.CockpitTTS.speak)
        window.CockpitTTS.speak(lineChat, { interrupt: true });
      else if (typeof window.speakTTS === "function")
        window.speakTTS(lineChat, { interrupt: true });
      setTimeout(function () {
        updateVUI("ready");
      }, 4000);
      return;
    }
    if (action === "unknown") {
      if (response) {
        if (window.CockpitTTS && window.CockpitTTS.speak)
          window.CockpitTTS.speak(response, { interrupt: true });
        else if (typeof window.speakTTS === "function")
          window.speakTTS(response, { interrupt: true });
      }
      updateVUI("error", response || "\u65E0\u6CD5\u8BC6\u522B\u6307\u4EE4");
      setTimeout(function () { updateVUI("ready"); }, 3000);
      return;
    }

    if (window.Cockpit && typeof window.Cockpit.handleIntent === "function") {
      window.Cockpit.handleIntent(
        action,
        params,
        response,
        (msg.text && String(msg.text).trim()) || ""
      );
      updateVUI("success", response || action);
    } else {
      updateVUI("error", "Cockpit \u672A\u52A0\u8F7D");
    }
    setTimeout(function () { updateVUI("ready"); }, 1500);
  }

  // ── ASR + intent pipeline ───────────────────────────────────────────
  async function processAudio(float32Samples, nativeSampleRate) {
    if (processing) return;
    processing = true;
    updateVUI("processing");

    try {
      var resampled = resampleLinear(float32Samples, nativeSampleRate, TARGET_SAMPLE_RATE);
      if (resampled.length < TARGET_SAMPLE_RATE * 0.2) {
        updateVUI("ready"); processing = false; return;
      }

      var wavBlob = float32ToWav16Mono(resampled, TARGET_SAMPLE_RATE);
      console.log("[Voice] Sending", (resampled.length / TARGET_SAMPLE_RATE).toFixed(1) + "s audio to /asr");

      var asrResp = await fetch(BACKEND + "/asr", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: wavBlob,
      });
      var asrData = await asrResp.json();
      if (!asrData.ok || !asrData.text) {
        console.log("[Voice] ASR empty:", asrData);
        updateVUI("ready"); processing = false; return;
      }

      var text = (asrData.text && String(asrData.text).trim()) || "";
      console.log("[Voice] ASR:", text);
      updateVUI("processing", text);

      var intentStart = Date.now();
      var intentResp = await fetch(BACKEND + "/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, context: getPageContext() }),
      });
      var intentData = await intentResp.json();
      var intentMs = Date.now() - intentStart;
      var tier = intentData.match === "fast" ? "FAST" : "LLM";
      console.log("[Voice] Intent (" + tier + ", " + intentMs + "ms):", intentData.action, intentData.response);
      var handledByVox = await tryVoxFallbackForIntent(text, intentData);
      if (handledByVox) {
        processing = false;
        return;
      }
      executeAction({ text: text, ...intentData });
    } catch (e) {
      console.error("[Voice] Pipeline error:", e);
      updateVUI("error", e.message);
      setTimeout(function () { updateVUI("ready"); }, 3000);
    }
    processing = false;
  }

  // ── adaptive VAD + audio capture ────────────────────────────────────
  function getSpeechThreshold() {
    return Math.max(SPEECH_THRESHOLD_MIN, noiseFloor * SPEECH_THRESHOLD_RATIO);
  }

  function getSpeechStartThreshold() {
    return Math.max(SPEECH_THRESHOLD_MIN, noiseFloor * SPEECH_START_THRESHOLD_RATIO);
  }

  async function startAudioCapture() {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    var nativeSR = audioCtx.sampleRate;
    console.log("[Voice] Native sample rate:", nativeSR);

    var source = audioCtx.createMediaStreamSource(mediaStream);
    var bufSize = 4096;
    scriptNode = audioCtx.createScriptProcessor(bufSize, 1, 1);

    // Reset state
    noiseFloor = NOISE_FLOOR_INIT;
    noiseFrameCount = 0;
    preBuffer = [];
    speechVoicedFrames = 0;
    speechConsecFrames = 0;
    speechStartThreshold = SPEECH_THRESHOLD_MIN;

    scriptNode.onaudioprocess = function (e) {
      if (!isActive) return;

      var input = e.inputBuffer.getChannelData(0);
      var rms = 0;
      for (var i = 0; i < input.length; i++) rms += input[i] * input[i];
      rms = Math.sqrt(rms / input.length);

      var now = Date.now();
      var threshold = getSpeechThreshold();
      var startThreshold = getSpeechStartThreshold();
      var isSpeechFrame = rms > threshold;

      // ── TTS echo suppression (hard block, only barge-in breaks through) ──
      if (ttsPlaying) {
        var bargeThreshold = Math.max(SPEECH_THRESHOLD_MIN * 2, noiseFloor * BARGE_IN_RATIO);
        if (rms > bargeThreshold) {
          console.log("[Voice] Barge-in detected, stopping TTS");
          stopTTSForBargeIn();
        } else {
          return;
        }
      }

      // ── Video echo suppression (adaptive: track video audio level) ──
      if (videoPlaying) {
        videoNoiseLevel = videoNoiseLevel * (1 - VIDEO_NOISE_ALPHA) + rms * VIDEO_NOISE_ALPHA;
        var videoThreshold = Math.max(threshold, videoNoiseLevel * VIDEO_SPEECH_RATIO);
        isSpeechFrame = rms > videoThreshold;
      }

      // ── During processing, skip VAD ──
      if (processing) return;

      // ── Noise floor tracking (only during silence) ──
      if (!isSpeechFrame && !isSpeaking) {
        noiseFrameCount++;
        if (noiseFrameCount > 10) {
          // Stable silence — update noise floor with EMA
          noiseFloor = noiseFloor * (1 - NOISE_FLOOR_ALPHA) + rms * NOISE_FLOOR_ALPHA;
          // Clamp to reasonable range
          noiseFloor = Math.max(0.001, Math.min(0.05, noiseFloor));
        }

        // Maintain pre-speech ring buffer
        preBuffer.push(new Float32Array(input));
        if (preBuffer.length > PRE_BUFFER_FRAMES) preBuffer.shift();
        speechConsecFrames = 0;
        return;
      }

      if (isSpeechFrame) {
        noiseFrameCount = 0;
        speechConsecFrames++;

        if (!isSpeaking) {
          // Enter speech mode only if voice is clearly above ambient noise
          // for continuous frames. This suppresses keyboard/AC short bursts.
          if (!(rms > startThreshold && speechConsecFrames >= START_CONSEC_FRAMES)) {
            preBuffer.push(new Float32Array(input));
            if (preBuffer.length > PRE_BUFFER_FRAMES) preBuffer.shift();
            return;
          }
          isSpeaking = true;
          speechStart = now;
          speechVoicedFrames = 0;
          speechStartThreshold = startThreshold;
          // Prepend pre-buffer so we don't clip the start of speech
          speechBuffer = preBuffer.slice();
          preBuffer = [];
          updateVUI("listening");
        }
        lastSpeechTime = now;
        speechVoicedFrames++;
        speechBuffer.push(new Float32Array(input));
      } else if (isSpeaking) {
        speechConsecFrames = 0;
        speechBuffer.push(new Float32Array(input));
        var speechDuration = now - speechStart;

        if (now - lastSpeechTime > SILENCE_DURATION_MS && speechDuration > MIN_SPEECH_DURATION_MS) {
          isSpeaking = false;
          var merged = mergeBuffers(speechBuffer);
          var voicedFrames = speechVoicedFrames;
          var isValidSpeech = voicedFrames >= MIN_VOICED_FRAMES;
          speechBuffer = [];
          preBuffer = [];
          speechVoicedFrames = 0;
          if (isValidSpeech) {
            processAudio(merged, nativeSR);
          } else {
            console.log("[Voice] Drop noisy burst (voicedFrames=" + voicedFrames + ")");
            updateVUI("ready");
          }
        } else if (speechDuration > MAX_SPEECH_DURATION_MS) {
          isSpeaking = false;
          var merged2 = mergeBuffers(speechBuffer);
          var isValidSpeech2 = speechVoicedFrames >= MIN_VOICED_FRAMES;
          speechBuffer = [];
          preBuffer = [];
          speechVoicedFrames = 0;
          if (isValidSpeech2) processAudio(merged2, nativeSR);
          else updateVUI("ready");
        }
      }
    };

    source.connect(scriptNode);
    scriptNode.connect(audioCtx.destination);
    console.log(
      "[Voice] Audio capture started (adaptive VAD, start=" +
        getSpeechStartThreshold().toFixed(4) +
        ", keep=" +
        getSpeechThreshold().toFixed(4) +
        ")"
    );
  }

  function stopAudioCapture() {
    if (scriptNode) { scriptNode.disconnect(); scriptNode = null; }
    if (mediaStream) { mediaStream.getTracks().forEach(function (t) { t.stop(); }); mediaStream = null; }
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
    speechBuffer = [];
    preBuffer = [];
    speechVoicedFrames = 0;
    speechConsecFrames = 0;
    isSpeaking = false;
    var wasStreamingHtmlTts = !!currentTTSAudio;
    stopPlaybackHardwareOnly();
    if (
      wasStreamingHtmlTts &&
      window.CockpitTTS &&
      typeof window.CockpitTTS.notifyDeviceStoppedExternally === "function"
    ) {
      window.CockpitTTS.notifyDeviceStoppedExternally();
    }
  }

  // ── public API ──────────────────────────────────────────────────────
  async function start() {
    if (isActive) return;
    isActive = true;
    updateVUI("connecting");
    try {
      await startAudioCapture();
      updateVUI("ready");
    } catch (err) {
      console.error("[Voice] Start failed:", err);
      updateVUI("error", err.message);
      isActive = false;
    }
  }

  function stop() {
    isActive = false;
    stopAudioCapture();
    updateVUI("idle");
  }

  function toggle() { if (isActive) stop(); else start(); }

  // ── health check ────────────────────────────────────────────────────
  async function checkBackend() {
    try {
      var resp = await fetch(BACKEND + "/health");
      var data = await resp.json();
      console.log("[Voice] Backend:", data);
      if (!data.llm_available) console.warn("[Voice] LLM keys missing — only keyword fast-match works.");
      return data.status === "ok" && data.asr_available;
    } catch (e) {
      console.warn("[Voice] Backend unreachable:", e.message);
      return false;
    }
  }

  // ── Music + video playback echo (media elements) ────────────────────
  function syncMediaEchoFlag() {
    var m = document.getElementById("cockpitMusic");
    var v = document.getElementById("cockpitVideo");
    var musicActive = !!(m && !m.paused && (m.currentSrc || m.src));
    var videoActive = !!(v && !v.paused && (v.currentSrc || v.src));
    videoPlaying = musicActive || videoActive;
    if (videoPlaying) videoNoiseLevel = noiseFloor;
    else videoNoiseLevel = 0;
  }

  function watchCockpitMediaEcho() {
    function wire(el) {
      if (!el) return;
      el.addEventListener("playing", syncMediaEchoFlag);
      el.addEventListener("pause", syncMediaEchoFlag);
      el.addEventListener("ended", syncMediaEchoFlag);
      el.addEventListener("emptied", syncMediaEchoFlag);
    }
    wire(document.getElementById("cockpitMusic"));
    wire(document.getElementById("cockpitVideo"));
    syncMediaEchoFlag();
  }

  // ── init ────────────────────────────────────────────────────────────
  function init() {
    console.log("[Voice] v5 — adaptive VAD + video/TTS echo suppression");
    syncTtsGlobal();

    var micCore = $("vuiMicCore");
    if (micCore) {
      micCore.style.cursor = "pointer";
      micCore.addEventListener("click", function (e) { e.stopPropagation(); toggle(); });
    }

    var container = $("vuiContainer");
    if (container) { container.addEventListener("click", function () { toggle(); }); }

    watchCockpitMediaEcho();

    updateVUI("idle");

    checkBackend().then(function (ok) {
      if (ok) { setTimeout(function () { start(); }, 1000); }
      else { updateVUI("error", "\u540E\u7AEF\u672A\u5C31\u7EEA (ASR)"); }
    });
  }

  if (
    window.CockpitTTS &&
    typeof window.CockpitTTS.registerPlaybackHook === "function"
  ) {
    window.CockpitTTS.registerPlaybackHook(
      playOneSentenceFromBackend,
      stopPlaybackHardwareOnly
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { setTimeout(init, 500); });
  } else {
    setTimeout(init, 500);
  }

  window.VoiceController = { start: start, stop: stop, toggle: toggle, sendContextUpdate: function () {} };
})();
