// src/daemon/session-recovery.ts

import { spawnSync } from 'child_process';
import { existsSync, readdirSync, appendFileSync } from 'fs';
import path from 'path';
import os from 'os';

const DEBUG_LOG = path.join(process.env.USERPROFILE || process.env.TEMP || 'C:\\', 'conductor-daemon.log');

export function discoverSessionIds(agent: string, cwd: string): string[] {
  if (agent === 'opencode') {
    return discoverOpenCodeSessions(cwd);
  }
  if (agent === 'codex') {
    return discoverCodexSessions();
  }
  return [];
}

function discoverOpenCodeSessions(cwd: string): string[] {
  try {
    // Use cmd.exe /c to execute opencode session list
    // spawnSync can't execute .cmd files directly
    const result = spawnSync('cmd.exe', ['/c', 'opencode session list --format json'], {
      cwd,
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.error) {
      try { appendFileSync(DEBUG_LOG, `${new Date().toISOString()} discovery error: ${result.error.message}\n`); } catch {}
      return [];
    }
    const output = result.stdout.toString();
    if (!output.trim()) {
      const stderr = result.stderr.toString().trim();
      if (stderr) {
        try { appendFileSync(DEBUG_LOG, `${new Date().toISOString()} discovery stderr: ${stderr.slice(0, 200)}\n`); } catch {}
      }
      return [];
    }
    const sessions = JSON.parse(output);
    const ids = sessions.map((s: { id: string }) => s.id).filter((id: string) => id.startsWith('ses_'));
    try { appendFileSync(DEBUG_LOG, `${new Date().toISOString()} discovery found ${ids.length} sessions: ${ids.join(', ')}\n`); } catch {}
    return ids;
  } catch (e) {
    try { appendFileSync(DEBUG_LOG, `${new Date().toISOString()} discovery exception: ${(e as Error).message}\n`); } catch {}
    return [];
  }
}

function discoverCodexSessions(): string[] {
  const dir = path.join(os.homedir(), '.codex', 'sessions');
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir);
  const sessionIds: string[] = [];

  for (const file of files) {
    if (file.startsWith('rollout-') && file.endsWith('.jsonl')) {
      const match = file.match(/rollout-(\d+)-(.+)\.jsonl/);
      if (match) {
        sessionIds.push(match[2]);
      }
    }
  }

  return sessionIds;
}
