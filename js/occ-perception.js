/**
 * 乘员感知 OCC — 最近人脸优先
 * 第一层：MediaPipe（手势 / 表情 blendshape / 肢体 / 无年龄·性别）
 * 第二层：按需 POST /vision/occ_fallback（VLM），带冷却与置信度门控
 */
(function () {
  "use strict";

  var WASM_CDN =
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
  var FACE_MODEL =
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task";
  var POSE_MODEL =
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task";
  var GESTURE_MODEL =
    "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/latest/gesture_recognizer.task";

  // Face + pose + gesture 均为主线程同步 WASM；约 4.5fps 足够展示，避免抢占录音回调。
  var SAMPLE_MS = 220;
  var VLM_COOLDOWN_MS = 12000;
  var VLM_DEBOUNCE_FRAMES = 3;
  var AGE_REFRESH_MS = 45000;
  var EXP_CONF_MIN = 0.32;
  var GESTURE_CONF_MIN = 0.48;
  var BODY_CONF_MIN = 0.42;

  var GESTURE_ZH = {
    victory: "剪刀手 ✌",
    thumb_up: "竖拇指 👍",
    thumb_down: "拇指向下 👎",
    open_palm: "张开手掌 ✋",
    closed_fist: "握拳 ✊",
    pointing_up: "食指向上 ☝",
    iloveyou: "我爱你手势 🤟",
  };

  var enabled = true;
  var running = false;
  var rafId = 0;
  var lastSampleAt = 0;
  var faceLm = null;
  var poseLm = null;
  var gestureRec = null;
  var initPromise = null;
  var canvas = null;
  var ctx2d = null;

  var vlmInFlight = false;
  var lastVlmAt = 0;
  var vlmNeedStreak = 0;
  var faceStableSince = 0;

  var display = {
    hasFace: false,
    gesture: { label: "—", confidence: 0, source: "—" },
    expression: { label: "—", confidence: 0, source: "—" },
    body: { label: "—", confidence: 0, source: "—" },
    age: { label: "—", confidence: 0, source: "—" },
    gender: { label: "—", confidence: 0, source: "—" },
    vlmPending: false,
    lastVlmAt: 0,
    lastVlmError: "",
  };

  function $(id) {
    return document.getElementById(id);
  }

  function backendBase() {
    if (
      typeof window.__COCKPIT_API_BASE !== "undefined" &&
      window.__COCKPIT_API_BASE !== null &&
      String(window.__COCKPIT_API_BASE).trim()
    ) {
      return String(window.__COCKPIT_API_BASE).replace(/\/+$/, "");
    }
    return "";
  }

  function pickLargestFace(faces) {
    if (!faces || !faces.length) return null;
    var bestI = 0;
    var bestArea = -1;
    var i;
    for (i = 0; i < faces.length; i++) {
      var lm = faces[i];
      if (!lm || !lm.length) continue;
      var minX = 1,
        maxX = 0,
        minY = 1,
        maxY = 0;
      var j;
      for (j = 0; j < lm.length; j++) {
        var p = lm[j];
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
      }
      var area = (maxX - minX) * (maxY - minY);
      if (area > bestArea) {
        bestArea = area;
        bestI = i;
      }
    }
    return { index: bestI, landmarks: faces[bestI], area: bestArea };
  }

  function normalizeBlendCategories(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (raw.categories && Array.isArray(raw.categories)) return raw.categories;
    return [];
  }

  function sampleExpression(rawCategories) {
    var categories = normalizeBlendCategories(rawCategories);
    var byName = {};
    var i;
    for (i = 0; i < categories.length; i++) {
      var c = categories[i];
      var n = String(c.categoryName || c.displayName || "").toLowerCase();
      if (n) byName[n] = c.score || 0;
    }
    function pick() {
      var keys = arguments;
      var k;
      for (k = 0; k < keys.length; k++) {
        if (byName[keys[k]] != null) return byName[keys[k]];
      }
      return 0;
    }
    var smile =
      (pick("mouthsmileleft", "mouth_smile_left") +
        pick("mouthsmileright", "mouth_smile_right")) /
      2;
    var browRaise =
      (pick("browinnerup", "brow_inner_up") +
        pick("browouterupleft", "brow_outer_up_left") +
        pick("browouterupright", "brow_outer_up_right")) /
      3;
    var mouthFrown =
      (pick("mouthfrownleft", "mouth_frown_left") +
        pick("mouthfrownright", "mouth_frown_right")) /
      2;
    var browDown =
      (pick("browdownleft", "brow_down_left") +
        pick("browdownright", "brow_down_right")) /
      2;
    return {
      smile: smile,
      jawOpen: pick("jawopen", "jaw_open"),
      browRaise: browRaise,
      mouthFrown: mouthFrown,
      mouthPucker: pick("mouthpucker", "mouth_pucker"),
      eyeWide: (pick("eyewideleft", "eye_wide_left") + pick("eyewideright", "eye_wide_right")) / 2,
      browDown: browDown,
      cheekSquint:
        (pick("cheeksquintleft", "cheek_squint_left") +
          pick("cheeksquintright", "cheek_squint_right")) /
        2,
      eyeSquint:
        (pick("eyesquintleft", "eye_squint_left") +
          pick("eyesquintright", "eye_squint_right")) /
        2,
      noseSneer:
        (pick("nosesneerleft", "nose_sneer_left") +
          pick("nosesneerright", "nose_sneer_right")) /
        2,
      blinkL: pick("eyeblinkleft", "eye_blink_left"),
      blinkR: pick("eyeblinkright", "eye_blink_right"),
    };
  }

  function expressionDetailLine(e) {
    return (
      "笑" +
      (e.smile || 0).toFixed(2) +
      " 撇" +
      (e.mouthFrown || 0).toFixed(2) +
      " 眉↓" +
      (e.browDown || 0).toFixed(2) +
      " 眉↑" +
      (e.browRaise || 0).toFixed(2)
    );
  }

  function expressionToLabel(e) {
    var tags = [];
    var peak = 0;
    function bump(v) {
      peak = Math.max(peak, v || 0);
    }
    bump(e.smile);
    bump(e.jawOpen);
    bump(e.browRaise);
    bump(e.mouthFrown);
    bump(e.browDown);
    bump(e.eyeWide);
    bump(e.mouthPucker);
    bump(e.cheekSquint);
    bump(e.eyeSquint);
    bump(e.noseSneer);
    var detail = expressionDetailLine(e);
    var angerScore = Math.max(
      e.browDown || 0,
      e.mouthFrown || 0,
      (e.browDown || 0) * 0.6 + (e.mouthFrown || 0) * 0.5 + (e.noseSneer || 0) * 0.4
    );

    if (e.smile > 0.28 && e.jawOpen > 0.18) tags.push("大笑");
    else if (e.smile > 0.14) tags.push("微笑");
    if (e.mouthPucker > 0.18) tags.push("嘟嘴");
    if (angerScore > 0.12 && e.browDown > 0.08 && e.mouthFrown > 0.06) tags.push("生气");
    else if (e.mouthFrown > 0.12) tags.push("伤心");
    else if (e.browDown > 0.1 && e.mouthFrown < 0.1) tags.push("皱眉");
    if (e.eyeWide > 0.22) tags.push("惊讶");
    if (e.browRaise > 0.24) tags.push("抬眉");
    if (e.cheekSquint > 0.16 && e.smile > 0.1) tags.push("笑眼");
    if (e.eyeSquint > 0.22 && e.mouthFrown > 0.16 && e.smile < 0.2) tags.push("难过");
    if (e.noseSneer > 0.18) tags.push("不屑");
    if ((e.blinkL || 0) > 0.45 || (e.blinkR || 0) > 0.45) tags.push("眨眼");

    if (tags.length) {
      return {
        label: tags.join("·"),
        confidence: Math.min(0.92, Math.max(peak, angerScore) + 0.12),
        detail: detail,
      };
    }

    var ranked = [
      ["微生气", angerScore],
      ["微微笑", e.smile],
      ["微张嘴", e.jawOpen],
      ["眉微抬", e.browRaise],
      ["眉微皱", e.browDown],
      ["嘴角下", e.mouthFrown],
      ["眼角紧", e.eyeSquint],
    ];
    ranked.sort(function (a, b) {
      return (b[1] || 0) - (a[1] || 0);
    });
    if ((ranked[0][1] || 0) >= 0.05) {
      return {
        label: ranked[0][0],
        confidence: Math.min(0.5, (ranked[0][1] || 0) + 0.14),
        detail: detail,
      };
    }

    return { label: "平静", confidence: 0.28, detail: detail };
  }

  function posePoint(lm, idx) {
    if (!lm || !lm[idx]) return null;
    var p = lm[idx];
    if (p.visibility != null && p.visibility < 0.45) return null;
    return p;
  }

  function formatBodyAction(poseLmArr) {
    if (!poseLmArr || !poseLmArr.length) {
      return { label: "未检测到人体", confidence: 0.1 };
    }
    var ls = posePoint(poseLmArr, 11);
    var rs = posePoint(poseLmArr, 12);
    var lw = posePoint(poseLmArr, 15);
    var rw = posePoint(poseLmArr, 16);
    var le = posePoint(poseLmArr, 13);
    var re = posePoint(poseLmArr, 14);
    var parts = [];
    var conf = 0.35;
    if (ls && lw) {
      parts.push(lw.y < ls.y - 0.03 ? "左臂抬起" : "左臂自然下垂");
      conf += 0.18;
    }
    if (rs && rw) {
      parts.push(rw.y < rs.y - 0.03 ? "右臂抬起" : "右臂自然下垂");
      conf += 0.18;
    }
    if (le && lw && ls && lw.y < le.y - 0.05 && lw.y < ls.y - 0.02) {
      parts.push("左手举高");
      conf += 0.1;
    }
    if (re && rw && rs && rw.y < re.y - 0.05 && rw.y < rs.y - 0.02) {
      parts.push("右手举高");
      conf += 0.1;
    }
    if (!parts.length) return { label: "站立/坐姿（关键点不足）", confidence: 0.25 };
    return { label: parts.join("，"), confidence: Math.min(0.88, conf) };
  }

  function readGesture(gestureResult) {
    if (!gestureResult || !gestureResult.gestures || !gestureResult.gestures.length) {
      return { label: "未识别手势", confidence: 0.15 };
    }
    var best = null;
    var gi, hi;
    for (gi = 0; gi < gestureResult.gestures.length; gi++) {
      var handGest = gestureResult.gestures[gi];
      if (!handGest || !handGest.length) continue;
      for (hi = 0; hi < handGest.length; hi++) {
        var g = handGest[hi];
        if (!g || typeof g.score !== "number") continue;
        if (!best || g.score > best.score) best = g;
      }
    }
    if (!best || best.score < 0.35) {
      return { label: "无明确手势", confidence: best ? best.score : 0.1 };
    }
    var raw = String(best.categoryName || best.displayName || "").toLowerCase();
    var zh = GESTURE_ZH[raw] || raw || "手势";
    return { label: zh, confidence: best.score };
  }

  function getVideoEl() {
    var dms = $("dmsCam");
    if (dms && dms.readyState >= 2 && dms.videoWidth > 0) return dms;
    var prev = $("camPreview");
    if (prev && prev.readyState >= 2 && prev.videoWidth > 0) return prev;
    return dms || prev || null;
  }

  function captureJpegDataUrl(video) {
    if (!video || !video.videoWidth) return "";
    if (!canvas) {
      canvas = document.createElement("canvas");
      ctx2d = canvas.getContext("2d", { willReadFrequently: true });
    }
    var w = video.videoWidth;
    var h = video.videoHeight;
    var maxW = 640;
    if (w > maxW) {
      h = Math.round((h * maxW) / w);
      w = maxW;
    }
    canvas.width = w;
    canvas.height = h;
    ctx2d.drawImage(video, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.62);
  }

  function mergeField(field, fastVal, vlmVal) {
    if (!vlmVal || !vlmVal.label) return fastVal;
    var vc = Number(vlmVal.confidence || 0);
    var fc = Number(fastVal.confidence || 0);
    if (vc >= fc + 0.08 || fc < (field === "age" || field === "gender" ? 0.01 : EXP_CONF_MIN)) {
      return { label: vlmVal.label, confidence: vc, source: "VLM" };
    }
    return fastVal;
  }

  function needsDemographyField(key) {
    var obj = display[key] || {};
    var label = obj.label || "";
    if (!label || label === "—" || label === "待 VLM 估计") return true;
    if ((obj.confidence || 0) < 0.55) return true;
    if (Date.now() - (display.lastVlmAt || 0) > AGE_REFRESH_MS) return true;
    return false;
  }

  function decideVlmNeeds(fast) {
    var needs = [];
    if (!fast.hasFace) return needs;
    if (!fast.gesture.confidence || fast.gesture.confidence < GESTURE_CONF_MIN) {
      needs.push("gesture");
    }
    if (!fast.expression.confidence || fast.expression.confidence < EXP_CONF_MIN) {
      needs.push("expression");
    } else if (/^(平静|中性|微微笑|微张嘴|眉微抬|眉微皱|眼角紧|嘴角下|微生气)$/.test(fast.expression.label || "")) {
      needs.push("expression");
    }
    if (!fast.body.confidence || fast.body.confidence < BODY_CONF_MIN) {
      needs.push("body");
    }
    if (needsDemographyField("age")) needs.push("age");
    if (needsDemographyField("gender")) needs.push("gender");
    return needs;
  }

  async function callVlmFallback(image, needs, fastHint) {
    if (!image) return null;
    var url = backendBase() + "/vision/occ_fallback";
    vlmInFlight = true;
    display.vlmPending = true;
    display.lastVlmError = "";
    syncDom();
    try {
      var resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: image,
          needs: needs,
          fast_hint: fastHint,
        }),
      });
      var data = await resp.json().catch(function () {
        return null;
      });
      if (!resp.ok || !data || !data.ok) {
        display.lastVlmError =
          (data && data.error) || "HTTP " + resp.status;
        return null;
      }
      return data;
    } catch (e) {
      display.lastVlmError = e.message || "network error";
      console.warn("[OCC] VLM fallback failed:", e.message);
      return null;
    } finally {
      vlmInFlight = false;
      display.vlmPending = false;
      lastVlmAt = Date.now();
      display.lastVlmAt = lastVlmAt;
    }
  }

  function syncDom() {
    var pill = $("occStatusPill");
    if (pill) {
      pill.textContent = enabled
        ? display.hasFace
          ? "感知中 · 最近乘客"
          : "等待人脸"
        : "已关闭";
      pill.className =
        "occ-status-pill" +
        (enabled ? (display.hasFace ? " occ-status-pill--ok" : "") : " occ-status-pill--off");
    }
    function setRow(prefix, obj) {
      var val = $(prefix + "Val");
      var meta = $(prefix + "Meta");
      if (val) val.textContent = (obj && obj.label) || "—";
      if (meta) {
        var src = (obj && obj.source) || "—";
        var conf =
          obj && obj.confidence != null ? Math.round(obj.confidence * 100) + "%" : "—";
        meta.textContent =
          obj && obj.detail && src === "MediaPipe"
            ? src + " · " + obj.detail + " · 置信 " + conf
            : src + " · 置信 " + conf;
      }
    }
    setRow("occGesture", display.gesture);
    setRow("occExpression", display.expression);
    setRow("occBody", display.body);
    setRow("occAge", display.age);
    setRow("occGender", display.gender);
    var vlmEl = $("occVlmHint");
    if (vlmEl) {
      if (display.vlmPending) {
        vlmEl.textContent = "VLM 兜底分析中…";
      } else if (display.lastVlmError) {
        vlmEl.textContent = "VLM 失败：" + display.lastVlmError;
      } else if (display.lastVlmAt) {
        vlmEl.textContent = "上次 VLM：" + new Date(display.lastVlmAt).toLocaleTimeString();
      } else {
        vlmEl.textContent = "VLM 按需触发（低置信度 / 年龄 / 性别）";
      }
    }
  }

  async function ensureModels() {
    if (faceLm && poseLm && gestureRec) return;
    if (initPromise) return initPromise;
    initPromise = (async function () {
      var mod = await import(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm"
      );
      var FilesetResolver = mod.FilesetResolver;
      var FaceLandmarker = mod.FaceLandmarker;
      var PoseLandmarker = mod.PoseLandmarker;
      var GestureRecognizer = mod.GestureRecognizer;
      var fr = await FilesetResolver.forVisionTasks(WASM_CDN);
      var delegate = "GPU";
      try {
        faceLm = await FaceLandmarker.createFromOptions(fr, {
          baseOptions: { modelAssetPath: FACE_MODEL, delegate: delegate },
          runningMode: "VIDEO",
          numFaces: 2,
          outputFaceBlendshapes: true,
        });
        poseLm = await PoseLandmarker.createFromOptions(fr, {
          baseOptions: { modelAssetPath: POSE_MODEL, delegate: delegate },
          runningMode: "VIDEO",
          numPoses: 1,
        });
        gestureRec = await GestureRecognizer.createFromOptions(fr, {
          baseOptions: { modelAssetPath: GESTURE_MODEL, delegate: delegate },
          runningMode: "VIDEO",
          numHands: 2,
        });
      } catch (e1) {
        console.warn("[OCC] GPU init failed, CPU fallback", e1);
        delegate = "CPU";
        faceLm = await FaceLandmarker.createFromOptions(fr, {
          baseOptions: { modelAssetPath: FACE_MODEL, delegate: delegate },
          runningMode: "VIDEO",
          numFaces: 2,
          outputFaceBlendshapes: true,
        });
        poseLm = await PoseLandmarker.createFromOptions(fr, {
          baseOptions: { modelAssetPath: POSE_MODEL, delegate: delegate },
          runningMode: "VIDEO",
          numPoses: 1,
        });
        gestureRec = await GestureRecognizer.createFromOptions(fr, {
          baseOptions: { modelAssetPath: GESTURE_MODEL, delegate: delegate },
          runningMode: "VIDEO",
          numHands: 2,
        });
      }
      console.log("[OCC] MediaPipe face/pose/gesture ready");
    })();
    return initPromise;
  }

  async function sampleOnce() {
    if (!enabled) return;
    if (window.__cockpitVoiceCapturing) return;
    var video = getVideoEl();
    if (!video || video.readyState < 2 || !video.videoWidth) return;
    await ensureModels();
    var ts = Math.round(performance.now());
    var faceRes = faceLm.detectForVideo(video, ts);
    var poseRes = poseLm.detectForVideo(video, ts);
    var gestRes = gestureRec.recognizeForVideo(video, ts);

    var picked = pickLargestFace(faceRes.faceLandmarks || []);
    display.hasFace = !!(picked && picked.area > 0.008);
    if (display.hasFace && !faceStableSince) faceStableSince = Date.now();
    if (!display.hasFace) {
      faceStableSince = 0;
      vlmNeedStreak = 0;
      display.gesture = { label: "—", confidence: 0, source: "—" };
      display.expression = {
        label: "未检测到人脸",
        confidence: 0.05,
        source: "MediaPipe",
      };
      display.body = { label: "—", confidence: 0, source: "—" };
      display.age = { label: "—", confidence: 0, source: "—" };
      display.gender = { label: "—", confidence: 0, source: "—" };
      syncDom();
      return;
    }

    var exprFast = { label: "未检测到人脸", confidence: 0.05, source: "MediaPipe" };
    if (picked && faceRes.faceBlendshapes && faceRes.faceBlendshapes[picked.index]) {
      var bs = faceRes.faceBlendshapes[picked.index];
      var e = sampleExpression(bs);
      var el = expressionToLabel(e);
      exprFast = {
        label: el.label,
        confidence: el.confidence,
        detail: el.detail,
        source: "MediaPipe",
      };
    }

    var gestFast = readGesture(gestRes);
    gestFast.source = "MediaPipe";

    var bodyArr =
      poseRes.landmarks && poseRes.landmarks.length ? poseRes.landmarks[0] : null;
    var bodyFast = formatBodyAction(bodyArr);
    bodyFast.source = "MediaPipe";

    display.gesture = gestFast;
    display.expression = exprFast;
    display.body = bodyFast;
    if (!display.age.source || display.age.source === "—") {
      display.age = { label: "待 VLM 估计", confidence: 0, source: "—" };
    }
    if (!display.gender.source || display.gender.source === "—") {
      display.gender = { label: "待 VLM 估计", confidence: 0, source: "—" };
    }

    var needs = decideVlmNeeds({
      hasFace: display.hasFace,
      gesture: gestFast,
      expression: exprFast,
      body: bodyFast,
    });
    if (needs.length) vlmNeedStreak++;
    else vlmNeedStreak = 0;

    var canVlm =
      needs.length > 0 &&
      vlmNeedStreak >= VLM_DEBOUNCE_FRAMES &&
      !vlmInFlight &&
      Date.now() - lastVlmAt >= VLM_COOLDOWN_MS &&
      faceStableSince > 0 &&
      Date.now() - faceStableSince > 800;

    if (canVlm) {
      var img = captureJpegDataUrl(video);
      var vlm = await callVlmFallback(img, needs, {
        gesture: gestFast.label,
        expression: exprFast.label,
        body: bodyFast.label,
      });
      vlmNeedStreak = 0;
      if (vlm) {
        if (needs.indexOf("gesture") >= 0 && vlm.gesture) {
          display.gesture = mergeField("gesture", gestFast, vlm.gesture);
        }
        if (needs.indexOf("expression") >= 0 && vlm.expression) {
          display.expression = mergeField("expression", exprFast, vlm.expression);
        }
        if (needs.indexOf("body") >= 0 && vlm.body_action) {
          display.body = mergeField("body", bodyFast, vlm.body_action);
        }
        if (needs.indexOf("age") >= 0 && vlm.age) {
          display.age = {
            label: vlm.age.label || "—",
            confidence: Number(vlm.age.confidence || 0),
            source: "VLM",
          };
        }
        if (needs.indexOf("gender") >= 0 && vlm.gender) {
          display.gender = {
            label: vlm.gender.label || "—",
            confidence: Number(vlm.gender.confidence || 0),
            source: "VLM",
          };
        }
      }
    }

    syncDom();
  }

  function loop() {
    rafId = 0;
    if (!enabled || !running) return;
    var now = performance.now();
    if (now - lastSampleAt >= SAMPLE_MS) {
      lastSampleAt = now;
      sampleOnce().catch(function (e) {
        console.warn("[OCC] sample:", e.message);
      });
    }
    rafId = requestAnimationFrame(loop);
  }

  function start() {
    if (running) return;
    running = true;
    ensureModels()
      .then(function () {
        if (!rafId) rafId = requestAnimationFrame(loop);
      })
      .catch(function (e) {
        console.warn("[OCC] init failed:", e);
        running = false;
      });
  }

  function stopLoop() {
    running = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  function setEnabled(on) {
    enabled = !!on;
    if (enabled) start();
    else stopLoop();
    syncDom();
  }

  var panelVisible = true;
  var dragState = null;

  function clampPanelPos(left, top, shell) {
    if (!shell) return { left: left, top: top };
    var rect = shell.getBoundingClientRect();
    var pad = 8;
    var maxL = Math.max(pad, window.innerWidth - rect.width - pad);
    var maxT = Math.max(pad, window.innerHeight - rect.height - pad);
    return {
      left: Math.min(Math.max(pad, left), maxL),
      top: Math.min(Math.max(pad, top), maxT),
    };
  }

  function applyPanelPos(left, top) {
    var shell = $("occFloat");
    if (!shell) return;
    var pos = clampPanelPos(left, top, shell);
    shell.style.left = pos.left + "px";
    shell.style.top = pos.top + "px";
    shell.style.right = "auto";
    try {
      localStorage.setItem(
        "cockpit_occ_float_pos",
        JSON.stringify({ left: pos.left, top: pos.top })
      );
    } catch (e) {}
  }

  function restorePanelPos() {
    var shell = $("occFloat");
    if (!shell) return;
    try {
      var raw = localStorage.getItem("cockpit_occ_float_pos");
      if (!raw) return;
      var pos = JSON.parse(raw);
      if (typeof pos.left === "number" && typeof pos.top === "number") {
        applyPanelPos(pos.left, pos.top);
      }
    } catch (e2) {}
  }

  function syncPanelChrome() {
    var shell = $("occFloat");
    var launch = $("occFloatLaunch");
    var topBtn = $("occTopToggle");
    if (shell) shell.classList.toggle("hidden", !panelVisible);
    if (launch) launch.classList.toggle("hidden", panelVisible);
    if (topBtn) topBtn.setAttribute("aria-expanded", panelVisible ? "true" : "false");
  }

  function setPanelVisible(on) {
    panelVisible = !!on;
    syncPanelChrome();
  }

  function togglePanelVisible() {
    setPanelVisible(!panelVisible);
  }

  function setupFloatChrome() {
    var shell = $("occFloat");
    var handle = $("occFloatDrag");
    var minBtn = $("occFloatMin");
    var closeBtn = $("occFloatClose");
    var launch = $("occFloatLaunch");
    var topBtn = $("occTopToggle");
    if (!shell || !handle) return;

    restorePanelPos();
    syncPanelChrome();

    if (minBtn) minBtn.addEventListener("click", function () { setPanelVisible(false); });
    if (closeBtn) closeBtn.addEventListener("click", function () { setPanelVisible(false); });
    if (launch) launch.addEventListener("click", function () { setPanelVisible(true); });
    if (topBtn) topBtn.addEventListener("click", togglePanelVisible);

    function onMove(ev) {
      if (!dragState) return;
      var clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
      var clientY = ev.touches ? ev.touches[0].clientY : ev.clientY;
      applyPanelPos(clientX - dragState.dx, clientY - dragState.dy);
      ev.preventDefault();
    }

    function onUp() {
      dragState = null;
      shell.classList.remove("is-dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onUp);
    }

    function onDown(ev) {
      if (ev.target && ev.target.closest && ev.target.closest(".occ-float__btn")) return;
      var rect = shell.getBoundingClientRect();
      var clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
      var clientY = ev.touches ? ev.touches[0].clientY : ev.clientY;
      dragState = { dx: clientX - rect.left, dy: clientY - rect.top };
      shell.classList.add("is-dragging");
      shell.style.right = "auto";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.addEventListener("touchmove", onMove, { passive: false });
      document.addEventListener("touchend", onUp);
    }

    handle.addEventListener("mousedown", onDown);
    handle.addEventListener("touchstart", onDown, { passive: true });
  }

  window.OccPerception = {
    getSnapshot: function () {
      return JSON.parse(JSON.stringify(display));
    },
    setEnabled: setEnabled,
    isEnabled: function () {
      return enabled;
    },
    setPanelVisible: setPanelVisible,
    isPanelVisible: function () {
      return panelVisible;
    },
  };

  window.__cockpitSetOccEnabled = setEnabled;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      setupFloatChrome();
      start();
      document.addEventListener("visibilitychange", function () {
        if (document.hidden) stopLoop();
        else if (enabled) start();
      });
    });
  } else {
    setupFloatChrome();
    start();
  }
})();
