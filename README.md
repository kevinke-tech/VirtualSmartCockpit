# Virtual Smart Cockpit

一个可在浏览器中运行的虚拟智能座舱演示：包含导航、驾驶控制、空调、音乐、视频、消息、咖啡点单、风景打卡、DMS/OCC 乘员感知，以及语音 ASR → 意图识别 → 动作执行 → TTS 的完整链路。

本仓库可以独立运行，不依赖 Cursor、VS Code Task 或特定 IDE。VOX 动态技能后端是可选扩展。

## 主要技术

- 前端：HTML/CSS/JavaScript、Three.js、Leaflet、MediaPipe Tasks Vision
- 后端：Python、FastAPI
- 本地 ASR：FunASR `paraformer-zh`
- 本地意图初筛：规则 + `text2vec-base-chinese` embedding；不可用时自动降级为字符串模糊匹配
- 大模型兜底：火山方舟 Ark（默认模型可在 `.env.local` 中修改）
- TTS：火山引擎语音合成
- OCC 视觉兜底：火山方舟视觉模型，或 OpenAI-compatible vLLM 服务

## 运行环境

- 推荐 Python 3.12（最低建议 3.10）
- Windows 10/11、macOS 或 Linux
- 首次安装需要访问 PyPI；首次 ASR/embedding 使用还会下载开源模型
- 摄像头、麦克风能力需要浏览器授权

## 快速开始：Windows PowerShell

### 1. 获取代码

```powershell
git clone https://github.com/kevinke-tech/VirtualSmartCockpit.git
cd VirtualSmartCockpit
```

### 2. 首次安装

以下脚本会创建项目自己的 `.venv`、安装 `requirements.txt`，并在不存在时把 `.env.example` 复制为 `.env.local`：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1
```

依赖和模型体积较大，首次安装需要一些时间；后续启动不会重复安装。

### 3. 配置自己的密钥

```powershell
notepad .env.local
```

按照文件内注释填写自己的 Ark、TTS 或 vLLM 配置。不要把 `.env.local` 发给他人或提交到 Git。

### 4. 启动

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-demo.ps1
```

浏览器打开：

```text
http://127.0.0.1:5002
```

健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:5002/health
```

### 5. 停止

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\stop-all.ps1
```

## 快速开始：macOS / Linux

```bash
git clone https://github.com/kevinke-tech/VirtualSmartCockpit.git
cd VirtualSmartCockpit

python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt

cp .env.example .env.local
# 用任意编辑器填写自己的配置
nano .env.local

python server.py
```

然后访问 `http://127.0.0.1:5002`。

## `.env.local` 配置说明

程序启动时先读取 `.env`，再读取 `.env.local`；后者优先。仓库已经忽略这两个真实配置文件，只应提交不含密钥的 `.env.example`。

### 火山方舟大模型

用于复杂意图识别和闲聊兜底：

```env
ARK_API_KEY=your-own-key
CHAT_DOUBAO_MODEL=doubao-seed-2-0-mini-260215
```

每位使用者都应到火山方舟控制台创建自己的 Key，并确认配置的模型或 Endpoint 已在其账号中开通：

```text
https://console.volcengine.com/ark
```

未配置 `ARK_API_KEY` 时，本地 ASR、规则意图和本地意图仍可使用，但复杂指令和闲聊无法走大模型兜底。

### 本地 FunASR

不需要 API Key：

```env
FUNASR_OFFLINE_MODEL=paraformer-zh
FUNASR_HOTWORDS=虚拟座舱 导航 超车 空调 除雾 生椰拿铁 摩卡
```

首次启动会从 ModelScope 下载并缓存模型。终端出现模型下载日志不代表每次都在重新安装依赖。

### 本地意图识别

不需要 API Key：

```env
INTENT_LOCAL_ENABLED=1
INTENT_LOCAL_MODEL=shibing624/text2vec-base-chinese
INTENT_LOCAL_THRESHOLD=0.58
INTENT_LOCAL_MARGIN=0.03
INTENT_LOCAL_PRELOAD=0
```

embedding 模型不可用时，程序会自动退化为本地字符串模糊匹配。

### TTS 语音合成

到火山引擎语音服务控制台创建自己的应用和凭据：

```text
https://console.volcengine.com/speech/service
```

```env
VOLC_TTS_APP_ID=your-app-id
VOLC_TTS_ACCESS_TOKEN=your-access-token
VOLC_TTS_SECRET_KEY=your-secret-key
VOLC_TTS_VOICE_TYPE=zh_female_sajiaonvyou_moon_bigtts
```

不配置时页面仍可运行，但在线语音播报不可用。

### OCC 视觉模型

方案 A：使用自己账号下的火山方舟视觉模型：

```env
OCC_VISION_BACKEND=doubao
CHAT_VISION_MODEL=your-vision-model-or-endpoint-id
```

该方案复用 `ARK_API_KEY`。

方案 B：使用自己可访问的 OpenAI-compatible vLLM：

```env
OCC_VISION_BACKEND=vllm
OCC_VLLM_BASE_URL=http://your-vllm-host:port/v1
OCC_VLLM_MODEL=your-model-name-or-path
OCC_VLLM_API_KEY=
OCC_VLLM_TIMEOUT_SEC=45
```

不要把公司内网 IP、内部模型地址或真实 API Key 写进 `.env.example`。

## 语音使用

- 默认开启“会议模式”：按住空格键或麦克风按钮说话，松开后识别。
- 会议模式可避免持续拾取电脑扬声器中的会议声音。
- 关闭会议模式后恢复持续监听；空格键仍可随时按住说话。
- ASR 日志会输出音频时长、RMS、峰值和削波比例，便于排查麦克风问题。

## 可选：VOX 动态技能

VOX 不属于本仓库的必需依赖。只运行 `run-demo.ps1` 即可使用座舱主体功能。

如果团队同时拥有 VOX 仓库，并放在本仓库可解析的相对位置 `../claudeCode/vox`，Windows 下可以：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-vox.ps1
```

或者同时启动两个服务：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-all.ps1
```

- Cockpit：`http://127.0.0.1:5002`
- VOX：`http://127.0.0.1:5001`

VOX 使用它自己的依赖和环境配置，请参考 VOX 仓库文档。没有 VOX 仓库的同事不要运行 `run-vox.ps1` 或 `run-all.ps1`。

## 常见问题

### 页面显示“后端未就绪 (ASR)”

确认 `python server.py` 仍在运行，并访问 `http://127.0.0.1:5002/health`。

### 首次启动很慢

FunASR 和 sentence-transformers 首次使用需要下载模型。安装完成且模型进入用户缓存后，后续不会重复完整下载。

### ASR 经常听错

- 使用会议模式并按住按键说完整句话。
- 检查浏览器选中的麦克风是否正确。
- 尽量避免扬声器回声；耳机效果通常更稳定。
- 查看后端 `[ASR]` 日志中的 `rms`、`peak` 和 `clip`。

### VOX 面板显示未连接

VOX 是可选服务。需要使用时确认其监听 `5001`；不需要时可以忽略。

### PowerShell 禁止运行脚本

使用本文中的 `powershell -ExecutionPolicy Bypass -File ...` 启动方式，不需要永久修改系统执行策略。

## 提交到 GitHub

提交前先确认没有真实凭据：

```powershell
git status
git check-ignore .env.local
git diff --cached
```

`git check-ignore .env.local` 应显示 `.env.local`；`git diff --cached` 中不应出现任何真实 Key、Token、密码、内网地址或个人数据。

提交并推送：

```powershell
git add .
git commit -m "完善虚拟座舱能力与开源使用文档"
git push -u origin main
```

本仓库当前远端地址应为：

```text
https://github.com/kevinke-tech/VirtualSmartCockpit.git
```

如果是首次关联其他 GitHub 仓库：

```powershell
git remote add origin https://github.com/<your-account>/<your-repo>.git
git branch -M main
git push -u origin main
```

要向所有同事公开，在 GitHub 仓库页面进入：

```text
Settings → General → Danger Zone → Change repository visibility → Public
```

如果只想向指定同事开放，可以保持 Private，并在：

```text
Settings → Collaborators and teams
```

邀请同事。

建议公开前启用 GitHub Secret scanning，并在 `main` 分支配置 Pull Request 保护规则。

## 安全提醒

- 永远不要提交 `.env.local`、`.env`、私钥、访问令牌或公司内网凭据。
- 如果某个 Key 曾被提交到 Git 历史，仅从最新文件删除是不够的；应立即在服务控制台吊销并重新生成。
- 同事应复制 `.env.example`，各自维护自己的 `.env.local`。

## License

本项目使用 [GNU Affero General Public License v3.0](LICENSE)。分发、修改或通过网络向他人提供修改版本时，请遵守 AGPL-3.0 的源代码开放要求。
