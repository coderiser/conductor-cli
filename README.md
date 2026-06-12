# Conductor

Windows Agent Workbench — 基于 Electron 的多 Agent 终端工作台。

![Screenshot](docs/images/screenshot.jpg)

## 快速开始

### 环境要求

- Windows 10/11
- [Node.js](https://nodejs.org/) 18+

### 安装与运行

```bash
git clone <repo-url>
cd conductor-cli
npm install
npm run dev
```

启动后打开原生 Windows 窗口，默认加载 `cmd.exe` 终端面板。PTY Daemon 会自动启动。

### 构建与打包

```bash
npm run build       # 编译 Electron + Daemon
npm run package     # 打包 .exe 安装程序
```

> 将项目目录加入 `PATH` 后可在任意位置使用 `conductor` 命令。

### 基本操作

| 操作 | 方式 |
|------|------|
| 新建终端 | 侧边栏 `+ New Terminal` 或 `Ctrl+N` |
| 指定工作目录 | 侧边栏 `working dir` 输入框填入路径后新建 |
| 关闭终端 | 侧边栏 `kill current` 或 `Ctrl+W` |
| 切换面板 | `F1`-`F9` |
| 广播输入 | 勾选 `broadcast`，输入命令后点 `▶` |
| 复制文字 | 鼠标拖选 + `Ctrl+Shift+C` 或右键 |
| 退出 | `F10` |

---

## CLI 命令

| 命令 | 别名 | 说明 |
|------|------|------|
| `conductor` | | 启动桌面应用（默认） |
| `conductor start` | `s` | 启动桌面应用 |
| `conductor dev` | | 开发模式（热重载） |
| `conductor build` | `b` | 编译生产版本 |
| `conductor package` | | 打包 .exe 安装程序 |
| `conductor restart` | `r` | 杀掉并重启 |
| `conductor kill` | `k` | 终止所有进程 |
| `conductor status` | `st` | 查看运行状态 |
| `conductor clean` | | 清除构建产物 |
| `conductor version` | `-v` | 显示版本号 |
| `conductor help` | `-h` | 显示帮助 |

---

## 架构

```
Electron (Main Process)          PTY Daemon (Node.js)          Renderer (React)
┌──────────────────────┐    ┌──────────────────────────┐    ┌────────────────────┐
│ Daemon Client        │◄──►│ node-pty (ConPTY)        │    │ xterm.js Canvas    │
│ SQLite (better-      │    │ Session Recovery         │    │ CSS Grid 动态布局   │
│   sqlite3)           │    │ Agent Config Loader      │    │ Zustand 状态管理    │
│ Git Detection        │    │ Named Pipe Server        │    │ @xterm/addons      │
│ IPC Bridge           │    │ 4-byte length-prefixed   │    │ Context Isolation  │
│                      │    │   JSON frames            │    │                    │
└──────────────────────┘    └──────────────────────────┘    └────────────────────┘
       ▲                                                           ▲
       │                    Electron IPC                           │
       └───────────────────────────────────────────────────────────┘
```

**PTY Daemon** 是独立的 Node.js 进程，通过 Named Pipe 与 Electron 主进程通信。Electron 自动启动和管理 Daemon 生命周期。

---

## Agent 配置

`agents.json` 位于项目根目录（与 `conductor.cmd` 同级），首次启动自动生成默认配置。

```json
{
  "agents": [
    { "id": "cmd", "name": "Command Prompt", "command": "cmd.exe", "args": [], "builtin": true },
    { "id": "claude", "name": "Claude Code", "command": "claude", "args": [], "builtin": false },
    { "id": "opencode", "name": "OpenCode", "command": "opencode", "args": [], "builtin": false },
    { "id": "codex", "name": "Codex", "command": "codex", "args": [], "builtin": false }
  ]
}
```

添加自定义 Agent：

```json
{
  "id": "my-agent",
  "name": "My Company Agent",
  "command": "D:\\tools\\agent.exe",
  "args": ["--interactive", "--workspace"],
  "builtin": false
}
```

| 字段 | 说明 |
|------|------|
| `id` | 唯一标识，对应 spawn 命令 |
| `name` | 侧边栏显示名称 |
| `command` | 可执行文件路径或命令名 |
| `args` | 启动参数（可选） |
| `create_template` | 新建会话模板，`{session_id}` 替换为 Conductor 生成的 UUID |
| `resume_template` | 恢复会话模板，`{session_id}` 替换为 Agent 真实 session ID |
| `setup` | 启动前执行的命令数组（如 `["npm install"]`） |
| `builtin` | `true` = 始终显示；`false` = PATH 检测到才显示 |

**会话恢复示例**：

```json
{
  "id": "claude",
  "create_template": "--session-id {session_id}",
  "resume_template": "--resume {session_id}"
}
```
- 新建时：`claude --session-id <uuid>`
- 恢复时：`claude --resume <captured-id>`

---

## 功能

- **Electron 桌面窗口** — Electron + electron-vite，原生系统托盘
- **PTY Daemon 架构** — 独立 Node.js 进程管理所有 PTY，Named Pipe IPC 通信
- **可配置 Agent** — `agents.json` 配置任意 Agent 类型和启动命令
- **会话恢复** — Claude Code / OpenCode / Codex 关闭重开后自动恢复上次会话
- **多 Agent PTY** — 同时运行 Claude Code / OpenCode / Codex / cmd.exe 及自定义 Agent
- **动态格网布局** — 1=全屏, 2=双列, 3=2+1跨行, 4=2×2, 5=2×2+跨行, 6+=3列
- **工作目录** — 新建终端时指定起始目录
- **广播模式** — 同时向所有终端发送输入
- **文本选择** — 鼠标拖选 + Ctrl+Shift+C 复制
- **终端搜索** — Ctrl+F 搜索终端内容
- **Git 分支检测** — 自动检测工作目录的 Git 分支并显示在面板
- **SQLite 持久化** — better-sqlite3 存储会话历史和输出日志
- **进程清理** — 窗口关闭时自动终止所有子 PTY 进程
- **全彩色** — xterm.js Canvas 渲染，256 色

---

## 侧边栏

| 分区 | 内容 |
|------|------|
| Stats | Tasks / Tokens / Running / Failed / Duration |
| Commands | + New Terminal + working dir 输入 + 动态 Agent 快捷命令 |
| Sessions | 会话卡片：状态圆点、Agent、运行时长、工作目录、Git 分支 |
| Input | Broadcast 开关 + 命令输入框 + 发送按钮 |
| Log | 时间戳事件流（启动/退出/终止） |

---

## 会话恢复架构

```
spawn 前快照 → spawn Agent → 3s 延迟 → spawn 后快照 → diff 获取新 session ID
                                                              ↓
恢复 ← SQLite ← resumeId ← 前端 ← IPC event ←───────────────┘
```

| Agent | 发现机制 | 恢复命令 |
|-------|---------|---------|
| Claude Code | stdout 正则捕获 `Session ID: <uuid>` | `--resume {uuid}` |
| OpenCode | `opencode db "SELECT id FROM session"` | `--session {ses_xxx}` |
| Codex | 扫描 `~/.codex/sessions/` 目录 | `resume --last` |

启动前快照确保并发安全：同一类型 Agent 短时间内启动多个，各自通过 before/after diff 精确定位自己的 session。

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面壳 | Electron 40, electron-vite 4 |
| PTY 管理 | node-pty 1.x (ConPTY)，独立 Daemon 进程 |
| IPC | Named Pipe，4-byte length-prefixed JSON frames |
| 前端 | React 19, xterm.js 6, Zustand |
| 布局 | CSS Grid（动态格网算法） |
| 存储 | SQLite (better-sqlite3) |
| Git | simple-git |
| 配置 | JSON（agents.json，项目根目录） |
| 样式 | CSS 自定义属性 + WebKit 滚动条 |

---

## 快捷键

| 按键 | 功能 |
|------|------|
| `F1`-`F9` | 切换到第 N 个面板 |
| `Ctrl+N` | 新建终端 |
| `Ctrl+W` | 关闭当前面板 |
| `Ctrl+Shift+C` | 复制选中文字 |
| `Ctrl+F` | 终端内搜索 |
| `Ctrl+K` / `Ctrl+L` | 清屏 |
| `F10` | 退出 |
