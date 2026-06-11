# Conductor V2: Electron 迁移 + 竞品融合设计

**日期:** 2026-06-11  
**状态:** 已批准  
**目标平台:** Windows Only

## 概述

将 Conductor 从 Tauri/Rust 迁移到 Electron/Node.js，同时融合 cmux、ghostty、superset 的最佳特性，打造 AI Agent 终端管理器的差异化产品。

## 架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                    Conductor V2 Architecture                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────────┐    Named Pipe    ┌──────────────────┐ │
│  │   pty-daemon (Node)  │◄════════════════►│ Electron 主进程   │ │
│  │                      │  \\.\pipe\       │                  │ │
│  │  ┌─ PtyManager ────┐ │                  │  ┌─ DaemonClient┐ │ │
│  │  │ node-pty spawn  │ │                  │  │  reconnect   │ │ │
│  │  │ session map     │ │                  │  └──────────────┘ │ │
│  │  │ 64KB ring buffer│ │                  │  ┌─ WindowManager┐ │ │
│  │  └────────────────┘ │ │                  │  │  窗口/托盘    │ │ │
│  │  ┌─ Protocol ──────┐ │ │                  │  └──────────────┘ │ │
│  │  │ versioned msgs  │ │ │                  │  ┌─ StatsCollector┐│ │
│  │  │ framing codec   │ │ │                  │  │  Token/Cost   │ │ │
│  │  └────────────────┘ │ │                  │  └──────────────┘ │ │
│  │  ┌─ SessionStore ──┐ │ │                  │  ┌─ NotifyCenter┐  │ │
│  │  │ agent_session_id│ │ │                  │  │  蓝色环/面板  │  │ │
│  │  │ recovery        │ │ │                  │  └──────────────┘ │ │
│  │  └────────────────┘ │ │                  └──────────────────┘ │
│  │  ┌─ WorktreeMgr ───┐ │ │                          │           │
│  │  │ git worktree    │ │ │                          ▼ IPC       │
│  │  └────────────────┘ │ │            ┌──────────────────────┐  │
│  └──────────────────────┘ │            │   Electron 渲染进程   │  │
│                           │            │                      │  │
│  ┌──────────────────────┐ │            │  React + xterm.js    │  │
│  │   SQLite (共享)      │ │            │  CSS Grid 动态布局    │  │
│  │   sessions/layout    │ │            │  Sidebar + 通知面板   │  │
│  │   stats/tokens       │ │            │  Agent 状态仪表盘     │  │
│  └──────────────────────┘ │            └──────────────────────┘  │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │   agents.json (配置) + worktree 策略                       │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 核心原则

- Daemon 无状态（每次调用携带完整上下文）
- 协议版本化（hello/hello-ack 握手）
- Auth = Named Pipe ACL（Windows 比 Unix socket 更安全）
- Agent Session Recovery 在 daemon 层实现
- 数据统计在 Electron 主进程层汇总
- Git worktree 隔离在 daemon 层管理

---

## Section 1: PTY Daemon 详细设计

### 项目结构

```
pty-daemon/
├── src/
│   ├── main.ts              # 入口：启动 Server
│   ├── server.ts            # Named Pipe 监听 + 客户端管理
│   ├── pty-manager.ts       # node-pty 封装 + 生命周期
│   ├── session-store.ts     # 会话持久化 + ring buffer
│   ├── session-recovery.ts  # Agent session ID 发现
│   ├── handlers.ts          # 协议处理（纯函数）
│   ├── protocol/
│   │   ├── messages.ts      # ClientMessage / DaemonMessage 定义
│   │   ├── framing.ts       # 4字节长度前缀编解码
│   │   └── version.ts       # 协议版本协商
│   └── agents/
│       ├── config.ts        # agents.json 加载 + 模板解析
│       ├── discovery.ts     # OpenCode DB / Codex sessions 发现
│       └── types.ts         # AgentConfig 类型
```

### 协议消息

```typescript
// Client → Daemon
type ClientMessage =
  | { type: 'hello'; version: number }
  | { type: 'spawn'; agent: string; cwd: string; cols: number; rows: number;
      agentSessionId?: string; isRestore: boolean; worktree?: WorktreeConfig }
  | { type: 'write'; sessionId: string; data: string }
  | { type: 'resize'; sessionId: string; cols: number; rows: number }
  | { type: 'kill'; sessionId: string }
  | { type: 'list' }
  | { type: 'set-agent-session-id'; sessionId: string; agentSessionId: string }

// Daemon → Electron
type DaemonMessage =
  | { type: 'hello-ack'; version: number }
  | { type: 'spawned'; sessionId: string; pid: number; agent: string;
      agentSessionId: string; worktreePath?: string }
  | { type: 'output'; sessionId: string; data: string }
  | { type: 'exit'; sessionId: string; code: number }
  | { type: 'session-id-changed'; sessionId: string; agentSessionId: string }
  | { type: 'worktree-status'; sessionId: string; branch: string; conflicts: string[] }
  | { type: 'error'; message: string }
```

### Session Recovery（从 Rust 迁移，大幅简化）

```typescript
// 之前 Rust 版本 ~80 行，现在 ~20 行
async function discoverSessionId(agent: string, cwd: string): Promise<string[]> {
  if (agent === 'opencode') {
    const { stdout } = execSync('opencode db "SELECT id FROM session"', { cwd });
    return stdout.split('\n').filter(l => l.trim().startsWith('ses_'));
  }
  if (agent === 'codex') {
    const dir = path.join(os.homedir(), '.codex', 'sessions');
    return scanCodexSessions(dir);
  }
  return [];
}
```

### Named Pipe 通信（Windows 优势）

```typescript
// Windows Named Pipe 比 Unix Socket 更简单
const PIPE_PATH = '\\\\.\\pipe\\conductor-pty-daemon';

// Server 端
const server = net.createServer();
server.listen(PIPE_PATH);

// Client 端（Electron 主进程）
const client = net.connect(PIPE_PATH);
```

### Daemon 生命周期

```
conductor start
  ├── Electron 启动
  ├── 检查 daemon 是否运行（尝试连接 Named Pipe）
  │   ├── 已运行 → 直接连接
  │   └── 未运行 → spawn daemon 进程 → 等待就绪
  ├── hello/hello-ack 握手
  └── 恢复上次会话

窗口关闭
  ├── Electron → daemon: kill all sessions
  ├── Daemon 清理 PTY 进程树
  └── Daemon 保持运行（下次启动秒连）

用户退出 Conductor（托盘退出）
  ├── Electron → daemon: shutdown
  └── Daemon 进程退出
```

---

## Section 2: Electron 主进程 + 渲染进程

### 项目结构

```
conductor/
├── package.json
├── electron-builder.ts          # 打包配置
├── electron.vite.config.ts      # Vite + Electron 构建
├── src/
│   ├── main/                    # Electron 主进程
│   │   ├── index.ts             # 入口：窗口创建 + daemon 启动
│   │   ├── daemon-client.ts     # Named Pipe 客户端 + 重连
│   │   ├── ipc-handlers.ts      # ipcMain 处理器（桥接渲染↔daemon）
│   │   ├── notify-center.ts     # Agent 通知系统
│   │   ├── stats-collector.ts   # Token/Cost/健康统计
│   │   ├── window-manager.ts    # 窗口生命周期 + 快捷键
│   │   ├── tray.ts              # 系统托盘
│   │   └── worktree-manager.ts  # Git worktree 管理
│   ├── renderer/                # 渲染进程（现有代码复用）
│   │   ├── App.tsx              # 主编排（从 Tauri 版迁移）
│   │   ├── main.tsx             # React 入口
│   │   ├── components/
│   │   │   ├── Sidebar.tsx      # 侧边栏（复用 + 增强）
│   │   │   ├── TerminalPanel.tsx # 终端面板（复用）
│   │   │   ├── NotifyPanel.tsx  # 🆕 通知面板
│   │   │   ├── AgentDashboard.tsx # 🆕 Agent 状态仪表盘
│   │   │   └── WorktreeStatus.tsx # 🆕 worktree 状态显示
│   │   ├── hooks/
│   │   │   └── usePty.ts        # PTY hook（改为 ipcRenderer 调用）
│   │   ├── lib/
│   │   │   ├── pty-ipc.ts       # 替代 tauri-ipc.ts
│   │   │   └── terminal-theme.ts # 复用
│   │   └── store/
│   │       └── sessions.ts      # Zustand（复用）
│   └── daemon/                  # PTY Daemon（独立进程）
│       ├── main.ts
│       ├── server.ts
│       ├── pty-manager.ts
│       ├── session-store.ts
│       ├── session-recovery.ts
│       ├── handlers.ts
│       ├── protocol/
│       │   ├── messages.ts
│       │   ├── framing.ts
│       │   └── version.ts
│       └── agents/
│           ├── config.ts
│           ├── discovery.ts
│           └── types.ts
├── agents.json                  # Agent 配置（复用）
└── resources/                   # 图标等资源
```

### IPC 桥接层（替代 Tauri invoke）

```typescript
// src/renderer/lib/pty-ipc.ts
// 几乎 1:1 对应现有 tauri-ipc.ts

export const pty = {
  spawn: (agent, cwd, cols, rows, agentSessionId, isRestore) =>
    ipcRenderer.invoke('pty_spawn', { agent, cwd, cols, rows, agentSessionId, isRestore }),
  write: (sessionId, data) =>
    ipcRenderer.invoke('pty_write', { sessionId, data }),
  resize: (sessionId, cols, rows) =>
    ipcRenderer.invoke('pty_resize', { sessionId, cols, rows }),
  kill: (sessionId) =>
    ipcRenderer.invoke('pty_kill', { sessionId }),
  setAgentSessionId: (sessionId, agentSessionId) =>
    ipcRenderer.invoke('pty_set_agent_session_id', { sessionId, agentSessionId }),
  // 事件监听改为 Electron IPC
  onOutput: (id, handler) =>
    ipcRenderer.on(`pty-output-${id}`, (_e, data) => handler(data.data)),
  onExit: (id, handler) =>
    ipcRenderer.on(`pty-exit-${id}`, (_e, data) => handler(data.exitCode)),
  onSessionIdChanged: (id, handler) =>
    ipcRenderer.on(`pty-session-id-changed-${id}`, (_e, data) => handler(data.agentSessionId)),
};
```

### 主进程 IPC 转发（Electron ↔ Daemon）

```typescript
// src/main/ipc-handlers.ts
// 简单转发：渲染进程请求 → 主进程 → daemon → 返回

ipcMain.handle('pty_spawn', async (_, args) => {
  return daemonClient.request({ type: 'spawn', ...args });
});

ipcMain.handle('pty_write', async (_, args) => {
  return daemonClient.request({ type: 'write', ...args });
});

// Daemon 推送 → 主进程 → 渲染进程
daemonClient.on('output', (msg) => {
  mainWindow.webContents.send(`pty-output-${msg.sessionId}`, msg);
});
daemonClient.on('exit', (msg) => {
  mainWindow.webContents.send(`pty-exit-${msg.sessionId}`, msg);
});
daemonClient.on('session-id-changed', (msg) => {
  mainWindow.webContents.send(`pty-session-id-changed-${msg.sessionId}`, msg);
});
```

### 现有功能保留清单

| 功能 | 迁移方式 | 工作量 |
|------|---------|--------|
| 多 Agent PTY | node-pty 替代 portable-pty | 中 |
| 动态格网布局 | CSS Grid 不变 | 零 |
| 会话恢复 | daemon 层实现（更简单） | 小 |
| agents.json 配置 | 直接复用 | 零 |
| Terminal 搜索 Ctrl+F | xterm addon-search 不变 | 零 |
| Terminal 清屏 Ctrl+K/L | xterm 不变 | 零 |
| Setup 脚本 | daemon spawn 时注入 | 小 |
| 广播模式 | 前端不变 | 零 |
| SQLite 持久化 | better-sqlite3 替代 rusqlite | 小 |
| Git 分支检测 | simple-git 替代 git2 | 小 |
| 复制/粘贴 | xterm clipboard addon 不变 | 零 |
| 进程清理 | daemon 负责进程树 | 中 |

**估算：前端代码 90% 复用，Rust 代码全部删除用 Node.js 重写（代码量减半）。**

---

## Section 3: Git Worktree 隔离

### 架构

```
项目仓库: E:\workspace\my-project\ (main)
  │
  ├── .git/
  │   └── worktrees/
  │       ├── conductor-claude-01/   ← Claude 的独立 worktree
  │       ├── conductor-opencode-02/  ← OpenCode 的独立 worktree
  │       └── conductor-codex-03/     ← Codex 的独立 worktree
  │
  ├── conductor-claude-01/     ← 自动 cd 到这里
  ├── conductor-opencode-02/
  └── conductor-codex-03/
```

### Worktree Manager

```typescript
// worktree-manager.ts
class WorktreeManager {
  private git: SimpleGit;
  
  // 为 agent 创建独立 worktree
  async createForAgent(agentId: string, projectPath: string, config: WorktreeConfig): Promise<WorktreeInfo> {
    const branchName = `conductor/${agentId}-${Date.now()}`;
    const worktreePath = path.join(projectPath, `conductor-${agentId}-${shortId}`);
    
    await this.git.cwd(projectPath).raw([
      'worktree', 'add', worktreePath, '-b', branchName, config.baseBranch
    ]);
    
    return { path: worktreePath, branch: branchName, agentId };
  }
  
  // Agent 结束时合并/清理
  async cleanup(worktree: WorktreeInfo, options: CleanupOptions) {
    if (options.merge) {
      await this.git.cwd(projectPath).merge([worktree.branch]);
    }
    await this.git.cwd(projectPath).raw(['worktree', 'remove', worktree.path]);
    await this.git.cwd(projectPath).raw(['branch', '-d', worktree.branch]);
  }
  
  // 冲突检测
  async detectConflicts(worktrees: WorktreeInfo[]): Promise<ConflictReport> {
    // 比较各 worktree 的修改文件列表
    // 如果两个 agent 改了同一文件，返回冲突报告
  }
}
```

### 交互流程

```
用户点击 "+ Claude" 时：
  ┌─ 选项面板 ──────────────────────┐
  │  Agent: Claude Code             │
  │  Project: E:\workspace\my-proj  │
  │  Worktree:  ☑ 独立 Worktree     │
  │  Based on:  ● main ○ 自定义分支 │
  │  Cleanup:   ● 合并后删除        │
  │             ○ 保留分支           │
  │             ○ 每次询问           │
  └─────────────────────────────────┘
```

### Daemon 集成

```typescript
// spawn 时自动处理 worktree
async function handleSpawn(msg: ClientMessage & { type: 'spawn' }) {
  let cwd = msg.cwd;
  
  if (msg.worktree) {
    const worktree = await worktreeManager.createForAgent(
      msg.agent, msg.cwd, msg.worktree
    );
    cwd = worktree.path;  // Agent 在 worktree 中启动
    sessionStore.setWorktree(sessionId, worktree);
  }
  
  const ptyProcess = nodePty.spawn(msg.agent, [], { cwd, ... });
  // ...
}
```

### Sidebar 显示

```
┌─ Sessions ──────────────────────┐
│ ● Claude Code                   │
│   branch: conductor/claude-01   │
│   📁 .\conductor-claude-01\     │
│   ⚡ 45.2k tokens | $0.34       │
│                                  │
│ ● OpenCode                      │
│   branch: conductor/opencode-02 │
│   📁 .\conductor-opencode-02\   │
│   ⚡ 12.1k tokens | $0.09       │
│                                  │
│ ● cmd.exe                       │
│   📁 E:\workspace\my-project\   │
│   (no worktree)                  │
└──────────────────────────────────┘
```

### 清理策略

| 策略 | 行为 |
|------|------|
| **合并后删除** | Agent 结束 → 自动 merge 到 base → 删除 worktree 和分支 |
| **保留分支** | Agent 结束 → 保留 worktree → 可随时回到这个状态 |
| **每次询问** | Agent 结束 → 弹窗让用户选择 |
| **自动冲突检测** | 实时监控各 worktree 文件变更 → 冲突文件标红预警 |

### 与现有功能的关系

- **cmd.exe** — 不使用 worktree，直接在项目目录运行
- **会话恢复** — worktree 路径持久化到 SQLite，重启后恢复到同一 worktree
- **广播模式** — 不影响，广播发送到所有终端的 stdin
- **Agent 配置** — agents.json 增加 `worktree` 默认策略字段

```json
{
  "id": "claude",
  "worktree": {
    "enabled": true,
    "baseBranch": "main",
    "cleanup": "merge"
  }
}
```

---

## Section 4: Agent 通知系统 + 运维监控

### 通知系统（cmux 式蓝色环 + 通知面板）

#### 通知触发机制

```typescript
// 三层通知来源
type AgentNotification = 
  // 1. PTY 输出解析（现有 status 检测增强）
  | { type: 'attention-needed'; agent: string; reason: string }
  // 2. OSC 转义序列（cmux 方案）
  | { type: 'osc-notify'; agent: string; message: string }
  // 3. Agent Protocol（未来扩展）
  | { type: 'agent-protocol'; agent: string; payload: any }

// 输出解析规则
const ATTENTION_PATTERNS = [
  /needs?\s+input/i,
  /permission/i,
  /approval/i,
  /confirm/i,
  /y\/n/i,
  /press any key/i,
  /waiting for/i,
  /error|failed|exception/i,
];
```

#### 视觉反馈

```
正常状态:                    需要注意:
┌──────────────────┐        ┌──────────────────┐
│ Claude Code      │        │ ● Claude Code    │
│ ● running        │        │ 🔵 蓝色光环       │
│                  │        │ ⚠ 需要确认        │
└──────────────────┘        └──────────────────┘
                            标签高亮 + 面板计数

通知面板（右侧滑出或底部）:
┌─ Notifications (3) ─────────────────────┐
│ 🔴 Claude Code · 2m ago                  │
│   "Error: TypeScript compilation failed" │
│   [Jump to →]                            │
│                                           │
│ 🟡 OpenCode · 5m ago                     │
│   "Requires approval to continue"         │
│   [Jump to →]                            │
│                                           │
│ 🟢 Codex · 12m ago                       │
│   "Task completed successfully"           │
│   [Dismiss]                              │
└───────────────────────────────────────────┘
```

#### 实现

```typescript
// notify-center.ts (Electron 主进程)
class NotifyCenter {
  private notifications: Notification[] = [];
  
  // PTY 输出 → 解析 → 通知
  handleDaemonOutput(msg: DaemonMessage) {
    if (msg.type !== 'output') return;
    
    const attention = this.parseAttention(msg.data);
    if (attention) {
      this.add({
        agent: this.getAgent(msg.sessionId),
        level: attention.level,
        message: attention.message,
        timestamp: Date.now(),
        sessionId: msg.sessionId,
      });
      // 推送到渲染进程
      this.broadcast('notification', notification);
      // Windows 原生通知（可选）
      if (this.isInBackground()) {
        new Notification({ title, body }).show();
      }
    }
  }
}
```

### Agent 运维监控仪表盘

#### 数据模型

```typescript
interface AgentStats {
  agentId: string;
  agentType: string;          // claude | opencode | codex | cmd
  
  // Token 统计
  tokenCount: number;
  tokenRate: number;          // tokens/min
  
  // 成本估算
  estimatedCost: number;      // USD
  costModel: string;          // 基于已知 API 定价
  
  // 健康评分 (0-100)
  health: {
    score: number;
    responseLatency: number;  // ms
    errorRate: number;        // 0-1
    uptime: number;           // seconds
    lastActivity: number;     // timestamp
  };
  
  // 会话信息
  sessionId: string;
  branch: string;
  cwd: string;
  worktreePath?: string;
  startTime: number;
}
```

#### 健康评分算法

```typescript
function calculateHealth(stats: AgentStats): number {
  let score = 100;
  
  // 响应延迟扣分
  if (stats.health.responseLatency > 10000) score -= 20;
  else if (stats.health.responseLatency > 5000) score -= 10;
  
  // 错误率扣分
  score -= stats.health.errorRate * 30;
  
  // 无活动超时扣分
  const idleSeconds = (Date.now() - stats.health.lastActivity) / 1000;
  if (idleSeconds > 300) score -= 15;    // 5分钟无活动
  if (idleSeconds > 600) score -= 20;    // 10分钟
  
  return Math.max(0, Math.min(100, score));
}
```

#### 仪表盘 UI

```
┌─ Agent Dashboard ─────────────────────────────────────┐
│                                                        │
│  Agent    Status    Health   Tokens    Cost    Uptime  │
│  ──────   ──────    ──────   ──────   ─────   ──────  │
│  Claude   ■ think   ●●●●○   45.2k    $0.34   23m      │
│  Open     ■ wait    ●●●●●   12.1k    $0.09   18m      │
│  Codex    ■ run     ●●●○○   28.7k    $0.21   31m      │
│  cmd      ■ run     ●●●●●   —        —       45m      │
│                                                        │
│  ────────────────────────────────────────────────────  │
│  Total: 4 agents | 86.0k tokens | $0.64 | 1h 57m      │
│                                                        │
│  Token Trend:  ▁▂▃▅▆▇█▇▆▅ (last 30min)               │
└────────────────────────────────────────────────────────┘
```

#### 崩溃自动恢复

```typescript
// daemon 内置 watchdog
class AgentWatchdog {
  private healthCheckInterval = 30_000; // 30秒检查一次
  
  async check() {
    for (const [id, session] of this.sessions) {
      const health = calculateHealth(session.stats);
      
      if (health < 20 && session.agent !== 'cmd') {
        // Agent 可能卡死
        this.emit('agent-unhealthy', { sessionId: id, health, agent: session.agent });
        // 可选：自动 kill + 重启
        if (session.config.autoRestart) {
          await this.restart(session);
        }
      }
    }
  }
}
```

### 数据持久化

```sql
-- SQLite 新增表
CREATE TABLE agent_stats (
  session_id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  token_count INTEGER DEFAULT 0,
  estimated_cost REAL DEFAULT 0,
  health_score INTEGER DEFAULT 100,
  started_at TEXT NOT NULL,
  last_activity TEXT NOT NULL
);

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  level TEXT NOT NULL,  -- 'info' | 'warning' | 'error'
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  dismissed INTEGER DEFAULT 0
);
```

---

## Section 5: 技术栈 + 迁移策略 + 分期交付

### 完整技术栈

```
Conductor V2 Technology Stack
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
桌面框架:  Electron 40.x + electron-vite 4.x
PTY管理:   node-pty 1.1.0
终端渲染:  @xterm/xterm 6.x + WebGL + Canvas + Search + Clipboard + Fit
数据库:    better-sqlite3 12.x
Git操作:    simple-git 3.x
状态管理:   zustand 5.x
构建打包:   electron-builder 26.x
运行时:    Node ≥ 20 (Electron 内置)
语言:      TypeScript 5.x
布局:      CSS Grid (现有) + react-resizable-panels (Phase 2)
样式:      Tailwind CSS 4.x + CSS 自定义属性
```

### 从 Tauri 迁移的代码映射

```
Rust (删除)                    → Node.js (重写)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
session.rs (198行)             → pty-manager.ts (~100行)
  portable-pty spawn            node-pty spawn
  template 注入                  template 注入
  setup commands                 setup commands
  reader thread                  onData callback

manager.rs (170行)             → server.ts (~80行)
  Mutex<HashMap>                 Map
  alloc_id                       counter
  snapshot thread                async function
  kill_all                       cleanup

agents.rs (185行)              → agents/config.ts (~60行)
  AgentConfig struct             interface
  template substitution          string.replace
  default_agents                  defaults

store.rs (41行)                → database.ts (~50行)
  rusqlite                       better-sqlite3
  save/load layout               save/load layout

app_commands.rs (32行)         → ipc-handlers.ts (~40行)
  #[tauri::command]              ipcMain.handle

总计: ~626行 Rust               → ~330行 TypeScript (减半)
```

```
前端 (保留)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
App.tsx           → 改 IPC 调用（invoke → ipcRenderer）
TerminalPanel.tsx → 不变
Sidebar.tsx       → 增加 Worktree/通知/仪表盘
usePty.ts         → 改 IPC 层
tauri-ipc.ts      → pty-ipc.ts
terminal-theme.ts → 不变
sessions.ts       → 不变
```

### 分期交付

```
Phase 1 — Electron 迁移 (2-3周)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✅ Electron 窗口 + 边框 + 快捷键
  ✅ PTY Daemon (spawn/write/resize/kill)
  ✅ Session Recovery (claude/opencode/codex)
  ✅ agents.json 配置
  ✅ SQLite 持久化
  ✅ Git 分支检测
  ✅ 广播模式
  ✅ Terminal 搜索/清屏
  ✅ Setup 脚本
  🎯 目标：功能完全等同现有 Tauri 版

Phase 2 — 差异化能力 (2周)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✅ Agent 通知系统（蓝色环 + 通知面板）
  ✅ Agent 健康评分
  ✅ Token/Cost 实时统计
  ✅ 仪表盘 UI
  ✅ 崩溃自动恢复
  ✅ react-resizable-panels 布局（替代纯 CSS Grid）
  🎯 目标：超越现有所有竞品

Phase 3 — Worktree 隔离 (2周)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✅ Git worktree 自动创建/清理
  ✅ 冲突检测 + 预警
  ✅ Sidebar worktree 状态显示
  ✅ 合并策略（自动/手动/每次询问）
  🎯 目标：多 Agent 并行开发零冲突

Phase 4 — Agent 编排 (后续)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ○ 任务队列 + 智能路由
  ○ 上下文共享
  ○ 内嵌浏览器
  ○ Agent Protocol 定义
```

### 技术风险和缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| node-pty Windows 稳定性 | 高 | Superset 已验证，VS Code 生产使用 |
| Named Pipe 性能 | 中 | 4字节前缀帧协议，零拷贝设计 |
| Electron 包体积大 | 低 | ~150MB 对开发者工具可接受 |
| Daemon 进程管理 | 中 | supervisor 模式 + 自动重启 |
| xterm.js WebGL 在 Electron 中 | 低 | 已在 Tauri 中验证 |

---

## 竞品参考

### cmux (macOS)
- **亮点:** AI Agent 专属设计、蓝色环通知系统、内嵌浏览器、脚本化 API
- **借鉴:** 通知系统视觉反馈、Agent 状态感知

### Ghostty (Zig)
- **亮点:** GPU 渲染（Metal/OpenGL）、多线程 I/O、可嵌入库设计
- **借鉴:** 架构分层思想（PTY 引擎与 UI 分离）

### Superset (Electron)
- **亮点:** PTY Daemon 架构、版本化协议、fd-handoff 热升级
- **借鉴:** Daemon 模式、协议设计、测试策略

---

## 附录：文件清单

### 新增文件
```
src/main/
  ├── daemon-client.ts
  ├── ipc-handlers.ts
  ├── notify-center.ts
  ├── stats-collector.ts
  ├── worktree-manager.ts
  └── window-manager.ts

src/renderer/components/
  ├── NotifyPanel.tsx
  ├── AgentDashboard.tsx
  └── WorktreeStatus.tsx

src/renderer/lib/
  └── pty-ipc.ts (替代 tauri-ipc.ts)

src/daemon/
  ├── main.ts
  ├── server.ts
  ├── pty-manager.ts
  ├── session-store.ts
  ├── session-recovery.ts
  ├── handlers.ts
  └── protocol/
      ├── messages.ts
      ├── framing.ts
      └── version.ts
```

### 删除文件
```
web/src-tauri/  (整个目录)
  ├── src/
  │   ├── config/agents.rs
  │   ├── commands/pty_commands.rs
  │   ├── commands/app_commands.rs
  │   ├── db/store.rs
  │   ├── pty/session.rs
  │   ├── pty/manager.rs
  │   └── lib.rs
  ├── Cargo.toml
  └── Cargo.lock
```

### 修改文件
```
web/src/App.tsx           → 改 IPC 调用
web/src/hooks/usePty.ts   → 改 IPC 层
web/src/lib/tauri-ipc.ts  → 重命名为 pty-ipc.ts
web/src/components/Sidebar.tsx → 增加 Worktree/通知/仪表盘入口
package.json              → Electron + 依赖
electron.vite.config.ts   → 新增
electron-builder.ts       → 新增
```

---

**文档完成时间:** 2026-06-11  
**下一步:** 创建实施计划 (writing-plans skill)
