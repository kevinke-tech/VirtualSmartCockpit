/**
 * VOX panel integration for cockpit.
 * - Text prompt -> vox /plan
 * - Health ping -> vox /health
 * - Speak result via single TTS queue (CockpitTTS / speakTTS)
 */
(function () {
  "use strict";

  var STORAGE_KEY = "cockpit_vox_backend";
  var DEFAULT_BACKEND = "http://127.0.0.1:5001";

  function $(id) {
    return document.getElementById(id);
  }

  var card = $("voxCard");
  if (!card) return;

  var statusEl = $("voxStatus");
  var backendInput = $("voxBackendInput");
  var backendSaveBtn = $("voxBackendSaveBtn");
  var logEl = $("voxLog");
  var formEl = $("voxPromptForm");
  var inputEl = $("voxPromptInput");
  var quickBtns = card.querySelectorAll(".vox-quick-btn");

  var state = {
    backend: DEFAULT_BACKEND,
    busy: false,
    cockpitIntentUrl: "/intent",
    outputWs: null,
    framesWs: null,
    frameTimer: null,
    framesRequired: false,
    wsConnected: false,
    cameraWarned: false,
  };

  function nowLabel() {
    return new Date().toLocaleTimeString();
  }

  function setStatus(kind, text) {
    if (!statusEl) return;
    statusEl.className = "vox-status-pill vox-status-pill--" + kind;
    statusEl.textContent = text;
  }

  function appendLog(who, text) {
    if (!logEl) return;
    var row = document.createElement("div");
    row.className = "vox-log__row vox-log__row--" + who;
    var stamp = document.createElement("span");
    stamp.className = "vox-log__stamp";
    stamp.textContent = nowLabel();
    var role = document.createElement("strong");
    role.className = "vox-log__role";
    role.textContent = who === "user" ? "你" : "VOX";
    var body = document.createElement("span");
    body.className = "vox-log__text";
    body.textContent = text;
    row.appendChild(stamp);
    row.appendChild(role);
    row.appendChild(body);
    logEl.appendChild(row);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function normalizeBackend(raw) {
    return String(raw || "")
      .trim()
      .replace(/\/+$/, "");
  }

  function getSpeakFn() {
    if (window.CockpitTTS && typeof window.CockpitTTS.speak === "function")
      return window.CockpitTTS.speak.bind(window.CockpitTTS);
    if (typeof window.speakTTS === "function") return window.speakTTS;
    return null;
  }

  function backendToWsBase(url) {
    return normalizeBackend(url || "").replace(/^http/i, "ws");
  }

  function getCameraVideoEl() {
    var dms = $("dmsCam");
    if (dms && dms.videoWidth > 0) return dms;
    var scenic = $("camPreview");
    if (scenic && scenic.videoWidth > 0) return scenic;
    return dms || scenic || null;
  }

  function captureFrameB64() {
    return new Promise(function (resolve) {
      var video = getCameraVideoEl();
      if (!video || !video.videoWidth) {
        resolve(null);
        return;
      }
      var vw = video.videoWidth;
      var vh = video.videoHeight;
      var maxDim = 640;
      var scale = Math.min(1, maxDim / Math.max(vw, vh));
      var w = Math.max(2, Math.round(vw * scale));
      var h = Math.max(2, Math.round(vh * scale));
      var c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      var ctx = c.getContext("2d");
      if (!ctx) {
        resolve(null);
        return;
      }
      ctx.drawImage(video, 0, 0, w, h);
      c.toBlob(
        function (blob) {
          if (!blob) {
            resolve(null);
            return;
          }
          var r = new FileReader();
          r.onload = function () {
            var s = String(r.result || "");
            var parts = s.split(",");
            resolve(parts.length > 1 ? parts[1] : null);
          };
          r.onerror = function () {
            resolve(null);
          };
          r.readAsDataURL(blob);
        },
        "image/jpeg",
        0.62
      );
    });
  }

  function closeFramesStream() {
    if (state.frameTimer) {
      clearInterval(state.frameTimer);
      state.frameTimer = null;
    }
    if (state.framesWs) {
      try {
        state.framesWs.close();
      } catch (_e1) {}
      state.framesWs = null;
    }
  }

  function closeOutputSocket() {
    if (state.outputWs) {
      try {
        state.outputWs.close();
      } catch (_e2) {}
      state.outputWs = null;
    }
    state.wsConnected = false;
  }

  async function pushFrameOnce() {
    if (!state.framesWs || state.framesWs.readyState !== WebSocket.OPEN) return;
    var b64 = await captureFrameB64();
    if (!b64) {
      if (!state.cameraWarned) {
        state.cameraWarned = true;
        appendLog("agent", "[vox] 相机未就绪：请允许摄像头权限，并确保 DMS/景观相机画面在动");
      }
      return;
    }
    state.cameraWarned = false;
    try {
      state.framesWs.send(JSON.stringify({ type: "frame", image_b64: b64 }));
    } catch (_e3) {}
  }

  function ensureFramesStream() {
    if (!state.framesRequired) return;
    if (state.framesWs && state.framesWs.readyState === WebSocket.OPEN) return;
    var wsUrl = backendToWsBase(state.backend) + "/ws/frames";
    try {
      var ws = new WebSocket(wsUrl);
      state.framesWs = ws;
      ws.onopen = function () {
        appendLog("agent", "[vox] 已连接视觉帧通道 /ws/frames（1fps）");
        if (!state.frameTimer) {
          state.frameTimer = setInterval(pushFrameOnce, 1000);
        }
      };
      ws.onclose = function () {
        if (state.frameTimer) {
          clearInterval(state.frameTimer);
          state.frameTimer = null;
        }
        state.framesWs = null;
        appendLog("agent", "[vox] 视觉帧通道断开");
      };
      ws.onerror = function () {
        appendLog("agent", "[vox] ws/frames 连接失败");
      };
    } catch (_e4) {}
  }

  function openOutputSocket() {
    closeOutputSocket();
    closeFramesStream();
    var wsUrl = backendToWsBase(state.backend) + "/ws/output";
    try {
      var ws = new WebSocket(wsUrl);
      state.outputWs = ws;
      ws.onopen = function () {
        state.wsConnected = true;
        appendLog("agent", "[vox] 已连接事件推送 /ws/output");
        refreshHealth();
      };
      ws.onmessage = function (e) {
        var msg = null;
        try {
          msg = JSON.parse(e.data);
        } catch (_ej) {
          return;
        }
        if (!msg || !msg.type) return;
        if (msg.type === "hello") {
          state.framesRequired = !!msg.frames_required;
          appendLog(
            "agent",
            "[vox] hello: active=" +
              (msg.active_background || 0) +
              ", frames_required=" +
              state.framesRequired
          );
          if (state.framesRequired) ensureFramesStream();
          else closeFramesStream();
          return;
        }
        if (msg.type === "frames_required") {
          state.framesRequired = !!msg.value;
          appendLog(
            "agent",
            "[vox] frames_required -> " + (state.framesRequired ? "ON" : "OFF")
          );
          if (state.framesRequired) ensureFramesStream();
          else closeFramesStream();
          return;
        }
        if (msg.type === "speak" && msg.text) {
          appendLog("agent", "🔔 " + String(msg.text));
          var say = getSpeakFn();
          if (say) say(String(msg.text), { interrupt: true });
        }
      };
      ws.onclose = function () {
        state.wsConnected = false;
        appendLog("agent", "[vox] 事件推送断开，3秒后重连");
        state.outputWs = null;
        closeFramesStream();
        setTimeout(function () {
          if (state.backend) openOutputSocket();
        }, 3000);
      };
      ws.onerror = function () {
        appendLog("agent", "[vox] ws/output 连接失败（检查 5001 端口与浏览器网络）");
      };
    } catch (_e5) {}
  }

  async function fetchJson(path, payload, timeoutMs) {
    var controller = new AbortController();
    var timer = setTimeout(function () {
      controller.abort();
    }, timeoutMs || 15000);
    try {
      var resp = await fetch(state.backend + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload || {}),
        signal: controller.signal,
      });
      var data = await resp.json().catch(function () {
        return null;
      });
      if (!resp.ok) {
        throw new Error((data && data.error) || (path + " " + resp.status));
      }
      return data || {};
    } finally {
      clearTimeout(timer);
    }
  }

  async function refreshHealth() {
    try {
      var resp = await fetch(state.backend + "/health", { method: "GET" });
      if (!resp.ok) throw new Error("health " + resp.status);
      var data = await resp.json();
      var skills = Array.isArray(data.skills) ? data.skills.length : 0;
      var watchers = data.active_background || 0;
      var vision = data.vision_watchers || 0;
      var wsTag = state.wsConnected ? "WS连通" : "WS未连";
      setStatus(
        "ok",
        "在线 · 技能 " + skills + " · 后台 " + watchers + " · 视觉 " + vision + " · " + wsTag
      );
      if (vision > 0) {
        state.framesRequired = true;
        ensureFramesStream();
      } else if (!state.framesRequired) {
        closeFramesStream();
      }
    } catch (_e) {
      state.wsConnected = false;
      setStatus("idle", "未连接");
    }
  }

  async function runPlanPrompt(text) {
    if (!text || state.busy) return;
    state.busy = true;
    appendLog("user", text);
    setStatus("busy", "处理中");
    if (backendSaveBtn) backendSaveBtn.disabled = true;

    try {
      var reused = await tryHandleByCockpitIntent(text);
      if (reused) {
        await refreshHealth();
        return;
      }

      var plan = await fetchJson(
        "/plan",
        {
          transcript: text,
          image_b64: null,
          context: {
            source: "virtual-smart-cockpit",
            lane: window.Cockpit && window.Cockpit.state ? window.Cockpit.state.lane : null,
          },
        },
        90000
      );
      var kind = plan.kind || "unknown";
      var render = plan.render ? String(plan.render) : "";
      var speak = plan.speak ? String(plan.speak) : "";
      appendLog("agent", "[" + kind + "] " + (render || speak || "无返回内容"));
      if (speak) {
        var say = getSpeakFn();
        if (say) say(speak, {});
      }
      await refreshHealth();
    } catch (e) {
      appendLog("agent", "[error] " + (e && e.message ? e.message : "请求失败"));
      setStatus("error", "请求失败");
    } finally {
      state.busy = false;
      if (backendSaveBtn) backendSaveBtn.disabled = false;
    }
  }

  function getCockpitVoiceContext() {
    if (window.Cockpit && typeof window.Cockpit.getVoiceContext === "function") {
      try {
        return window.Cockpit.getVoiceContext() || {};
      } catch (_e) {}
    }
    return {};
  }

  function actionCanReuseCockpitUi(action) {
    if (!action) return false;
    if (action === "none" || action === "unknown" || action === "chat") return false;
    return true;
  }

  async function tryHandleByCockpitIntent(text) {
    if (!window.Cockpit || typeof window.Cockpit.handleIntent !== "function") return false;
    try {
      var resp = await fetch(state.cockpitIntentUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          context: getCockpitVoiceContext(),
        }),
      });
      if (!resp.ok) return false;
      var it = await resp.json().catch(function () {
        return null;
      });
      if (!it) return false;
      var action = (it.action || "").trim();
      if (!actionCanReuseCockpitUi(action)) return false;
      var params = it.params || {};
      var response = it.response || "";
      appendLog(
        "agent",
        "[cockpit] 复用现有页面能力 -> " + action + (response ? " | " + response : "")
      );
      window.Cockpit.handleIntent(action, params, response, text);
      setStatus("ok", "已复用座舱能力");
      return true;
    } catch (_e) {
      return false;
    }
  }

  function saveBackend() {
    var url = normalizeBackend(backendInput && backendInput.value);
    if (!url) return;
    state.backend = url;
    try {
      localStorage.setItem(STORAGE_KEY, state.backend);
    } catch (_e) {}
    appendLog("agent", "已连接到 " + state.backend);
    refreshHealth();
    openOutputSocket();
  }

  function bindEvents() {
    if (backendSaveBtn) {
      backendSaveBtn.addEventListener("click", saveBackend);
    }
    if (backendInput) {
      backendInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          saveBackend();
        }
      });
    }
    if (formEl && inputEl) {
      formEl.addEventListener("submit", function (e) {
        e.preventDefault();
        var text = String(inputEl.value || "").trim();
        if (!text) return;
        inputEl.value = "";
        runPlanPrompt(text);
      });
    }
    quickBtns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var prompt = btn.getAttribute("data-vox-prompt") || "";
        if (!prompt) return;
        runPlanPrompt(prompt);
      });
    });
  }

  function init() {
    var cached = "";
    try {
      cached = localStorage.getItem(STORAGE_KEY) || "";
    } catch (_e) {}
    state.backend = normalizeBackend(cached || DEFAULT_BACKEND);
    if (backendInput) backendInput.value = state.backend;
    setStatus("idle", "连接中");
    bindEvents();
    appendLog("agent", "VOX 面板就绪：可直接下达任务，未命中技能时会触发动态构造。");
    refreshHealth();
    openOutputSocket();
    setInterval(refreshHealth, 15000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

