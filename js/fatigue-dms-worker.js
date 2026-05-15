/**
 * DMS Face Landmarker：在独立 Web Worker 中运行 MediaPipe 推理，
 * 与主线程上的语音 UI、THREE 路况等并行（浏览器真多线程）。
 */
import {
  FaceLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm";

var BLINK_AVG_CLOSED = 0.28;
var BLINK_MIN_EACH = 0.14;
var BLINK_HARD = 0.42;
var BLINK_ONE_EYE_STRONG = 0.48;
var EAR_MEAN_MAX = 0.27;
var EAR_SINGLE_MIN = 0.16;

var landmarker = null;

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

function classifyEyesClosed(result) {
  var hasFace = !!(result.faceLandmarks && result.faceLandmarks.length);
  var sc = readBlinkScores(result);
  var ear = hasFace ? readEarStats(result) : null;
  var blendClosed = eyesClosedFromBlend(sc.L, sc.R);
  var earClosed =
    ear && (ear.mean < EAR_MEAN_MAX || ear.min < EAR_SINGLE_MIN);
  var eyesClosedLikely = hasFace && (blendClosed || earClosed);
  return { hasFace: hasFace, eyesClosedLikely: eyesClosedLikely };
}

async function createLandmarker(wasmPath, modelUrl, gpuFirst) {
  var filesetResolver = await FilesetResolver.forVisionTasks(wasmPath);
  if (gpuFirst) {
    try {
      landmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
        baseOptions: { modelAssetPath: modelUrl, delegate: "GPU" },
        runningMode: "VIDEO",
        numFaces: 1,
        outputFaceBlendshapes: true,
        minFaceDetectionConfidence: 0.34,
        minFacePresenceConfidence: 0.34,
      });
      return;
    } catch (e1) {
      console.warn("[DMS-worker] GPU delegate unavailable, trying CPU:", e1);
    }
  }
  var fr = await FilesetResolver.forVisionTasks(wasmPath);
  landmarker = await FaceLandmarker.createFromOptions(fr, {
    baseOptions: { modelAssetPath: modelUrl, delegate: "CPU" },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFaceBlendshapes: true,
    minFaceDetectionConfidence: 0.34,
    minFacePresenceConfidence: 0.34,
  });
}

self.onmessage = async function (ev) {
  var msg = ev.data;
  if (!msg || !msg.type) return;

  if (msg.type === "init") {
    try {
      landmarker = null;
      await createLandmarker(
        msg.wasmPath,
        msg.modelUrl,
        msg.gpuFirst !== false
      );
      self.postMessage({ type: "init-done", ok: true });
    } catch (e) {
      self.postMessage({
        type: "init-done",
        ok: false,
        error: String((e && e.message) || e),
      });
    }
    return;
  }

  if (msg.type !== "frame") return;

  var bitmap = msg.bitmap;
  if (!bitmap || !landmarker) {
    try {
      bitmap && bitmap.close && bitmap.close();
    } catch (_) {}
    self.postMessage({ type: "result", hasFace: false, eyesClosedLikely: false });
    return;
  }

  var ts = typeof msg.ts === "number" ? msg.ts : performance.now();

  try {
    var result = landmarker.detectForVideo(bitmap, ts);
    try {
      bitmap.close();
    } catch (_) {}
    var c = classifyEyesClosed(result);
    self.postMessage({
      type: "result",
      hasFace: c.hasFace,
      eyesClosedLikely: c.eyesClosedLikely,
    });
  } catch (err) {
    try {
      bitmap.close();
    } catch (_) {}
    self.postMessage({
      type: "result",
      hasFace: false,
      eyesClosedLikely: false,
      error: String((err && err.message) || err),
    });
  }
};
