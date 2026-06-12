/**
 * Shared agent configuration types and utilities.
 * Used by both the Electron main process (src/main/agent-config.ts)
 * and the daemon process (src/daemon/agent-config.ts).
 */

/**
 * Agent configuration — defines how to spawn and manage an agent session.
 */
export interface AgentConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  createTemplate: string;
  resumeTemplate: string;
  setup: string[];
  builtin: boolean;
}

/** Default agents shipped with the app. */
export const DEFAULT_AGENTS: AgentConfig[] = [
  { id: 'cmd', name: 'Command Prompt', command: 'cmd.exe', args: [], createTemplate: '', resumeTemplate: '', setup: [], builtin: true },
  { id: 'claude', name: 'Claude Code', command: 'claude', args: ['--allow-dangerously-skip-permissions'], createTemplate: '--session-id {session_id}', resumeTemplate: '--resume {session_id}', setup: [], builtin: false },
  { id: 'opencode', name: 'OpenCode', command: 'opencode', args: [], createTemplate: '', resumeTemplate: '--session {session_id}', setup: [], builtin: false },
  { id: 'codex', name: 'Codex', command: 'codex', args: [], createTemplate: '', resumeTemplate: 'resume {session_id}', setup: [], builtin: false },
];

/** Map a raw agents.json entry to AgentConfig, handling snake_case → camelCase. */
export function mapAgentEntry(entry: any): AgentConfig {
  return {
    id: entry.id ?? '',
    name: entry.name ?? entry.id ?? '',
    command: entry.command ?? '',
    args: entry.args ?? [],
    createTemplate: entry.create_template ?? entry.createTemplate ?? '',
    resumeTemplate: entry.resume_template ?? entry.resumeTemplate ?? '',
    setup: entry.setup ?? [],
    builtin: entry.builtin ?? false,
  };
}
