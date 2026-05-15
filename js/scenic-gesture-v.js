/**
 * 风景打卡 · 「V / 剪刀手」手势触发拍照
 *
 * 算法方案：Google MediaPipe GestureRecognizer（@mediapipe/tasks-vision），与 DMS 同栈。
 * 模型内置手势含 Victory（✌），比自写「关键点夹角规则」更稳、省标注。
 * 备选方案简述：
 *   - MediaPipe Hands：用食指/中指伸展 + 其余弯曲的几何判定，可调但易误判；
 *   - TF.js 自定义小模型：需数据与训练，成本高。
 *
 * 运行策略：对 #camPreview 降频采样（~5fps）+ 连续帧确认 + 冷却，避免误触与占满主线程。
 */
(function () {
  "use strict";

  var WASM_CDN =
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
  var MODEL_URL =
    "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/latest/gesture_recognizer.task";

  /** 识别为 Victory 的最低分数 */
  var MIN_VICTORY_SCORE = 0.55;
  /** 连续命中帧数（与采样间隔相乘 ≈ 持继时间） */
  var STREAK_FRAMES = 5;
  /** 两次触发最短间隔 ms */
  var COOLDOWN_MS = 7000;
  /** 采样间隔 ms（约 5～6fps） */
  var SAMPLE_MS = 180;

  var recognizer = null;
  var initPromise = null;
  var lastSampleAt = 0;
  var streak = 0;
  var lastFireAt = 0;
  var rafId = 0;
  var started = false;

  function getTopVictoryScore(result) {
    if (!result || !result.gestures || !result.gestures.length) return 0;
    var i;
    for (i = 0; i < result.gestures.length; i++) {
      var handGest = result.gestures[i];
      if (!handGest || !handGest.length) continue;
      var top = handGest[0];
      var name = String(top.categoryName || top.displayName || "").toLowerCase();
      if (name === "victory" && typeof top.score === "number") {
        return top.score;
      }
    }
    return 0;
  }

  function fireScenicPhoto() {
    if (!window.Cockpit || typeof window.Cockpit.handleIntent !== "function") {
      return;
    }
    try {
      window.Cockpit.handleIntent(
        "scenic_take_photo",
        {},
        "识别到剪刀手，准备倒计时拍照"
      );
    } catch (e) {
      console.warn("[GestureV] handleIntent failed:", e);
    }
  }

  function loop() {
    rafId = 0;
    var now = performance.now();
    var v = document.getElementById("camPreview");
    if (!v || v.readyState < 2 || !v.videoWidth) {
      rafId = requestAnimationFrame(loop);
      return;
    }
    if (now - lastSampleAt < SAMPLE_MS) {
      rafId = requestAnimationFrame(loop);
      return;
    }
    lastSampleAt = now;

    if (!recognizer) {
      rafId = requestAnimationFrame(loop);
      return;
    }

    try {
      var ts = Math.round(now);
      var result = recognizer.recognizeForVideo(v, ts);
      var sc = getTopVictoryScore(result);
      if (sc >= MIN_VICTORY_SCORE) {
        streak++;
        if (
          streak >= STREAK_FRAMES &&
          now - lastFireAt >= COOLDOWN_MS
        ) {
          lastFireAt = now;
          streak = 0;
          fireScenicPhoto();
        }
      } else {
        streak = 0;
      }
    } catch (e) {
      console.warn("[GestureV] recognizeForVideo:", e);
      streak = 0;
    }

    rafId = requestAnimationFrame(loop);
  }

  function startLoop() {
    if (rafId) return;
    rafId = requestAnimationFrame(loop);
  }

  function stopLoop() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  async function bootRecognizer() {
    if (recognizer) return;
    if (initPromise) return initPromise;
    initPromise = (async function () {
      var mod = await import(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm"
      );
      var FilesetResolver = mod.FilesetResolver;
      var GestureRecognizer = mod.GestureRecognizer;
      var fr = await FilesetResolver.forVisionTasks(WASM_CDN);
      var opts = {
        baseOptions: {
          modelAssetPath: MODEL_URL,
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numHands: 2,
        minHandDetectionConfidence: 0.65,
        minHandPresenceConfidence: 0.65,
        minTrackingConfidence: 0.55,
      };
      try {
        recognizer = await GestureRecognizer.createFromOptions(fr, opts);
      } catch (e1) {
        console.warn("[GestureV] GPU 初始化失败，改用 CPU", e1);
        opts.baseOptions.delegate = "CPU";
        recognizer = await GestureRecognizer.createFromOptions(fr, opts);
      }
      console.log(
        "[GestureV] GestureRecognizer 就绪，对着车内摄像头比 ✌（Victory）可触发风景打卡倒计时"
      );
    })();
    return initPromise;
  }

  function start() {
    if (started) return;
    started = true;
    bootRecognizer()
      .then(function () {
        startLoop();
      })
      .catch(function (e) {
        console.warn("[GestureV] 手势模型未加载，剪刀手打卡不可用:", e);
        started = false;
      });
  }

  /** 页面可见且摄像头已就绪后再跑，减轻无效推理 */
  function onVisibility() {
    if (document.hidden) {
      stopLoop();
    } else {
      start();
      startLoop();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      start();
      document.addEventListener("visibilitychange", onVisibility);
    });
  } else {
    start();
    document.addEventListener("visibilitychange", onVisibility);
  }
})();
