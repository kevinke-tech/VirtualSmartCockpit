/**
 * 整车虚拟座舱共用一张「嘴」：同一文档内同一时间只播放一条语音。
 *
 * · 默认 { interrupt: false }：先入队（b），按顺序播报。
 * · { interrupt: true }：立即停止当前播报并清空队列，只播报本条（a）。
 *
 * Volc/HTMLAudio 的实现由 js/voice-cockpit.js 通过 registerPlaybackHook 注入；
 * 注入前兜底使用浏览器 speechSynthesis。
 */
(function () {
  "use strict";

  var queue = [];
  var draining = false;
  /** 用于丢弃 interrupt / barge-in 之后晚到的回调 */
  var playbackGen = 0;

  var hardwareStopPlayback = null;
  var playOneSentence = null;

  function builtinSynthPlay(text, cbs) {
    if (!("speechSynthesis" in window)) {
      try {
        if (cbs && cbs.onEnd) cbs.onEnd();
      } catch (_e1) {}
      return;
    }
    var finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      try {
        if (cbs && cbs.onEnd) cbs.onEnd();
      } catch (_e2) {}
    }
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = "zh-CN";
      u.onend = finish;
      u.onerror = finish;
      window.speechSynthesis.speak(u);
    } catch (_e3) {
      finish();
    }
  }

  function invokeHardwareStop() {
    try {
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    } catch (_e0) {}
    try {
      if (typeof hardwareStopPlayback === "function") hardwareStopPlayback();
    } catch (_e00) {}
  }

  /** 仅在可见的标签页出声，避免最小化/后台的另一份页面「偷播」重叠 */
  function whenAudible(cb) {
    if (typeof document === "undefined" || document.visibilityState === "visible") {
      cb();
      return;
    }
    function vis() {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", vis);
      cb();
    }
    document.addEventListener("visibilitychange", vis);
  }

  function drain() {
    if (draining || queue.length === 0) return;

    var impl = typeof playOneSentence === "function" ? playOneSentence : builtinSynthPlay;

    whenAudible(function () {
      if (draining || queue.length === 0) return;
      draining = true;
      var gen = playbackGen;
      var text = queue[0];

      try {
        window.__cockpitTtsQueuedCount = queue.length;
      } catch (__e) {}

      impl(text, {
        onEnd: function () {
          if (gen !== playbackGen) return;
          queue.shift();
          draining = false;
          try {
            window.__cockpitTtsQueuedCount = queue.length;
          } catch (__e) {}
          drain();
        },
        onError: function () {
          if (gen !== playbackGen) return;
          queue.shift();
          draining = false;
          try {
            window.__cockpitTtsQueuedCount = queue.length;
          } catch (__e) {}
          drain();
        },
      });
    });
  }

  function speak(rawText, opts) {
    opts = opts || {};
    var text = String(rawText || "").trim();
    if (!text) return;

    var interrupt =
      opts.interrupt === true ||
      opts.replace === true ||
      opts.mode === "interrupt";

    if (interrupt) {
      playbackGen++;
      invokeHardwareStop();
      queue.length = 0;
      draining = false;
    }

    queue.push(text);
    try {
      window.__cockpitTtsQueuedCount = queue.length;
    } catch (__e) {}

    drain();
  }

  function abortAll() {
    playbackGen++;
    invokeHardwareStop();
    queue.length = 0;
    draining = false;
    try {
      window.__cockpitTtsQueuedCount = 0;
    } catch (__e) {}
  }

  /** 语音识别抢话：清空尚未播报的队列，并停掉扬声器 */
  function abortFromUserBargeIn() {
    abortAll();
  }

  /**
   * 麦克风会话结束等场景：扬声器被外部掐断，但没机会触发 Audio / Utterance 的 onEnd。
   * 跳过当前占位并继续队列（不关语音功能时才会触发）。
   */
  function notifyDeviceStoppedExternally() {
    if (!draining && queue.length === 0) return;
    playbackGen++;
    draining = false;
    if (queue.length > 0) queue.shift();
    try {
      window.__cockpitTtsQueuedCount = queue.length;
    } catch (__e) {}
    drain();
  }

  window.CockpitTTS = {
    speak: speak,
    /** 立即停止并清空队列 */
    abortAll: abortAll,
    abortFromUserBargeIn: abortFromUserBargeIn,
    notifyDeviceStoppedExternally: notifyDeviceStoppedExternally,
    /**
     * @param {(text: string, cbs: { onEnd(): void; onError(): void }) => void} playFn
     * @param {() => void} [stopHardware]
     */
    registerPlaybackHook: function (playFn, stopHardware) {
      playOneSentence = typeof playFn === "function" ? playFn : null;
      hardwareStopPlayback =
        typeof stopHardware === "function" ? stopHardware : null;
    },
    /** @internal hook for tests */
    _resetForTests: abortAll,
  };

  /** 沿用旧调用约定：speakTTS(msg, opts) */
  window.speakTTS = function (msg, opts) {
    speak(msg, opts);
  };
})();
