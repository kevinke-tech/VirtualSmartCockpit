/**
 * 座舱 DMS：摄像头在主线程采集；MediaPipe Face Landmarker 在独立 Web Worker
 * （js/fatigue-dms-worker.js）中推理，与其它 UI/语音/WebGL 任务并行。
 * 若不支持 module Worker 则回退主线程推理（单线程）。
 */
(function () {
  "use strict";

  /** 持续闭眼告警：略长以降低正常眨眼 / 误判导致的频繁报警 */
  var CLOSE_MS = 1650;
  /** 睁眼持续多久才清空闭眼累计（短时睁眼更容易打断误报的“长闭眼”计时） */
  var OPEN_RESET_MS = 620;
  var COOLDOWN_MS = 5200;

  var PHRASES = [
    "喂喂喂！你干嘛闭目养神！很危险哪。",
    "注意看路，别打瞌睡，疲劳驾驶很危险。",
    "检测到闭眼时间较长，请打起精神，集中注意力开车。",
  ];

  var WASM_CDN =
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
  var MODEL_URL =
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task";

  var closureStart = 0;
  var lastAlertAt = 0;
  var dismissUntil = 0;
  var rafId = 0;
  var bootAt = 0;
  var clearClosureAt = 0;

  /** Worker 模式下：一单飞，避免在主线程队列堆积 Bitmap */
  var inferPending = false;
  var running = false;
  var bootInProgress = false;

  /** 主线程回退时使用 */
  var landmarkerLegacy = null;

  function $(id) {
    return document.getElementById(id);
  }

  function pickPhrase() {
    return PHRASES[Math.floor(Math.random() * PHRASES.length)];
  }

  function resolveWorkerScriptUrl() {
    var scripts = document.getElementsByTagName("script");
    var i;
    var idx;
    var src = "";
    for (i = scripts.length - 1; i >= 0; i--) {
      src = scripts[i].src || "";
      idx = src.indexOf("fatigue-dms.js");
      if (idx !== -1) {
        return src.slice(0, idx) + "fatigue-dms-worker.js";
      }
    }
    return "js/fatigue-dms-worker.js";
  }

  /* ── 主线程推理（fallback）用到的分类逻辑，与工作线程算法保持一致 ── */

  function readBlinkScores(result) {
    var out = { L: 0, R: 0 };
    if (!result || !result.faceBlendshapes || !result.faceBlendshapes.length) {
      return out;
    }
    var cats = result.faceBlendshapes[0].categories;
    if (!cats) return out;
    var i;
    for (i = 0; i < cats.length; i++) {
      var c = cats[i];
      var raw = String(c.categoryName || c.displayName || "");
      var n = raw.toLowerCase().replace(/\s+/g, "");
      var s = typeof c.score === "number" ? c.score : 0;
      if (
        (n.indexOf("eyeblink") !== -1 &&
          n.indexOf("left") !== -1 &&
          n.indexOf("right") === -1) ||
        n === "eyeblinkleft"
      )
        out.L = Math.max(out.L, s);
      if (
        (n.indexOf("eyeblink") !== -1 && n.indexOf("right") !== -1) ||
        n === "eyeblinkright"
      )
        out.R = Math.max(out.R, s);
    }
    return out;
  }

  var BLINK_AVG_CLOSED = 0.28;
  var BLINK_MIN_EACH = 0.14;
  var BLINK_HARD = 0.42;
  var BLINK_ONE_EYE_STRONG = 0.48;
  var EAR_MEAN_MAX = 0.27;
  var EAR_SINGLE_MIN = 0.16;

  function eyesClosedFromBlend(L, R) {
    var avg = (L + R) * 0.5;
    var mx = Math.max(L, R);
    var mn = Math.min(L, R);
    if (L >= BLINK_HARD && R >= BLINK_HARD) return true;
    if (mx >= BLINK_ONE_EYE_STRONG && mn >= 0.12) return true;
    if (avg >= BLINK_AVG_CLOSED && L >= BLINK_MIN_EACH && R >= BLINK_MIN_EACH) {
      return true;
    }
    if (avg >= BLINK_AVG_CLOSED + 0.1 && mn >= 0.08) return true;
    if (avg >= 0.26 && mn >= 0.1) return true;
    return false;
  }

  function earFromLandmarks(lm, eyeOuter, eyeInner, upper, lower) {
    if (!lm || !lm[eyeOuter] || !lm[eyeInner]) return 0.35;
    var vx = lm[eyeOuter].x - lm[eyeInner].x;
    var vy = lm[eyeOuter].y - lm[eyeInner].y;
    var h = Math.sqrt(vx * vx + vy * vy) + 1e-6;
    var uy = Math.abs(lm[upper].y - lm[lower].y);
    return uy / h;
  }

  function readEarStats(result) {
    if (!result.faceLandmarks || !result.faceLandmarks.length) return null;
    var lm = result.faceLandmarks[0];
    var l1 = earFromLandmarks(lm, 33, 133, 159, 145);
    var l2 = earFromLandmarks(lm, 33, 133, 158, 153);
    var r1 = earFromLandmarks(lm, 362, 263, 386, 374);
    var r2 = earFromLandmarks(lm, 362, 263, 385, 380);
    var leftEar = Math.min(l1, l2);
    var rightEar = Math.min(r1, r2);
    return {
      mean: (leftEar + rightEar) * 0.5,
      min: Math.min(leftEar, rightEar),
      left: leftEar,
      right: rightEar,
    };
  }

  /** 闭眼状态机（主线程时钟） */
  function applyClosureSample(hasFace, eyesClosedLikely) {
    if (window.__cockpitDmsEnabled === false) {
      closureStart = 0;
      clearClosureAt = 0;
      return;
    }

    var now = performance.now();

    if (window.__cockpitTtsPlaying) {
      closureStart = 0;
      clearClosureAt = 0;
      return;
    }

    if (!hasFace) {
      closureStart = 0;
      clearClosureAt = 0;
    } else if (eyesClosedLikely) {
      clearClosureAt = 0;
      if (!closureStart) closureStart = now;
      if (now - closureStart >= CLOSE_MS) {
        triggerAlert();
        closureStart = 0;
      }
    } else {
      if (!clearClosureAt) clearClosureAt = now;
      if (now - clearClosureAt >= OPEN_RESET_MS) {
        closureStart = 0;
        clearClosureAt = 0;
      }
    }
  }

  function showFatigueOverlay() {
    var panel = $("panelFatigue");
    if (!panel) return;
    panel.classList.remove("hidden");
    var auto = setTimeout(function () {
      hideFatigueOverlay();
    }, 8800);
    panel._fatigueAuto = auto;
  }

  function hideFatigueOverlay() {
    var panel = $("panelFatigue");
    if (!panel) return;
    if (panel._fatigueAuto) {
      clearTimeout(panel._fatigueAuto);
      panel._fatigueAuto = 0;
    }
    panel.classList.add("hidden");
  }

  function triggerAlert() {
    if (window.__cockpitDmsEnabled === false) return;
    var now = performance.now();
    if (now < dismissUntil) return;
    if (now - lastAlertAt < COOLDOWN_MS) return;

    lastAlertAt = now;
    var msg = pickPhrase();
    showFatigueOverlay();
    if (typeof window.speakTTS === "function") window.speakTTS(msg);

    var toast = $("toastLine");
    if (toast) toast.textContent = "疲劳驾驶提醒 · " + msg;
  }

  function bindCloseButton() {
    var btn = $("btnFatigueClose");
    if (btn && !btn._dmsBound) {
      btn._dmsBound = true;
      btn.addEventListener("click", function () {
        dismissUntil = 0;
        /** 放行下一次告警计时（避免因 COOLDOWN_MS 误判为仍在冷却）；仍需重新累计闭眼 CLOSE_MS */
        lastAlertAt = performance.now() - COOLDOWN_MS - 10;
        hideFatigueOverlay();
      });
    }
  }

  /** Worker：RAF + 一单飞抓取 ImageBitmap → postMessage(transferable) */
  function startWorkerPump(worker, video) {
    running = true;
    inferPending = false;
    var videoTs = 0;

    worker.addEventListener("message", function onWorkerResult(ev) {
      var d = ev.data || {};
      if (d.type !== "result") return;
      inferPending = false;
      applyClosureSample(!!d.hasFace, !!d.eyesClosedLikely);
      if (d.error) console.warn("[DMS] worker inference:", d.error);
    });

    function tick() {
      if (!running) return;
      var now = performance.now();

      if (now - bootAt < 400) {
        rafId = requestAnimationFrame(tick);
        return;
      }

      if (window.__cockpitDmsEnabled === false) {
        inferPending = false;
        closureStart = 0;
        clearClosureAt = 0;
        rafId = requestAnimationFrame(tick);
        return;
      }

      if (inferPending) {
        rafId = requestAnimationFrame(tick);
        return;
      }

      inferPending = true;
      createImageBitmap(video)
        .then(function (bmp) {
          videoTs += 33;
          worker.postMessage(
            { type: "frame", bitmap: bmp, ts: videoTs },
            [bmp]
          );
        })
        .catch(function () {
          inferPending = false;
        });

      rafId = requestAnimationFrame(tick);
    }

    rafId = requestAnimationFrame(tick);

    console.log(
      "[DMS] Worker 并行推理 ↑ 主线程仅抓帧 + 告警状态机；闭眼累计 ≥ " +
        CLOSE_MS +
        " ms"
    );
  }

  function stopPump() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    inferPending = false;
  }

  /**
   * 在 Worker 收到 init-done 且已启动 RAF 泵（或回退 legacy）之后 resolve，
   * 以便 boot() 能正确串联互斥逻辑。
   */
  function bootWithWorker(workerUrl, video) {
    return new Promise(function (resolve) {
      var settled = false;
      function settle() {
        if (settled) return;
        settled = true;
        resolve();
      }

      bindCloseButton();

      var worker;
      try {
        worker = new Worker(workerUrl, { type: "module" });
      } catch (eCtor) {
        bootLegacyMain(video).then(settle).catch(settle);
        return;
      }

      worker.addEventListener("message", function onInit(ev) {
        var d = ev.data || {};
        if (d.type !== "init-done") return;
        worker.removeEventListener("message", onInit);
        if (!d.ok) {
          worker.terminate();
          console.warn("[DMS] Worker init 失败，回退主线程:", d.error);
          bootLegacyMain(video).then(settle).catch(settle);
          return;
        }
        startWorkerPump(worker, video);
        settle();
      });

      worker.postMessage({
        type: "init",
        wasmPath: WASM_CDN,
        modelUrl: MODEL_URL,
        gpuFirst: true,
      });

      worker.addEventListener("error", function (e) {
        console.warn("[DMS] Worker runtime error:", (e && e.message) || e);
        try {
          worker.terminate();
        } catch (termErr) {}
        bootLegacyMain(video).then(settle).catch(settle);
      });
    });
  }

  /** ── Fallback：整块推理在主线程（与旧行为一致）── */

  function loopLegacy(video) {
    var now = performance.now();

    if (now - bootAt < 400) {
      rafId = requestAnimationFrame(function () {
        loopLegacy(video);
      });
      return;
    }

    if (!landmarkerLegacy) {
      rafId = requestAnimationFrame(function () {
        loopLegacy(video);
      });
      return;
    }

    if (window.__cockpitTtsPlaying) {
      closureStart = 0;
      clearClosureAt = 0;
      rafId = requestAnimationFrame(function () {
        loopLegacy(video);
      });
      return;
    }

    if (window.__cockpitDmsEnabled === false) {
      closureStart = 0;
      clearClosureAt = 0;
      rafId = requestAnimationFrame(function () {
        loopLegacy(video);
      });
      return;
    }

    var result = landmarkerLegacy.detectForVideo(video, now);
    var hasFace = !!(result.faceLandmarks && result.faceLandmarks.length);
    var sc = readBlinkScores(result);
    var ear = hasFace ? readEarStats(result) : null;
    var blendClosed = eyesClosedFromBlend(sc.L, sc.R);
    var earClosed =
      ear && (ear.mean < EAR_MEAN_MAX || ear.min < EAR_SINGLE_MIN);
    var eyesClosedLikely = hasFace && (blendClosed || earClosed);
    applyClosureSample(hasFace, eyesClosedLikely);

    rafId = requestAnimationFrame(function () {
      loopLegacy(video);
    });
  }

  async function bootLegacyMain(video) {
    landmarkerLegacy = null;
    var FaceLandmarker;
    var FilesetResolver;
    try {
      var mod = await import(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm"
      );
      FaceLandmarker = mod.FaceLandmarker;
      FilesetResolver = mod.FilesetResolver;
    } catch (e) {
      console.warn("[DMS] MediaPipe 加载失败", e);
      return;
    }

    try {
      var filesetResolver = await FilesetResolver.forVisionTasks(WASM_CDN);
      landmarkerLegacy = await FaceLandmarker.createFromOptions(filesetResolver, {
        baseOptions: {
          modelAssetPath: MODEL_URL,
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numFaces: 1,
        outputFaceBlendshapes: true,
        minFaceDetectionConfidence: 0.34,
        minFacePresenceConfidence: 0.34,
      });
    } catch (e1) {
      console.warn("[DMS] GPU 初始化失败，改 CPU", e1);
      try {
        var fr = await FilesetResolver.forVisionTasks(WASM_CDN);
        landmarkerLegacy = await FaceLandmarker.createFromOptions(fr, {
          baseOptions: {
            modelAssetPath: MODEL_URL,
            delegate: "CPU",
          },
          runningMode: "VIDEO",
          numFaces: 1,
          outputFaceBlendshapes: true,
          minFaceDetectionConfidence: 0.34,
          minFacePresenceConfidence: 0.34,
        });
      } catch (e2) {
        console.warn("[DMS] FaceLandmarker 不可用", e2);
        return;
      }
    }

    bindCloseButton();
    running = true;
    loopLegacy(video);
    console.warn(
      "[DMS] 回退模式：人脸检测运行在主线程（未使用 Parallel Worker）。"
    );
  }

  async function boot() {
    if (running || bootInProgress) return;
    bootInProgress = true;
    bootAt = performance.now();
    stopPump();

    var video = $("dmsCam");
    try {
      if (!video || !navigator.mediaDevices) {
        console.warn("[DMS] 无摄像头 API");
        return;
      }

      var needStream = true;
      try {
        if (video.srcObject) {
          var tracks = video.srcObject.getTracks();
          needStream = !tracks.some(function (tr) {
            return tr.readyState === "live";
          });
        }
      } catch (eIgnore) {
        needStream = true;
      }

      if (needStream) {
        if (!navigator.mediaDevices.getUserMedia) {
          console.warn("[DMS] getUserMedia 不可用");
          return;
        }
        try {
          var stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: "user",
              width: { ideal: 640 },
              height: { ideal: 480 },
            },
            audio: false,
          });
          video.srcObject = stream;
          await video.play();
        } catch (e) {
          console.warn(
            "[DMS] 无法打开摄像头（座舱已占用摄像头时请走共享同一路 MediaStream）",
            e
          );
          return;
        }
      } else {
        await video.play().catch(function () {});
      }

      var workerJs = resolveWorkerScriptUrl();

      try {
        await bootWithWorker(workerJs, video);
      } catch (e0) {
        console.warn("[DMS] 无法创建 module Worker:", e0);
        await bootLegacyMain(video);
      }
    } finally {
      bootInProgress = false;
    }
  }

  window.__cockpitStartFatigueDms = function () {
    boot().catch(function (err) {
      console.warn("[DMS] boot 异常", err);
    });
  };

  /** 与座舱 state.dms.enabled 同步；关闭时立即停止闭眼累计并收起弹窗 */
  window.__cockpitSetDmsEnabled = function (on) {
    window.__cockpitDmsEnabled = !!on;
    if (!on) {
      closureStart = 0;
      clearClosureAt = 0;
      hideFatigueOverlay();
    }
  };

  window.__cockpitDmsEnabled = false;
})();
