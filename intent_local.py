"""
本地意图初筛 — 开源 embedding 模型 + 座舱意图清单。

流程：用户 ASR 文本 → 与 COCKPIT_INTENT_CATALOG 例句做向量相似度 →
命中且置信足够则返回 action（match=local_embed / local_fuzzy），否则返回 None 交给 LLM。

环境变量：
  INTENT_LOCAL_ENABLED=1|0
  INTENT_LOCAL_MODEL=shibing624/text2vec-base-chinese  （sentence-transformers）
  INTENT_LOCAL_THRESHOLD=0.58   （余弦相似度下限）
  INTENT_LOCAL_MARGIN=0.03      （top1 与 top2 的最小差距）
  INTENT_LOCAL_PRELOAD=1        （服务启动时加载模型）
"""

from __future__ import annotations

import difflib
import os
import threading
from typing import Any, Optional

from intent_manifest import (
    COCKPIT_INTENT_CATALOG,
    default_response_for,
    is_parametric_intent,
    iter_intent_examples,
)

INTENT_LOCAL_ENABLED = os.getenv("INTENT_LOCAL_ENABLED", "1").strip().lower() not in (
    "0",
    "false",
    "no",
    "off",
)
INTENT_LOCAL_MODEL = os.getenv(
    "INTENT_LOCAL_MODEL", "shibing624/text2vec-base-chinese"
).strip()
INTENT_LOCAL_THRESHOLD = float(os.getenv("INTENT_LOCAL_THRESHOLD", "0.58"))
INTENT_LOCAL_MARGIN = float(os.getenv("INTENT_LOCAL_MARGIN", "0.03"))
INTENT_LOCAL_PRELOAD = os.getenv("INTENT_LOCAL_PRELOAD", "0").strip().lower() in (
    "1",
    "true",
    "yes",
)

_lock = threading.Lock()
_model = None
_model_error: Optional[str] = None
_index_phrases: list[str] = []
_index_actions: list[str] = []
_index_embeddings = None
_fuzzy_phrases: list[str] = []
_fuzzy_actions: list[str] = []


def _build_fuzzy_index() -> None:
    global _fuzzy_phrases, _fuzzy_actions
    phrases: list[str] = []
    actions: list[str] = []
    for action, phrase in iter_intent_examples():
        phrases.append(phrase)
        actions.append(action)
    _fuzzy_phrases = phrases
    _fuzzy_actions = actions


def _load_embedder():
    global _model, _model_error, _index_phrases, _index_actions, _index_embeddings
    if _model is not None or _model_error is not None:
        return
    try:
        from sentence_transformers import SentenceTransformer
        import numpy as np

        _model = SentenceTransformer(INTENT_LOCAL_MODEL)
        phrases: list[str] = []
        actions: list[str] = []
        for action, phrase in iter_intent_examples():
            phrases.append(phrase)
            actions.append(action)
        _index_phrases = phrases
        _index_actions = actions
        emb = _model.encode(phrases, normalize_embeddings=True, show_progress_bar=False)
        _index_embeddings = np.asarray(emb, dtype=np.float32)
        print(
            f"[IntentLocal] embedding ready | model={INTENT_LOCAL_MODEL} | "
            f"examples={len(phrases)}",
            flush=True,
        )
    except Exception as e:
        _model_error = str(e)
        print(f"[IntentLocal] embedding unavailable, fuzzy fallback: {e}", flush=True)
        _build_fuzzy_index()


def preload_local_intent() -> None:
    if not INTENT_LOCAL_ENABLED:
        return
    with _lock:
        _load_embedder()


def local_intent_status() -> dict[str, Any]:
    with _lock:
        if not INTENT_LOCAL_ENABLED:
            return {"enabled": False, "backend": "off"}
        _load_embedder()
        if _index_embeddings is not None:
            return {
                "enabled": True,
                "backend": "embedding",
                "model": INTENT_LOCAL_MODEL,
                "examples": len(_index_phrases),
                "threshold": INTENT_LOCAL_THRESHOLD,
            }
        return {
            "enabled": True,
            "backend": "fuzzy",
            "model_error": _model_error,
            "examples": len(_fuzzy_phrases),
        }


def _classify_embedding(text: str) -> Optional[tuple[str, float, float]]:
    import numpy as np

    assert _model is not None and _index_embeddings is not None
    q = _model.encode([text], normalize_embeddings=True, show_progress_bar=False)
    qv = np.asarray(q[0], dtype=np.float32)
    scores = _index_embeddings @ qv
    if scores.size == 0:
        return None
    order = scores.argsort()[::-1]
    best_i = int(order[0])
    best_score = float(scores[best_i])
    second_score = float(scores[int(order[1])]) if scores.size > 1 else 0.0
    if best_score < INTENT_LOCAL_THRESHOLD:
        return None
    if best_score - second_score < INTENT_LOCAL_MARGIN:
        return None
    return _index_actions[best_i], best_score, second_score


def _classify_fuzzy(text: str) -> Optional[tuple[str, float, float]]:
    if not _fuzzy_phrases:
        _build_fuzzy_index()
    norm = text.replace(" ", "")
    best_action = None
    best_score = 0.0
    second_score = 0.0
    for phrase, action in zip(_fuzzy_phrases, _fuzzy_actions):
        pn = phrase.replace(" ", "")
        if pn == norm:
            score = 1.0
        else:
            score = difflib.SequenceMatcher(None, norm, pn).ratio()
            if len(pn) >= 5 and norm.startswith(pn):
                score = max(score, 0.86)
        if score > best_score:
            second_score = best_score
            best_score = score
            best_action = action
        elif score > second_score:
            second_score = score
    if best_action is None or best_score < 0.72:
        return None
    if best_score - second_score < 0.06:
        return None
    return best_action, best_score, second_score


def classify_local_intent(text: str) -> Optional[dict[str, Any]]:
    """Return intent dict skeleton or None (fall through to LLM)."""
    if not INTENT_LOCAL_ENABLED:
        return None
    ts = (text or "").strip()
    if len(ts.replace(" ", "")) < 2:
        return None

    with _lock:
        _load_embedder()
        hit = None
        backend = "local_fuzzy"
        if _index_embeddings is not None:
            hit = _classify_embedding(ts)
            backend = "local_embed"
        if hit is None:
            hit = _classify_fuzzy(ts)
            backend = "local_fuzzy"
        if hit is None:
            return None

    action, score, _runner = hit
    if action not in COCKPIT_INTENT_CATALOG:
        return None
    if is_parametric_intent(action):
        return None

    return {
        "action": action,
        "params": {},
        "response": default_response_for(action),
        "match": backend,
        "local_score": round(score, 4),
    }


if INTENT_LOCAL_PRELOAD and INTENT_LOCAL_ENABLED:
    preload_local_intent()
