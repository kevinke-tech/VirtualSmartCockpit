# Virtual Smart Cockpit

一个前端虚拟座舱 + Python 后端 + VOX 智能体联动的演示工程。

---

## 1. 工程结构与 VOX 的关系

本工程默认与目录 `../claudeCode/vox` 协作运行：

- `VirtualSmartCockpit`（本仓库）
  - 负责座舱 UI（导航/音乐/消息/打卡/行车场景）
  - 负责语音入口（ASR/VAD/TTS 编排）和座舱意图执行
  - 默认后端端口：`5002`
- `vox`（兄弟仓库）
  - 负责 VOX 智能体规划、视觉监视、动态技能等能力
  - 默认后端端口：`5001`

### 1.1 调用关系（运行时）

1. 用户在座舱内发出语音/文本指令  
2. 本工程优先匹配并执行“已有座舱能力”（如导航、空调、音乐等）  
3. 若属于 VOX 能力或本地能力不命中，则通过前端 VOX 面板和后端联动调用 `5001`  
4. VOX 结果回传座舱前端展示/播报

可以理解为：

- 本工程 = 主应用（UI + 主流程）
- VOX = 可插拔智能体能力后端（高级规划/视觉/动态技能）

---

## 2. 运行前准备

- Windows 10/11（推荐 PowerShell）
- Python `3.12`（VOX 任务脚本按 3.12 管理虚拟环境）
- 建议目录结构：
  - `E:\21_Coding\VirtualSmartCockpit`
  - `E:\21_Coding\claudeCode\vox`

---

## 3. 推荐：给同事的一键脚本（不用 Cursor）

先进入本项目目录：

```powershell
cd E:\21_Coding\VirtualSmartCockpit
```

### 3.1 一键启动 Cockpit + VOX（推荐）

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-all.ps1
```

### 3.2 分开启动（两个终端）

终端 A：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-demo.ps1
```

终端 B：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-vox.ps1
```

### 3.3 一键停止 Cockpit + VOX

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\stop-all.ps1
```

---

## 4. 原始命令（与 VSCode/ Cursor Tasks 对齐）

以下命令等价于 `.vscode/tasks.json` 里的 Run Task。

先进入本项目目录：

```powershell
cd E:\21_Coding\VirtualSmartCockpit
```

### 4.1 启动座舱后端（等价 `🚀 Run Demo`）

```powershell
if (Test-Path .venv\Scripts\Activate.ps1) { . .venv\Scripts\Activate.ps1 } elseif (Test-Path ..\vui\.venv\Scripts\Activate.ps1) { . ..\vui\.venv\Scripts\Activate.ps1 } elseif (Test-Path venv\Scripts\Activate.ps1) { . venv\Scripts\Activate.ps1 }; python server.py
```

启动后访问：`http://127.0.0.1:5002`

### 4.2 启动 VOX 后端（等价 `🚀 Run VOX Backend`）

```powershell
$voxRoot = (Resolve-Path ..\claudeCode\vox).Path; $venvRoot = Join-Path $voxRoot '.venv-win'; $py = Join-Path $venvRoot 'Scripts\python.exe'; if (Test-Path $py) { $maj = (& $py -c 'import sys; print(sys.version_info[0])'); $min = (& $py -c 'import sys; print(sys.version_info[1])'); if (("$maj.$min") -ne '3.12') { Remove-Item -Recurse -Force $venvRoot -ErrorAction SilentlyContinue } }; if (!(Test-Path $py)) { py -3.12 -m venv $venvRoot }; $py = Join-Path $venvRoot 'Scripts\python.exe'; $needInstall = $true; if (Test-Path $py) { & $py -c 'import httpx, claude_agent_sdk' 2>$null; if ($LASTEXITCODE -eq 0) { $needInstall = $false } }; if ($needInstall) { & $py -m pip install -U pip; & $py -m pip install -r (Join-Path $voxRoot 'requirements.txt'); & $py -m pip install claude-agent-sdk }; Set-Location $voxRoot; & $py server.py
```

### 4.3 同时启动 Cockpit + VOX（等价 `🚀 Run Cockpit + VOX`）

开两个 PowerShell 窗口：

- 窗口 A：执行 **3.1**
- 窗口 B：执行 **3.2**

---

## 5. 停止服务（命令行）

### 5.1 仅停止座舱（等价 `🛑 Stop Demo`）

```powershell
$p = Get-NetTCPConnection -LocalPort 5002 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; if ($p) { $p | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }; Write-Host 'Cockpit (port 5002) stopped.' } else { Write-Host 'No listener on port 5002.' }
```

### 5.2 停止 Cockpit + VOX（等价 `🛑 Stop Cockpit + VOX`）

```powershell
$ports = @(5002,5001); foreach ($port in $ports) { $p = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; if ($p) { $p | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } } }; Write-Host 'Cockpit(5002) + VOX(5001) stopped.'
```

---

## 6. 常见问题

- VOX 面板显示未连接：
  - 确认 `../claudeCode/vox` 已启动并监听 `5001`
  - 在座舱 VOX 面板中检查后端地址是否为 `http://127.0.0.1:5001`
- 座舱打不开：
  - 确认 `5002` 端口未被占用
  - 重新执行第 4 节停止命令后再启动
- 同事机器目录不同：
  - 只要保证本仓库相对于 VOX 的路径为 `..\claudeCode\vox` 可解析即可
- 脚本被系统策略拦截：
  - 使用 `powershell -ExecutionPolicy Bypass -File <script.ps1>` 方式运行即可

