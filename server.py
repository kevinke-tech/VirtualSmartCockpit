#!/usr/bin/env python3
"""
Virtual Smart Cockpit — backend.

Voice stack aligns with sibling project::

    E:\\21_Coding\\vui\\server.py

Same pattern: FastAPI routes ``/asr`` (FunASR WAV), ``/intent`` (Doubao JSON),
``/tts`` (Volcano OpenSpeech), ``.env.local`` keys. This fork uses cockpit-specific
intent rules and listens on port **5002**, and mounts static files so one process
replaces VUI split (http-server :8080 + API :5001).
"""

import io
import json
import os
import re
import sys
import threading
import wave
from typing import Optional, Tuple

import httpx
import numpy as np
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel

# Doubao Ark / FunASR / Volc TTS secrets — NOT committed. Create `.env.local` in this folder
# (copy from `.env.example` or from `..\vui\.env.local`). Optional `.env` is also loaded first.
load_dotenv(".env")
load_dotenv(".env.local", override=True)

# --- Config ---
ARK_API_KEY = os.getenv("ARK_API_KEY", "")
CHAT_DOUBAO_MODEL = os.getenv("CHAT_DOUBAO_MODEL", "doubao-seed-2-0-mini-260215")
ARK_API_BASE = "https://ark.cn-beijing.volces.com/api/v3"
FUNASR_MODEL = os.getenv("FUNASR_OFFLINE_MODEL", "paraformer-zh")
SAMPLE_RATE = 16000

VOLC_TTS_APP_ID = os.getenv("VOLC_TTS_APP_ID", "")
VOLC_TTS_ACCESS_TOKEN = os.getenv("VOLC_TTS_ACCESS_TOKEN", "")
VOLC_TTS_SECRET_KEY = os.getenv("VOLC_TTS_SECRET_KEY", "")
VOLC_TTS_VOICE_TYPE = os.getenv("VOLC_TTS_VOICE_TYPE", "zh_female_sajiaonvyou_moon_bigtts")
VOLC_TTS_URL = os.getenv("VOLC_TTS_URL", "https://openspeech.bytedance.com/api/v1/tts")
VOLC_TTS_CLUSTER = os.getenv("VOLC_TTS_CLUSTER", "volcano_tts")

print(
    "[Cockpit] ARK:",
    "set (" + ARK_API_KEY[:8] + "...)" if ARK_API_KEY else "NOT SET",
    "| model:",
    CHAT_DOUBAO_MODEL,
)

_asr_model = None
_asr_model_lock = threading.Lock()


def _get_asr_model():
    global _asr_model
    with _asr_model_lock:
        if _asr_model is not None:
            return _asr_model
        os.environ.setdefault("TQDM_DISABLE", "1")
        from funasr import AutoModel

        print(f"[ASR] Loading FunASR '{FUNASR_MODEL}' ...")
        _asr_model = AutoModel(model=FUNASR_MODEL, disable_update=True)
        print("[ASR] OK")
        return _asr_model


def _wav_bytes_to_float32(wav_bytes: bytes) -> np.ndarray:
    with io.BytesIO(wav_bytes) as bio:
        with wave.open(bio, "rb") as w:
            nch = w.getnchannels()
            sampw = w.getsampwidth()
            framerate = w.getframerate()
            nframes = w.getnframes()
            raw = w.readframes(nframes)
    if sampw == 2:
        arr = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    elif sampw == 1:
        arr = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) / 128.0) - 1.0
    else:
        raise ValueError(f"Unsupported sample width: {sampw}")
    if nch > 1:
        arr = arr.reshape(-1, nch)[:, 0]
    if framerate != SAMPLE_RATE:
        n_old = arr.size
        n_new = int(round(n_old * SAMPLE_RATE / framerate))
        x_old = np.linspace(0, 1, n_old)
        x_new = np.linspace(0, 1, n_new)
        arr = np.interp(x_new, x_old, arr).astype(np.float32)
    return arr


def _extract_asr_text(res) -> str:
    if not res:
        return ""
    parts = []
    for item in (res if isinstance(res, list) else [res]):
        if isinstance(item, str):
            parts.append(item.strip())
        elif isinstance(item, dict):
            parts.append((item.get("text") or "").strip())
        elif isinstance(item, list):
            for x in item:
                if isinstance(x, dict):
                    parts.append((x.get("text") or "").strip())
                elif isinstance(x, str):
                    parts.append(x.strip())
    return "".join(parts)


def transcribe_wav(wav_bytes: bytes) -> str:
    import time

    t0 = time.perf_counter()
    arr = _wav_bytes_to_float32(wav_bytes)
    if arr.size < 400:
        return ""
    audio_dur = arr.size / SAMPLE_RATE
    model = _get_asr_model()
    res = model.generate(input=np.ascontiguousarray(arr, dtype=np.float32))
    text = _extract_asr_text(res)
    t2 = time.perf_counter()
    print(
        f"[ASR] '{text}' | {audio_dur:.1f}s | {(t2-t0)*1000:.0f}ms",
        flush=True,
    )
    return text


# --- Intent: cockpit ---
VALID_ACTIONS = {
    # 驾驶
    "drive_overtake_left",
    "drive_overtake_right",
    "drive_speed_up",
    "drive_slow_down",
    "drive_pull_over",
    "drive_resume_route",
    "drive_lane_center",
    # 导航叠加
    "nav_open",
    "nav_set_destination",
    "nav_search_poi",
    "nav_along_route_poi_start",
    "nav_poi_candidate_pick",
    "nav_poi_candidate_cancel",
    "nav_add_waypoint",
    "nav_remove_last_waypoint",
    "nav_close",
    # 空调
    "ac_open",
    "ac_set_temperature",
    "ac_adjust_fan",
    "ac_adjust_wind",
    "ac_close",
    # 空调体感（模糊说法 → 综合调节）
    "ac_comfort_stuffy",
    "ac_defog_front",
    # 音乐
    "music_open",
    "music_toggle",
    "music_next",
    "music_prev",
    "music_volume_up",
    "music_volume_down",
    "music_stop_exit",
    # 视频（与前端 COCKPIT_VIDEO_LIST / vui CONFIG.videos 同源）
    "video_open",
    "video_close",
    "video_toggle",
    "video_play",
    "video_pause",
    "video_resume",
    "video_next",
    "video_prev",
    "video_volume_up",
    "video_volume_down",
    "video_select",
    # 咖啡（虚拟下单）
    "coffee_open",
    "coffee_add_item",
    "coffee_confirm_pay",
    "coffee_close",
    # 虚拟打卡
    "scenic_open",
    "scenic_take_photo",
    "scenic_close",
    "scenic_gallery_open",
    "scenic_gallery_close",
    "scenic_gallery_next",
    "scenic_gallery_prev",
    "scenic_gallery_play_toggle",
    "scenic_gallery_fullscreen",
    # DMS 驾驶员监测（闭眼 / 疲劳弹窗）
    "dms_enable",
    "dms_disable",
    # 信息与短信（座舱 JSON 里会带 messages / last_pickup_place）
    "msg_read_last",
    "msg_reply_send",
    # meta
    "none",
    "chat",
}


def generate_cockpit_prompt(context: dict, user_input: str) -> str:
    vis = json.dumps(context, ensure_ascii=False, indent=None)
    return f"""你是「汽车虚拟座舱」的语音指令解析器。根据用户话术返回 JSON：
{{"action": "<上面的 action 标识>", "params": {{}}, "response": "<给用户的简短语音反馈口语，要能直接朗读>"}}

可用 action 清单（必选其一）：
- drive_overtake_left — 向左超车（往驾驶员左手侧变道，lane_index 减小）：已在 lane_index=0 最左则不执行
- drive_overtake_right — 向右超车（往驾驶员右手侧变道，lane_index 增大）：已在 lane_index=2 最右则不执行
- drive_speed_up — 提速
- drive_slow_down — 减速
- drive_pull_over — 靠边停车
- drive_resume_route — 重新出发、继续导航、取消靠边
- drive_lane_center — 回到中间车道、居中行驶、回中间车道（params 可空）
- nav_open — 打开/进入导航规划
- nav_set_destination — 设置目的地(params: destination 简短名称)
- nav_search_poi — 笼统搜索(params: query)
- nav_along_route_poi_start — 用户明确「沿途/沿路/顺路搜索某类 POI」（params: query 如加油站）→ 由车机弹出备选列表并语音提示选择，不要仅用 nav_search_poi
- nav_poi_candidate_pick — 仅在 context.poi_pick_active 为 true 时：用户在选 POI(params: choice_index 整数 1/2/3)
- nav_poi_candidate_cancel — 取消本次 POI 多选会话
- nav_add_waypoint — 添加途经点(params: name)
- nav_remove_last_waypoint — 删除最后一个途经点
- nav_close — 关闭导航规划叠加
- ac_open — 打开空调界面
- ac_set_temperature — 设空调温度(params: temperature 整数)
- ac_adjust_fan — 风量(params: delta -1或1或2)
- ac_adjust_wind — 风向(params: preset 字符串如对面/脚底/挡风玻璃)
- ac_close — 关闭空调叠加
- ac_comfort_stuffy — 用户说**闷、很闷、透不过气、空气不好**等：打开空调并加强换气（车机侧已提高风量、保持压缩机工作）
- ac_defog_front — **看不见路、起雾、前挡模糊**等：打开前挡风玻璃除雾（风向切到「挡风玻璃」类）
- music_open — 想听歌、来点音乐、调节氛围听歌
- music_toggle — 播放或暂停当前音乐（根据当前是否在播判断）
- music_next — 下一首
- music_prev — 上一首
- music_volume_up / music_volume_down
- music_stop_exit — 停止音乐、关掉音乐界面
- video_open — 用户想「看视频/看电影/放个片」等：打开视频叠加并自动播放当前条目（context.video_catalog_titles 为可点播列表）
- video_close — 关闭视频页：如「退出视频」「退出视频播放」或 context.overlay_video 为 true 时说「退出」
- video_toggle — 播放/暂停当前视频
- video_play / video_resume — 继续播放、开始播（可从暂停恢复）
- video_pause — 只暂停
- video_next / video_prev — 下一条 / 上一条（与 vui 点播列表顺序一致）
- video_volume_up / video_volume_down
- video_select — 按序号点播 params.clip_index 整数 1～列表长度（与 context.video_catalog_titles[].index 对应）
- coffee_open — 用户要开始车内点咖啡、想了解喝什么：**打开面板**并让 response **主动询问想喝哪款**（可结合 context.coffee_menu_names_hint 举 3～6 款）
- coffee_add_item — 用户明确要了某饮品：params **sku**（与 coffee_menu[].sku 一致）或 drink/name（必须与 context.coffee_menu 中某款的 name **完全对应或可唯一简称识别**）；**qty** 杯数整数默认 1。若用户点名**不在菜单**的任何一款里 → **不要使用本 action**，改用 chat，礼貌说暂时没有并举荐两款菜单内相近款
- coffee_confirm_pay — 用户明确表示**够 / 没有其他 / 就这些 / 结账 / 去付款 / 扫吧**…且通常 context.coffee_cart_nonempty 为 true 时：**先**用 response **请用手机扫屏幕上虚拟收款码**；若为空单则改用 chat，引导先点东西。真正「支付完成」「顺路咖啡店途点」由前端仿真二维码结束后自动处理，你只管语音话术。**不要在 cart 为空时输出本 action**
- coffee_close — 关闭咖啡叠加
- scenic_open — 想打开风景打卡页、想记录途中风景（只打开界面，不抓拍）
- scenic_take_photo — 开始拍照、抓拍、拍一张、倒计时时快门等（打开界面并启动 3-2-1 倒计时合成）
- scenic_close — 退出/关闭风景打卡
- scenic_gallery_open — 查看/打开打卡照片库（显示已保存照片列表与预览）
- scenic_gallery_close — 退出/关闭打卡照片库
- scenic_gallery_next / scenic_gallery_prev — 照片库上一张/下一张
- scenic_gallery_play_toggle — 开始或停止照片轮播
- scenic_gallery_fullscreen — 照片库全屏预览
- dms_enable — 打开/开启**驾驶员监测（DMS）**：闭眼检测与疲劳语音/弹窗；context.dms_enabled 为 false 时常用
- dms_disable — **关闭 DMS**：停止闭眼检测、不再弹出疲劳驾驶窗；context.dms_enabled 为 true 时常用
- msg_read_last — 朗读/查询短信与消息：如「读一下信息」「谁发的」「刚收到什么」
- msg_reply_send — 代发回复（params: to 收件人简短称呼, message_text 要说的内容）。用户像「回复张三，说我十分钟后到」要抽取出 to 与 message_text
- none — 无意义噪声
- chat — 与座舱无关闲聊时

【导航 × 信息语义 — 必读】
- context.messages 为近期消息列表；context.last_pickup_place 为从最近一条含地点的消息里抽好的接人/见面点字符串（可能为空）。
- 【空调体感 — 模糊说法】context 含 ac_driver_temp_set（主驾设定温度）等：用户说「冷、太冷、我觉得冷」→ **ac_set_temperature**，在 ac_driver_temp_set 基础上**调高**约 2℃（或用户说具体度数则用该值），并打开空调界面；说「闷、很闷、透不过气」→ **ac_comfort_stuffy**；说「看不见前面路、起雾、除雾」→ **ac_defog_front**。fast 规则已覆盖常见句式，你需处理变体。
- context.dms_enabled 为 false 时用户说「打开驾驶员监测 / 开启DMS」→ dms_enable；为 true 时说「关闭DMS / 关掉疲劳监测」→ dms_disable
- context.overlay_video 为 true 时，用户说「暂停 / 下一个 / 大点声 / 退出」优先指**视频**而不是音乐（除非明确说听歌）
- context.overlay_scenic_gallery 为 true 时，用户说「退出」「上一张」「下一张」「全屏」优先指打卡照片库
- 用户说「看电影」「看视频」「想看电影」→ video_open
- 用户说「顺便去一趟 / 途经 / 加一站 / 绕一下 …」→ nav_add_waypoint（params.name 填地名；若用户只说「信息里那个地方」则用 last_pickup_place）
- 用户说「顺路 / 顺便 / 沿途 / 沿路 + 去接某人、接朋友、帮人接 …」意为**在原导航基础上加接人点**，→ **nav_add_waypoint**（name 用人名对应消息里的接人地点或 last_pickup_place），**禁止** nav_set_destination 覆盖原终点
- 用户说「我们去 / 导航到 / 改目的地 / 目的地改成 …」且无「顺便/途经/顺路去接人」等绕路语义 → nav_set_destination
- 用户说「顺路沿途搜一下加油站 / 沿路找充电站 / …」且有「沿途/沿路/顺路/路上」+「搜找查」之意 → nav_along_route_poi_start（不要用 nav_open）

【途经点沿途 POI 多选会话】context.poi_pick_active 为 true：车端正播报候选顺序，context.poi_pick_choices 为与语音一致的名称列表（序号从 1 起）：
- 「第一个」「选二」「最后一个」等 → nav_poi_candidate_pick（params.choice_index 1～choices 长度）
- 「取消」「算了」→ nav_poi_candidate_cancel

【车载咖啡多轮对话】（context 含 coffee_menu、coffee_cart_lines_preview、coffee_cart_nonempty、coffee_menu_names_hint）
- 只说「来一个生椰」「两杯标准美式」「橙C」「摩卡」「轻乳茶」等有明确 SKU 指向 → coffee_open 不必重复，直接 coffee_add_item；可加一句「还要别的吗？」在 response。
- 「没有了 / 不用了 / 不要了 / 就这些 / 去结账 / 可以付款了」cart 非空 → **coffee_confirm_pay**（调出收款码；**不要** coffee_close）
- 「蓝山」「冰摇浓缩瑞纳冰」等**菜单外**，或无法对应 coffee_menu[].name → **chat**：道歉 + 简要推荐店内现有品名

【当前座舱 JSON 上下文】（含 lane_index：0 最左、1 中间、2 最右；已到边界时「超车」意图仍可下发，前端静默不执行）
{vis}

用户说：「{user_input}」

只输出一行合法 JSON。"""


async def call_doubao_chat(messages: list, temperature: float = 0.3) -> str:
    if not ARK_API_KEY:
        raise ValueError("ARK_API_KEY not configured")
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{ARK_API_BASE}/chat/completions",
            headers={
                "Authorization": f"Bearer {ARK_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": CHAT_DOUBAO_MODEL,
                "messages": messages,
                "temperature": temperature,
                "max_tokens": 512,
            },
            timeout=30.0,
        )
        if resp.status_code != 200:
            raise ValueError(resp.text)
        return resp.json()["choices"][0]["message"]["content"]


_CN_NUM = {
    "一": 1,
    "二": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
    "十": 10,
}


def _extract_temp(text: str) -> Optional[int]:
    m = re.search(r"(\d{1,2})\s*[度°C]", text)
    if m:
        return int(m.group(1))
    m = re.search(r"([\d一二三四五六七八九十]{1,2})\s*[度]", text)
    if not m:
        return None
    s = m.group(1)
    if s.isdigit():
        return int(s)
    return _CN_NUM.get(s)


def _normalize_command_text(text: str) -> str:
    """Strip noise chars + common ASR confusions so substring rules match reliably."""
    if not text:
        return ""
    t = text.replace(" ", "").strip()
    t = re.sub(r'[\u3000\t\r\n，。！？、；：""''（）【】…]', "", t)
    for wrong, ok in (
        ("象右", "向右"),
        ("象左", "向左"),
        ("像右", "向右"),
        ("像左", "向左"),
        ("啊杰", "阿杰"),
    ):
        t = t.replace(wrong, ok)
    return t


def _is_negative_drive_command(t: str) -> bool:
    if not t:
        return False
    return bool(re.search(r"(不要|别|请勿|禁止).{0,8}(超车|变道)", t))


def _wants_center_lane(t: str) -> bool:
    return any(
        k in t
        for k in (
            "回到中间车道",
            "回中间车道",
            "返回中间车道",
            "走中间车道",
            "居中车道",
            "回到中间",
            "回中间",
            "变回中间",
            "返回中间",
            "车道回中间",
        )
    )


def _mentions_overtake_command(t: str) -> bool:
    return any(k in t for k in ("超车", "超过前车", "超过去", "变道超越", "变道超"))


def _explicit_overtake_direction(t: str) -> Optional[str]:
    """'left', 'right', or None."""
    if "左超车" in t:
        return "left"
    if "右超车" in t:
        return "right"
    left_m = (
        "向左",
        "往左",
        "靠左",
        "左侧",
        "左边",
        "从左边",
        "从左侧",
        "左车道",
        "左道",
    )
    right_m = (
        "向右",
        "往右",
        "靠右",
        "右侧",
        "右边",
        "从右边",
        "从右侧",
        "右车道",
        "右道",
    )
    pos_idx = 10**9
    side: Optional[str] = None
    for s in left_m:
        p = t.find(s)
        if p != -1 and p < pos_idx:
            pos_idx = p
            side = "left"
    for s in right_m:
        p = t.find(s)
        if p != -1 and p < pos_idx:
            pos_idx = p
            side = "right"
    return side


def _correct_drive_actions_from_text(text: str, action: str, response: str) -> Tuple[str, str]:
    """Use raw user/ASR text to fix wrong LLM direction or missed fast patterns."""
    ts = (text or "").strip()
    if not ts:
        return action, response
    t = _normalize_command_text(ts)
    if _is_negative_drive_command(t):
        return action, response
    if _wants_center_lane(t):
        return ("drive_lane_center", response or "好的，正在回到中间车道")
    if not _mentions_overtake_command(t):
        return action, response
    d = _explicit_overtake_direction(t)
    if d == "right":
        return ("drive_overtake_right", response or "好的，正在向右超车")
    if d == "left":
        return ("drive_overtake_left", response or "好的，正在向左超车")
    return action, response


def _skip_fast_for_message_nav(t: str) -> bool:
    """含「信息/短信里的位置」的导航语句交给 LLM + 上下文，避免误匹配「导航」→ nav_open。"""
    if not t:
        return False
    if not any(k in t for k in ("导航", "去哪", "目的地", "途经", "顺便")):
        return False
    return any(
        k in t
        for k in (
            "信息",
            "短信",
            "说的",
            "朋友",
            "他让",
            "她让",
            "接他",
            "接她",
            "去接",
            "去找",
            "去见",
            "刚收到",
            "那条",
            "那个地",
            "见面",
        )
    )


def _pickup_nav_destination(context: Optional[dict], user_text: str) -> Optional[str]:
    """去接/找联系人、或「导航+接谁」时用 inbox 里对应 place_hint；否则回退 last_pickup。"""
    ctx = context or {}
    t = _normalize_command_text(user_text)
    msgs = list(ctx.get("messages") or [])

    pickup_verbs = (
        "去接",
        "去接人",
        "去找",
        "去见",
        "接下",
        "接到",
        "接上",
        "接他",
        "接她",
        "接朋友",
        "接人",
        "接一下",
        "顺路接",
    )
    verbal_pickup = any(v in t for v in pickup_verbs)

    nav_like = any(
        k in t
        for k in ("导航", "开去", "开到", "路线", "规划", "去哪", "怎么走", "启程")
    )

    contacts = []
    seen = set()
    for m in msgs:
        f = str(m.get("from") or "").strip()
        ph = str(m.get("place_hint") or "").strip()
        if f and f not in seen:
            seen.add(f)
            contacts.append((f, ph))
    contacts.sort(key=lambda kv: len(kv[0]), reverse=True)

    matched_ph = ""
    for f, ph in contacts:
        if len(f) < 2 or f not in t:
            continue
        if ph:
            matched_ph = ph.strip()
        break

    glued = bool(matched_ph) and nav_like and any(k in t for k in ("接", "找", "见"))

    if not verbal_pickup and not glued:
        return None

    dest = matched_ph
    if not dest:
        dest = str(ctx.get("last_pickup_place") or "").strip()
    if not dest and msgs:
        dest = str(msgs[-1].get("place_hint") or "").strip()

    return dest.strip() or None


def _utterance_has_pickup_intent(norm: str) -> bool:
    """去接/接谁 等人接语义（不含「沿途搜 POI」）。"""
    return any(
        v in norm
        for v in (
            "去接",
            "去找",
            "去接人",
            "顺路接",
            "顺便接",
            "顺带接",
            "沿路接",
            "接他",
            "接她",
            "接朋友",
            "接人",
            "接一下",
            "帮人接",
            "替我接",
        )
    )


def _utterance_pickup_via_detour(norm: str) -> bool:
    """顺路/顺便…去接：接人点应作为途经点，保留原终点。"""
    detour = any(
        k in norm
        for k in ("顺路", "顺便", "顺带", "沿途", "沿路", "半途", "中途", "途经")
    )
    return detour and _utterance_has_pickup_intent(norm)


def _fast_nav_pickup_contact(norm: str, context: Optional[dict]) -> Optional[dict]:
    dest = _pickup_nav_destination(context, norm)
    if not dest:
        return None

    navish = any(
        k in norm for k in ("导航", "开去", "开到", "路线", "规划", "去哪", "怎么走")
    )
    if not navish and not _utterance_has_pickup_intent(norm):
        return None

    if _utterance_pickup_via_detour(norm):
        resp = "好的，已把接人地点「" + dest + "」加入途经点，原目的地保持不变。"
        return {
            "action": "nav_add_waypoint",
            "params": {"name": dest},
            "response": resp,
            "match": "fast",
        }

    resp = "好的，已把目的地设为：" + dest + "。正在打开导航规划。"
    return {
        "action": "nav_set_destination",
        "params": {"destination": dest},
        "response": resp,
        "match": "fast",
    }


_NAV_TO_WAYPOINT_MARKERS = frozenset(
    (
        "顺便",
        "顺路",
        "顺带",
        "沿途",
        "沿路",
        "途经",
        "加一站",
        "绕一下",
        "拐去",
        "先拐",
        "半途",
        "中途",
    )
)


def _postprocess_nav_intent(
    action: str, params: dict, context: Optional[dict], user_text: str
) -> Tuple[str, dict, Optional[str]]:
    """用车载 context 补全「信息里那个地方」的地名，并区分途经点 vs 改目的地。"""
    ctx = context or {}
    p = dict(params or {})
    t = _normalize_command_text(user_text)

    pu_dest = _pickup_nav_destination(ctx, user_text)
    if pu_dest:
        if action == "nav_open":
            action = "nav_set_destination"
        if action == "nav_set_destination" and not (p.get("destination") or "").strip():
            p["destination"] = pu_dest

    place = (ctx.get("last_pickup_place") or "").strip()
    if not place:
        msgs = ctx.get("messages") or []
        if msgs:
            place = (msgs[-1].get("place_hint") or "").strip()

    vague_place = bool(place) and any(
        k in t
        for k in (
            "信息",
            "短信",
            "说的",
            "朋友",
            "他",
            "她",
            "刚",
            "那边",
            "那条",
            "那个地",
            "接上",
            "接他",
            "接她",
            "去接",
            "去找",
            "去见",
            "接人",
        )
    ) and any(
        k in t
        for k in ("导航", "去", "到", "途经", "顺便", "顺路", "走一趟", "开去")
    )

    if vague_place:
        if action == "nav_set_destination" and not (p.get("destination") or "").strip():
            p["destination"] = place
        if action == "nav_add_waypoint" and not (p.get("name") or "").strip():
            p["name"] = place

    dest = (p.get("destination") or "").strip()
    name = (p.get("name") or "").strip()

    if action == "nav_add_waypoint" and any(
        k in t for k in ("我们去", "改成去", "目的地", "直达", "就去", "改成", "导航到")
    ) and not any(k in t for k in ("顺便", "顺路", "顺带", "沿途", "沿路", "途经", "加一站", "绕一下")):
        if name:
            return "nav_set_destination", {"destination": name}, None

    if action == "nav_set_destination" and dest and any(
        k in t for k in _NAV_TO_WAYPOINT_MARKERS
    ):
        # 由下沿 POI 流程单独处理的关键词，避免因含「顺路」被误判为「命名途经点」
        if _detect_along_route_poi_query(t) is None:
            voice = (
                f"好的，已把「{dest}」加入途经点，原目的地保持不变。"
                if _utterance_has_pickup_intent(t)
                else f"好的，已把「{dest}」加入途经点。"
            )
            return "nav_add_waypoint", {"name": dest}, voice

    return action, p, None


def _detect_along_route_poi_query(norm: str) -> Optional[str]:
    """短语含沿路语境 + 找 POI → 返回 query 简述；否则 None。"""
    along = any(
        k in norm
        for k in (
            "沿途",
            "沿路",
            "顺路",
            "路上",
            "路边",
            "前边",
            "前方",
            "行程中",
        )
    )
    seek = any(
        k in norm
        for k in (
            "搜",
            "找找",
            "查查",
            "看下",
            "看看",
            "查询",
            "筛选",
            "有没有",
            "附近",
            "哪些",
            "哪里",
            "找找看",
        )
    )
    if along and seek:
        pass
    elif along and (
        "加油站" in norm or ("加油" in norm and "站" in norm)
    ):
        seek = True
    elif along and ("充电站" in norm or "充电桩" in norm or "充电" in norm):
        seek = True
    elif along and "服务区" in norm:
        seek = True

    if not along or not seek:
        return None

    if "加油" in norm or "加油站" in norm or "油站" in norm:
        return "加油站"
    if "充电" in norm or "快充" in norm:
        return "充电站"
    if "服务区" in norm:
        return "服务区"
    if "厕所" in norm or "洗手间" in norm or "卫生间" in norm:
        return "公共卫生间"
    if "商场" in norm or ("购物" in norm and "中心" in norm):
        return "商场"
    return "沿途兴趣点"


def _fast_nav_along_route_poi(t: str) -> Optional[dict]:
    q = _detect_along_route_poi_query(t)
    if not q:
        return None
    return {
        "action": "nav_along_route_poi_start",
        "params": {"query": q},
        "response": f"好的，正在沿路搜索「{q}」，请稍后从候选项里说第几个。",
        "match": "fast",
    }


def _fast_poi_candidate_pick(t: str, context: Optional[dict]) -> Optional[dict]:
    ctx = context or {}
    if not ctx.get("poi_pick_active"):
        return None

    if any(
        k in t
        for k in (
            "算了",
            "取消",
            "不要了",
            "别加了",
            "不用",
            "先不要",
            "退出选择",
            "不说了",
        )
    ):
        return {
            "action": "nav_poi_candidate_cancel",
            "params": {},
            "response": "好的，已取消本次沿路选点。",
            "match": "fast",
        }

    choice: Optional[int] = None

    third_hits = (
        "第三个",
        "第三项",
        "第三名",
        "三号",
        "就选三",
        "要第三个",
        "选第三个",
        "选三",
        "要三",
        "最后一项",
        "最后一个",
        "最后那个",
    )
    for phrase in third_hits:
        if phrase in t:
            choice = 3
            break

    second_hits = (
        "第二个",
        "第二项",
        "第二名",
        "二号",
        "要选第二个",
        "选第二个",
        "要第二个",
        "就选二",
        "选二",
        "要二",
        "中间那个",
    )
    if choice is None:
        for phrase in second_hits:
            if phrase in t:
                choice = 2
                break

    first_hits = (
        "第一个",
        "第一项",
        "第一名",
        "一号",
        "就选第一个",
        "要第一个",
        "选第一个",
        "下一个就第一个",
        "就要第一个",
        "就选一",
        "选1",
        "要1",
        "默认",
        "就这个",
        "首推",
    )
    if choice is None:
        for phrase in first_hits:
            if phrase in t:
                choice = 1
                break

    if choice is None:
        return None

    return {
        "action": "nav_poi_candidate_pick",
        "params": {"choice_index": choice},
        "response": "",
        "match": "fast",
    }


def _fast_video_intents(norm: str, context: dict) -> Optional[dict]:
    """视频点播页打开时的语音优先于音乐 fast 规则；片源列表由前端 context.video_catalog_titles 对齐 vui。"""

    ctx = context or {}
    ov = bool(ctx.get("overlay_video"))

    if ov:
        nav_exit = any(
            k in norm for k in ("退出导航", "关闭导航", "关导航", "关掉导航")
        )
        if not nav_exit:
            for kw in (
                "退出视频",
                "退出视频播放",
                "关闭视频",
                "关掉视频",
                "关闭视频播放",
                "结束视频",
            ):
                if kw in norm:
                    return {
                        "action": "video_close",
                        "params": {},
                        "response": "好的，已关闭视频。",
                        "match": "fast",
                    }
            if norm in ("退出", "退出吧", "先退出"):
                return {
                    "action": "video_close",
                    "params": {},
                    "response": "好的，已关闭视频。",
                    "match": "fast",
                }

            if "暂停" in norm and "导航" not in norm:
                return {
                    "action": "video_toggle",
                    "params": {},
                    "response": "好的",
                    "match": "fast",
                }
            if norm in ("播放", "继续", "继续播放") or "接着播" in norm or "接着放" in norm:
                return {
                    "action": "video_toggle",
                    "params": {},
                    "response": "好的",
                    "match": "fast",
                }
            for kw in ("下一个", "下一集", "下一条", "下一首"):
                if kw in norm:
                    return {
                        "action": "video_next",
                        "params": {},
                        "response": "好的",
                        "match": "fast",
                    }
            for kw in ("上一个", "上一集", "上一条"):
                if kw in norm:
                    return {
                        "action": "video_prev",
                        "params": {},
                        "response": "好的",
                        "match": "fast",
                    }
            for kw in ("大点声", "调大音量", "大声一点"):
                if kw in norm:
                    return {
                        "action": "video_volume_up",
                        "params": {},
                        "response": "好的",
                        "match": "fast",
                    }
            for kw in ("小声", "小点声", "轻一点"):
                if kw in norm:
                    return {
                        "action": "video_volume_down",
                        "params": {},
                        "response": "好的",
                        "match": "fast",
                    }
            for kw in ("别放了", "停止播放"):
                if kw in norm:
                    return {
                        "action": "video_toggle",
                        "params": {},
                        "response": "好的",
                        "match": "fast",
                    }

    if not ov:
        for kw in (
            "想看视频",
            "看视频",
            "看电影",
            "想看电影",
            "播放视频",
            "打开视频",
            "放视频",
            "来个视频",
            "视频点播",
            "播视频",
            "放点视频",
            "我要看视频",
            "放部电影",
            "放电影",
        ):
            if kw in norm:
                return {
                    "action": "video_open",
                    "params": {},
                    "response": "好的，为您打开视频播放。",
                    "match": "fast",
                }
    return None


def _fast_scenic_gallery_intents(norm: str, context: dict) -> Optional[dict]:
    """打卡照片库语音控制。"""
    ctx = context or {}
    in_gallery = bool(ctx.get("overlay_scenic_gallery"))

    if in_gallery:
        for kw in ("退出照片库", "关闭照片库", "退出打卡照片", "关闭打卡照片", "关闭相册"):
            if kw in norm:
                return {
                    "action": "scenic_gallery_close",
                    "params": {},
                    "response": "好的，已退出打卡照片库。",
                    "match": "fast",
                }
        if norm in ("退出", "关闭", "退出吧"):
            return {
                "action": "scenic_gallery_close",
                "params": {},
                "response": "好的，已退出打卡照片库。",
                "match": "fast",
            }
        for kw in ("下一张", "下一页", "往后翻", "后一张"):
            if kw in norm:
                return {
                    "action": "scenic_gallery_next",
                    "params": {},
                    "response": "好的，下一张。",
                    "match": "fast",
                }
        for kw in ("上一张", "上一页", "往前翻", "前一张"):
            if kw in norm:
                return {
                    "action": "scenic_gallery_prev",
                    "params": {},
                    "response": "好的，上一张。",
                    "match": "fast",
                }
        for kw in ("全屏", "全屏播放", "放大全屏", "全屏看图"):
            if kw in norm:
                return {
                    "action": "scenic_gallery_fullscreen",
                    "params": {},
                    "response": "好的，切换全屏。",
                    "match": "fast",
                }
        for kw in ("开始轮播", "轮播", "自动播放照片", "放映照片"):
            if kw in norm:
                return {
                    "action": "scenic_gallery_play_toggle",
                    "params": {},
                    "response": "好的，开始轮播。",
                    "match": "fast",
                }
        for kw in ("停止轮播", "暂停轮播", "停止播放照片"):
            if kw in norm:
                return {
                    "action": "scenic_gallery_play_toggle",
                    "params": {},
                    "response": "好的，已停止轮播。",
                    "match": "fast",
                }

    for kw in ("查看打卡照片", "查看照片", "打开照片库", "打开打卡照片", "查看相册", "打开相册"):
        if kw in norm:
            return {
                "action": "scenic_gallery_open",
                "params": {},
                "response": "好的，已打开打卡照片库。",
                "match": "fast",
            }

    return None


def _fast_dms_intents(norm: str, context: dict) -> Optional[dict]:
    """语音开关驾驶员监测（与前端 context.dms_enabled 一致）。"""

    for kw in (
        "关闭dms",
        "关掉dms",
        "禁用dms",
        "dms关闭",
        "关闭驾驶员监测",
        "关掉驾驶员监测",
        "关闭驾驶员状态监测",
        "关闭疲劳监测",
        "关掉疲劳监测",
        "关闭疲劳提醒",
        "关掉疲劳提醒",
        "关闭闭眼检测",
        "关掉闭眼检测",
        "不要疲劳提醒",
    ):
        if kw in norm:
            return {
                "action": "dms_disable",
                "params": {},
                "response": "好的，已关闭驾驶员监测，不再进行闭眼检测与疲劳弹窗。",
                "match": "fast",
            }
    for kw in (
        "打开dms",
        "开启dms",
        "启用dms",
        "dms打开",
        "打开驾驶员监测",
        "开启驾驶员监测",
        "启用驾驶员监测",
        "打开疲劳监测",
        "开启疲劳监测",
        "打开闭眼检测",
        "开启闭眼检测",
    ):
        if kw in norm:
            return {
                "action": "dms_enable",
                "params": {},
                "response": "好的，已打开驾驶员监测，将进行闭眼检测与疲劳提醒。",
                "match": "fast",
            }
    return None


def _fast_coffee_intents(norm: str, context: dict) -> Optional[dict]:
    """咖啡馆级语音：结账仅当购物车非空，避免「买好了」误触发空单。"""
    ctx = context or {}
    if ctx.get("coffee_cart_nonempty"):
        for kw in (
            "下单",
            "付款",
            "扫码",
            "买好了",
            "就这些",
            "就这要",
            "没有了",
            "不要了",
            "不用了",
            "不用啦",
            "不要别的",
            "不要别的了",
            "不用别的",
            "没有别的",
            "没别的",
            "没别的了",
            "够了",
            "可以了",
            "行了就这些",
            "不点了",
            "去结算",
            "去付款",
            "结账",
            "确认付款",
        ):
            if kw in norm:
                return {
                    "action": "coffee_confirm_pay",
                    "params": {},
                    "response": "好的，请稍等，我调出虚拟收款码，扫完仿真支付后我会把顺路咖啡店加到途经点。",
                    "match": "fast",
                }

    # 单行点单直达（不靠 LLM 拼 params）：与座舱 COFFEE_MENU 一致
    if "轻乳茶" in norm:
        return {
            "action": "coffee_add_item",
            "params": {"sku": "milk-tea", "drink": "轻乳茶"},
            "response": "好的，已为你要了轻乳茶，还要看别的饮品吗？",
            "match": "fast",
        }
    if "生椰拿铁" in norm or ("生椰" in norm and "拿铁" in norm):
        return {
            "action": "coffee_add_item",
            "params": {"sku": "latte-raw", "drink": "生椰拿铁"},
            "response": "好的，已为你要了生椰拿铁。还需要加点别的吗？",
            "match": "fast",
        }
    # 橙汁系美式 / 「橙+C+美式」等 ASR（橙c / 橙C / 橙西…）
    if ("美式" in norm and ("橙" in norm or "c" in norm.lower())) or "橙c美式" in norm.lower():
        return {
            "action": "coffee_add_item",
            "params": {"sku": "orange-am", "drink": "橙C美式"},
            "response": "好的，已为你要了橙C美式。还要看别的饮品吗？",
            "match": "fast",
        }

    for kw in ("点咖啡", "订咖啡", "喝杯咖啡", "来杯咖啡"):
        if kw in norm:
            hint = (ctx.get("coffee_menu_names_hint") or "").strip()
            msg = "好的，帮您打开车内点单。"
            if hint:
                msg += f"今天可以试试{hint}里的哪一款？直接说名字就可以。"
            else:
                msg += "想喝哪款？可以说全称，比如生椰拿铁、橙C美式。"
            return {"action": "coffee_open", "params": {}, "response": msg, "match": "fast"}
    if "咖啡" in norm and norm in ("咖啡", "想喝咖啡"):
        hint = (ctx.get("coffee_menu_names_hint") or "").strip()
        msg = "好的，帮您打开点单界面。"
        if hint:
            msg += f"我们这有{hint}等，您想喝哪款？"
        return {"action": "coffee_open", "params": {}, "response": msg, "match": "fast"}
    return None


def _ctx_ac_driver_temp(context: dict) -> float:
    """当前主驾设定温度（供「觉得冷」等相对调节）。"""
    ctx = context or {}
    v = ctx.get("ac_driver_temp_set")
    try:
        return float(v)
    except (TypeError, ValueError):
        return 23.0


def _fast_ac_comfort_intents(norm: str, context: dict) -> Optional[dict]:
    """空调模糊体感：冷 / 闷 / 起雾看不见路。"""

    # 前挡除雾、可视性
    vis_obstructed = ("看不见" in norm or "看不清" in norm or "看不见了" in norm) and (
        "路" in norm or "前面" in norm or "前方" in norm or "车外" in norm
    )
    fog_kw = (
        "前挡除雾",
        "挡风玻璃除雾",
        "前挡风玻璃除雾",
        "打开除雾",
        "开个除雾",
        "除一下雾",
        "玻璃起雾",
        "车里起雾",
        "车窗起雾",
        "挡风起雾",
        "起雾了",
        "全是雾",
    )
    if vis_obstructed or any(k in norm for k in fog_kw) or (
        "除雾" in norm and "后" not in norm
    ):
        return {
            "action": "ac_defog_front",
            "params": {},
            "response": "好的，已打开前挡风玻璃除雾，视线会清晰一些。",
            "match": "fast",
        }

    # 觉得冷 → 设定温度上调（相对当前主驾温度）
    cold_kw = (
        "我觉得冷",
        "我觉得有点冷",
        "我有点冷",
        "有点冷",
        "有点凉",
        "好冷",
        "太冷了",
        "冷死了",
        "冻死了",
        "体感冷",
        "温度太低",
        "空调太冷",
    )
    if any(k in norm for k in cold_kw):
        base = _ctx_ac_driver_temp(context)
        new_t = int(min(32, max(16, round(base + 2))))
        return {
            "action": "ac_set_temperature",
            "params": {"temperature": new_t},
            "response": f"好的，帮您把空调调到大约{new_t}度，暖和一点。",
            "match": "fast",
        }

    # 闷 → 开空调界面 + 车机侧加强换气
    stuffy_kw = (
        "很闷",
        "我觉得闷",
        "我觉得很闷",
        "有点闷",
        "太闷了",
        "闷死了",
        "透不过气",
        "透不过气来",
        "憋得慌",
        "空气不好",
        "车里闷",
        "车内闷",
    )
    if any(k in norm for k in stuffy_kw):
        return {
            "action": "ac_comfort_stuffy",
            "params": {},
            "response": "好的，已打开空调并加大风量，帮您换换气。",
            "match": "fast",
        }

    return None


def fast_match_cockpit(text: str, context: dict) -> Optional[dict]:
    t = _normalize_command_text(text)
    fk = _fast_nav_pickup_contact(t, context)
    if fk:
        return fk
    pp = _fast_poi_candidate_pick(t, context)
    if pp:
        return pp
    if _skip_fast_for_message_nav(t):
        return None

    ar = _fast_nav_along_route_poi(t)
    if ar:
        return ar

    aco = _fast_ac_comfort_intents(t, context)
    if aco:
        return aco

    vf = _fast_video_intents(t, context)
    if vf:
        return vf

    sg = _fast_scenic_gallery_intents(t, context)
    if sg:
        return sg

    dmsf = _fast_dms_intents(t, context)
    if dmsf:
        return dmsf

    cf = _fast_coffee_intents(t, context)
    if cf:
        return cf

    pairs = [
        (
            [
                "读一下信息",
                "念一下信息",
                "朗读信息",
                "读信息",
                "帮我读信息",
                "谁给我发",
                "谁发的信息",
                "谁发的",
                "刚收到的信息",
                "最新消息",
                "未读信息",
            ],
            "msg_read_last",
            {},
            "",
        ),
        (
            [
                "回到中间车道",
                "回中间车道",
                "返回中间车道",
                "走中间车道",
                "居中车道",
                "回到中间",
                "回中间",
                "变回中间",
                "返回中间",
            ],
            "drive_lane_center",
            {},
            "好的，正在回到中间车道",
        ),
        (
            [
                "右边超车",
                "右侧超车",
                "从右边超车",
                "向右超车",
                "往右超车",
                "靠右超车",
            ],
            "drive_overtake_right",
            {},
            "好的，正在向右超车",
        ),
        (
            [
                "左边超车",
                "左侧超车",
                "从左边超车",
                "向左超车",
                "往左超车",
                "靠左超车",
            ],
            "drive_overtake_left",
            {},
            "好的，正在向左超车",
        ),
        (
            ["超车", "超过前车"],
            "drive_overtake_left",
            {},
            "好的，正在向左超车",
        ),
        (
            ["提速", "快点", "加速"],
            "drive_speed_up",
            {},
            "好的，正在提高车速",
        ),
        (
            ["减速", "慢一点", "慢下来"],
            "drive_slow_down",
            {},
            "好的，正在减速",
        ),
        (
            ["靠边", "靠边停车"],
            "drive_pull_over",
            {},
            "好的，正准备靠边停车",
        ),
        (
            ["重新出发", "继续开", "继续导航", "继续行程"],
            "drive_resume_route",
            {},
            "好的，已重新启动导航行程",
        ),
        (
            ["开始导航", "启程出发", "上路吧", "出发了"],
            "nav_close",
            {},
            "好的，已开始导航仿真；路线信息与左侧 HUD 照常联动",
        ),
        (
            ["关闭导航", "退出导航", "关导航", "关掉导航"],
            "nav_close",
            {},
            "好的，导航规划已关闭",
        ),
        (
            ["导航", "去哪", "规划路线", "搜目的地"],
            "nav_open",
            {},
            "好的，为您打开导航规划",
        ),
        (
            ["回家", "去公司"],
            "nav_set_destination",
            {"destination": "家" if "回" in t or "家" in t else "公司"},
            "目的地已为您设置",
        ),
        (["打开空调", "开空调"], "ac_open", {}, "好的，已打开空调控制"),
        (["关了空调", "关闭空调"], "ac_close", {}, "好的，关闭空调面板"),
        (["听歌", "音乐", "来首歌"], "music_open", {}, "好的，打开音乐播放器"),
        (["暂停", "别放了"], "music_toggle", {}, "好的"),
        (["下一首"], "music_next", {}, "好的，下一首"),
        (["上一首"], "music_prev", {}, "好的，上一首"),
        (["大点声", "调大音量"], "music_volume_up", {}, "好的"),
        (["小声", "小点声"], "music_volume_down", {}, "好的"),
        (
            ["别放了", "停止播放", "退出音乐"],
            "music_stop_exit",
            {},
            "好的，音乐已关闭",
        ),
        (
            [
                "开始拍照",
                "现在拍照",
                "开始拍",
                "倒计时拍照",
                "拍一张",
                "帮我拍",
                "抓拍",
                "快门",
                "拍照",
                "照相",
            ],
            "scenic_take_photo",
            {},
            "好的，倒计时准备拍照",
        ),
        (
            ["关闭打卡", "退出打卡", "关上打卡"],
            "scenic_close",
            {},
            "好的，风景打卡已关闭",
        ),
        (
            ["打卡", "风景打卡", "打开打卡", "想看风景", "记录风景", "美景", "好漂亮", "风光"],
            "scenic_open",
            {},
            "好的，我们来风景打卡",
        ),
    ]
    for keywords, action, params, resp in pairs:
        for kw in keywords:
            if kw in t:
                return {"action": action, "params": params, "response": resp, "match": "fast"}

    if "咖啡" not in t and ("度" in t or "温控" in t or ("空调" in t and "温度" in t)):
        temp = _extract_temp(text)
        if temp is not None:
            return {
                "action": "ac_set_temperature",
                "params": {"temperature": temp},
                "response": f"好的，空调已经设置为{temp}度",
                "match": "fast",
            }

    return None


_FILLER = frozenset({"嗯", "呃", "啊", "哦", "诶"})


def _substantive(text: str) -> bool:
    t = (text or "").strip()
    if len(t.replace(" ", "")) < 1:
        return False
    return t.replace(" ", "") not in _FILLER


async def recognize_cockpit_intent(text: str, context: dict) -> dict:
    ts = (text or "").strip()
    if not ts:
        return {"action": "none", "response": "", "match": "skip"}

    fast = fast_match_cockpit(ts, context)
    if fast:
        na, nr = _correct_drive_actions_from_text(
            ts, fast["action"], fast.get("response") or ""
        )
        params = fast.get("params") or {}
        if na.startswith("nav_"):
            na, params, nav_voice = _postprocess_nav_intent(na, params, context, ts)
            if nav_voice is not None:
                nr = nav_voice
        return {**fast, "action": na, "response": nr or fast.get("response"), "params": params}
    if not _substantive(ts):
        return {"action": "none", "response": "", "match": "skip"}
    if not ARK_API_KEY:
        return {
            "action": "unknown",
            "response": "大模型密钥未配置，无法识别这句",
            "match": "llm_off",
        }

    prompt = generate_cockpit_prompt(context, ts)
    raw = await call_doubao_chat(
        [
            {
                "role": "system",
                "content": "你只输出一行合法 JSON（action params response），不要有其他文字。",
            },
            {"role": "user", "content": prompt},
        ],
        temperature=0.08,
    )
    raw = raw.strip()
    try:
        m = re.search(r"\{[\s\S]+\}", raw)
        js = json.loads(m.group() if m else raw)
    except Exception:
        return {"action": "chat", "response": raw, "match": "llm_parse"}

    action = js.get("action", "unknown")
    if action not in VALID_ACTIONS:
        action = "chat"

    resp = js.get("response", "")
    params = js.get("params") if isinstance(js.get("params"), dict) else {}

    action, resp = _correct_drive_actions_from_text(ts, action, resp)
    if action.startswith("nav_"):
        action, params, nav_voice = _postprocess_nav_intent(action, params, context, ts)
        if nav_voice is not None:
            resp = nav_voice

    if action == "chat":
        cr = await call_doubao_chat(
            [
                {
                    "role": "system",
                    "content": "你是车载语音助手「小座舱」，简短口语 2–3 句。",
                },
                {"role": "user", "content": ts},
            ],
            temperature=0.65,
        )
        resp = cr

    result = {"action": action, "params": params, "response": resp, "match": "llm"}
    return result


# --- FastAPI ---
app = FastAPI(title="Virtual Cockpit API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


class IntentRequest(BaseModel):
    message: str
    context: Optional[dict] = None


class TTSRequest(BaseModel):
    text: str


async def _health_body():
    """Do not preload FunASR here — first /asr call loads the model."""
    return {
        "status": "ok",
        "asr_available": True,
        "llm_available": bool(ARK_API_KEY),
    }


@app.get("/api/health")
@app.get("/health")
async def health():
    return await _health_body()


@app.post("/asr")
async def asr_endpoint(request: Request):
    ct = request.headers.get("content-type", "")
    if "multipart" in ct:
        form = await request.form()
        f = form.get("file")
        wav_bytes = await f.read() if f else b""
    else:
        wav_bytes = await request.body()
    if not wav_bytes or len(wav_bytes) < 44:
        return JSONResponse({"ok": False, "error": "empty"}, status_code=400)
    try:
        text = transcribe_wav(wav_bytes)
        return {"ok": True, "text": text}
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@app.post("/intent")
async def intent_endpoint(req: IntentRequest):
    ctx = req.context or {}
    try:
        r = await recognize_cockpit_intent(req.message, ctx)
        return r
    except Exception as e:
        return JSONResponse({"action": "unknown", "response": str(e)}, status_code=500)


@app.post("/tts")
async def tts_endpoint(req: TTSRequest):
    import base64 as _b64
    import uuid as _uuid

    if not VOLC_TTS_APP_ID or not VOLC_TTS_ACCESS_TOKEN:
        return JSONResponse({"ok": False, "error": "TTS not configured"}, status_code=503)
    txt = req.text.strip()
    if not txt:
        return JSONResponse({"ok": False, "error": "empty"}, status_code=400)
    payload = {
        "app": {
            "appid": VOLC_TTS_APP_ID,
            "token": VOLC_TTS_SECRET_KEY or VOLC_TTS_ACCESS_TOKEN,
            "cluster": VOLC_TTS_CLUSTER,
        },
        "user": {"uid": "cockpit"},
        "audio": {
            "voice_type": VOLC_TTS_VOICE_TYPE,
            "encoding": "mp3",
            "speed_ratio": 1.0,
            "sample_rate": 24000,
        },
        "request": {
            "reqid": str(_uuid.uuid4()),
            "text": txt,
            "operation": "query",
        },
    }
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            VOLC_TTS_URL,
            headers={
                "Content-Type": "application/json; charset=utf-8",
                "Authorization": f"Bearer;{VOLC_TTS_ACCESS_TOKEN}",
            },
            json=payload,
            timeout=10.0,
        )
        data = resp.json()
    if data.get("code") != 3000:
        return JSONResponse(
            {"ok": False, "error": data.get("message")},
            status_code=502,
        )
    audio_bytes = _b64.b64decode(data["data"])
    return Response(content=audio_bytes, media_type="audio/mpeg")


from fastapi.staticfiles import StaticFiles


@app.get("/favicon.ico")
async def favicon():
    """Browser 默认请求 /favicon.ico；挂载 StaticFiles 前显式响应，避免 404 日志刷屏。"""
    svg = os.path.join(BASE_DIR, "favicon.svg")
    if os.path.isfile(svg):
        return FileResponse(svg, media_type="image/svg+xml")
    return Response(status_code=204)


app.mount("/", StaticFiles(directory=BASE_DIR, html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    try:
        _get_asr_model()
    except Exception as e:
        print("[Cockpit] ASR preload failed:", e)
    print(
        "[Cockpit] Binding 0.0.0.0:5002 — open in browser: http://127.0.0.1:5002/ "
        "(never http://0.0.0.0 — ERR_ADDRESS_INVALID)",
        flush=True,
    )
    uvicorn.run(app, host="0.0.0.0", port=5002)
