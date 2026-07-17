"""
座舱「可响应意图」清单 — 供本地 embedding / 模糊匹配 与 LLM prompt 共用。

每条意图包含：
- examples: 用户可能说的口语（ASR 文本）
- response: 命中后默认 TTS 反馈（可被 postprocess 覆盖）
- parametric: True 表示仍需 LLM/规则提取 params（本地层命中后也会降级到 LLM）
"""

from __future__ import annotations

from typing import Any

# parametric=True 的意图：本地层即使相似度高也不直接返回，交给 LLM 填 params
COCKPIT_INTENT_CATALOG: dict[str, dict[str, Any]] = {
    "drive_overtake_left": {
        "response": "好的，正在向左超车",
        "examples": ["左边超车", "左侧超车", "从左边超车", "向左超车", "往左超车", "靠左超车", "超车"],
    },
    "drive_overtake_right": {
        "response": "好的，正在向右超车",
        "examples": ["右边超车", "右侧超车", "从右边超车", "向右超车", "往右超车", "靠右超车"],
    },
    "drive_lane_center": {
        "response": "好的，正在回到中间车道",
        "examples": ["回到中间车道", "回中间车道", "返回中间车道", "走中间车道", "居中车道", "回到中间"],
    },
    "drive_speed_up": {
        "response": "好的，正在提高车速",
        "examples": ["提速", "快点", "加速", "开快点", "速度快点"],
    },
    "drive_slow_down": {
        "response": "好的，正在减速",
        "examples": ["减速", "慢一点", "慢下来", "开慢点", "速度放慢"],
    },
    "drive_pull_over": {
        "response": "好的，正准备靠边停车",
        "examples": ["靠边", "靠边停车", "靠边停", "停路边"],
    },
    "drive_resume_route": {
        "response": "好的，已重新启动导航行程",
        "examples": ["重新出发", "继续开", "继续导航", "继续行程", "接着走"],
    },
    "nav_open": {
        "response": "好的，为您打开导航规划",
        "examples": ["打开导航", "导航", "去哪", "规划路线", "搜目的地", "我要导航"],
    },
    "nav_close": {
        "response": "好的，导航规划已关闭",
        "examples": ["关闭导航", "退出导航", "关导航", "关掉导航", "开始导航", "出发了"],
    },
    "nav_set_destination": {
        "response": "目的地已为您设置",
        "parametric": True,
        "examples": ["导航到公司", "导航回家", "去公司", "回家", "目的地改成", "改去"],
    },
    "nav_add_waypoint": {
        "response": "好的，已添加途经点",
        "parametric": True,
        "examples": ["顺便去", "途经", "加一站", "绕一下", "顺路去接", "顺便接人"],
    },
    "nav_along_route_poi_start": {
        "response": "好的，我来帮您沿路搜索",
        "parametric": True,
        "examples": ["沿途搜加油站", "顺路找充电站", "沿路找咖啡店", "路上搜一下加油站", "沿途找书店"],
    },
    "nav_poi_candidate_pick": {
        "response": "好的",
        "parametric": True,
        "examples": ["第一个", "选第二个", "最后一个", "就这个", "选三"],
    },
    "nav_poi_candidate_cancel": {
        "response": "好的，已取消本次选点",
        "examples": ["取消", "算了", "不要了", "不选了"],
    },
    "ac_open": {
        "response": "好的，已打开空调控制",
        "examples": ["打开空调", "开空调", "把空调打开"],
    },
    "ac_close": {
        "response": "好的，关闭空调面板",
        "examples": ["关了空调", "关闭空调", "关空调", "把空调关掉"],
    },
    "ac_set_temperature": {
        "response": "好的，已调节空调温度",
        "parametric": True,
        "examples": ["空调二十四度", "调到26度", "温度低一点", "热一点", "冷一点"],
    },
    "ac_comfort_stuffy": {
        "response": "好的，已打开空调并加大风量，帮您换换气",
        "examples": ["有点闷", "太闷了", "透不过气", "空气不好", "车里闷", "我觉得闷"],
    },
    "ac_defog_front": {
        "response": "好的，已打开前挡除雾",
        "examples": ["起雾了", "前挡看不清", "玻璃模糊了", "除雾", "看不见路了"],
    },
    "music_open": {
        "response": "好的，打开音乐播放器",
        "examples": ["听歌", "来点音乐", "来首歌", "放音乐", "我想听歌"],
    },
    "music_toggle": {
        "response": "好的",
        "examples": ["暂停", "继续播放", "播放暂停", "别放了"],
    },
    "music_next": {
        "response": "好的，下一首",
        "examples": ["下一首", "切歌", "换一首"],
    },
    "music_prev": {
        "response": "好的，上一首",
        "examples": ["上一首", "前一首"],
    },
    "music_volume_up": {
        "response": "好的",
        "examples": ["大点声", "调大音量", "声音大点", "音量加大"],
    },
    "music_volume_down": {
        "response": "好的",
        "examples": ["小点声", "小声", "调小音量", "声音小点"],
    },
    "music_stop_exit": {
        "response": "好的，音乐已关闭",
        "examples": ["停止播放", "退出音乐", "关掉音乐", "别放了"],
    },
    "video_open": {
        "response": "好的，为您打开视频播放",
        "examples": ["看电影", "看视频", "放个片", "我想看电影", "打开视频"],
    },
    "video_close": {
        "response": "好的，已关闭视频",
        "examples": ["退出视频", "关闭视频", "关掉视频", "不看了"],
    },
    "video_pause": {
        "response": "好的，已暂停",
        "examples": ["暂停视频", "暂停播放", "先停一下"],
    },
    "video_resume": {
        "response": "好的，继续播放",
        "examples": ["继续播放", "接着播", "继续看"],
    },
    "video_next": {
        "response": "好的，下一条",
        "examples": ["下一个视频", "下一条", "换一个"],
    },
    "video_prev": {
        "response": "好的，上一条",
        "examples": ["上一个视频", "上一条", "前一个"],
    },
    "coffee_open": {
        "response": "好的，想喝点什么？可以看看菜单",
        "examples": ["点咖啡", "来杯咖啡", "想喝咖啡", "打开咖啡", "我要点喝的"],
    },
    "coffee_add_item": {
        "response": "好的，已加入购物车",
        "parametric": True,
        "examples": [
            "生椰拿铁",
            "来一个生椰拿铁",
            "橙C美式",
            "标准美式",
            "加浓美式",
            "经典拿铁",
            "摩卡",
            "轻乳茶",
            "两杯摩卡",
            "再来一杯",
        ],
    },
    "coffee_confirm_pay": {
        "response": "好的，请用手机扫屏幕上虚拟收款码",
        "examples": ["就这些", "去结账", "可以付款了", "没有了", "下单吧"],
    },
    "coffee_close": {
        "response": "好的，咖啡面板已关闭",
        "examples": ["关闭咖啡", "不点了", "退出咖啡"],
    },
    "scenic_open": {
        "response": "好的，我们来风景打卡",
        "examples": ["打卡", "风景打卡", "打开打卡", "记录风景", "好漂亮", "想看风景"],
    },
    "scenic_take_photo": {
        "response": "好的，准备倒计时拍照",
        "examples": ["拍照", "拍一张", "帮我拍", "抓拍", "快门", "倒计时拍照"],
    },
    "scenic_close": {
        "response": "好的，风景打卡已关闭",
        "examples": ["关闭打卡", "退出打卡", "关上打卡"],
    },
    "scenic_gallery_open": {
        "response": "好的，已打开打卡照片库",
        "examples": ["看照片", "打开照片库", "我的打卡", "看看拍的照片"],
    },
    "scenic_gallery_close": {
        "response": "好的，已退出照片库",
        "examples": ["退出照片", "关闭照片库"],
    },
    "dms_enable": {
        "response": "好的，已打开驾驶员监测",
        "examples": ["打开驾驶员监测", "开启DMS", "打开疲劳监测", "开启疲劳检测"],
    },
    "dms_disable": {
        "response": "好的，已关闭驾驶员监测",
        "examples": ["关闭DMS", "关掉疲劳监测", "关闭驾驶员监测"],
    },
    "msg_read_last": {
        "response": "好的，我来读最新一条信息",
        "examples": ["读信息", "读一下信息", "谁发的信息", "最新消息", "念一下信息"],
    },
    "msg_reply_send": {
        "response": "好的，已发送回复",
        "parametric": True,
        "examples": ["回复说", "帮我回", "发条消息说", "告诉他"],
    },
}


def iter_intent_examples():
    """Yield (action, example_phrase) for index building."""
    for action, meta in COCKPIT_INTENT_CATALOG.items():
        for ex in meta.get("examples") or []:
            phrase = str(ex).strip()
            if phrase:
                yield action, phrase


def is_parametric_intent(action: str) -> bool:
    meta = COCKPIT_INTENT_CATALOG.get(action) or {}
    return bool(meta.get("parametric"))


def default_response_for(action: str) -> str:
    meta = COCKPIT_INTENT_CATALOG.get(action) or {}
    return str(meta.get("response") or "好的")
