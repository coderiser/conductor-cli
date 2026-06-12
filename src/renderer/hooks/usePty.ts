import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { SearchAddon } from '@xterm/addon-search';
import { pty, type SessionInfo } from '../lib/pty-ipc';
import { terminalTheme } from '../lib/terminal-theme';
import '@xterm/xterm/css/xterm.css';

export function usePty(agent: string, cwd: string, container: HTMLDivElement | null, onReady?: (info: SessionInfo) => void, onExit?: (code: number) => void, onToken?: (count: number) => void, onStatus?: (status: string) => void, resumeId?: string, isRestore?: boolean, onSessionId?: (sid: string) => void) {
  const sessionRef = useRef<SessionInfo | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const cleanupRef = useRef<Array<() => void>>([]);

  useEffect(() => {
    if (!container) return;
    const term = new Terminal({
      cursorBlink: true, cursorStyle: 'block', fontSize: 13,
      fontFamily: "'Cascadia Code', Consolas, monospace",
      theme: terminalTheme, scrollback: 5000,
      allowProposedApi: true,
      allowTransparency: true,
      macOptionIsMeta: false,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit); term.loadAddon(new ClipboardAddon()); term.loadAddon(search);
    term.open(container);
    fit.fit();
    term.write(`\x1b[36m● Starting ${agent}...\x1b[0m\r\n`);
    if (resumeId && agent !== 'cmd' && agent !== 'cmd.exe') term.write(`\x1b[35m  ${isRestore ? 'RESUME' : 'NEW'} session: ${resumeId.slice(0, 8)}...\x1b[0m\r\n`);

    // Clipboard: copy selection on Ctrl+Shift+C, Ctrl+Insert, or context menu
    const copySelection = () => {
      const sel = term.getSelection();
      if (sel) navigator.clipboard.writeText(sel).catch(() => {});
    };
    term.attachCustomKeyEventHandler((e) => {
      if ((e.ctrlKey && e.shiftKey && e.key === 'C') || (e.ctrlKey && e.key === 'Insert')) {
        copySelection(); return false;
      }
      // Search: Ctrl+F opens find bar
      if (e.ctrlKey && e.key === 'f' && !e.shiftKey && !e.altKey) {
        search.findNext(''); return false;
      }
      // Clear terminal: Ctrl+K or Ctrl+L
      if (e.ctrlKey && (e.key === 'k' || e.key === 'l') && !e.shiftKey && !e.altKey) {
        term.clear(); return false;
      }
      return true;
    });
    // Right-click to copy
    const onContextMenu = (e: MouseEvent) => {
      const sel = term.getSelection();
      if (sel) { navigator.clipboard.writeText(sel).catch(() => {}); e.preventDefault(); }
    };
    container.addEventListener('contextmenu', onContextMenu);

    const focusIt = () => term.focus();
    focusIt();
    const t1 = setTimeout(focusIt, 50);
    const t2 = setTimeout(focusIt, 300);
    const t3 = setTimeout(focusIt, 1000);
    container.addEventListener('click', focusIt);

    // Register input BEFORE spawn — no gate on session state
    let pending = '';
    let sessionIdCaptured = false;
    let lastStatus = '';
    const onDataDisposable = term.onData((data) => {
      const s = sessionRef.current;
      if (s?.sessionId) {
        pty.write(s.sessionId, data).catch((e) => { term.write(`\x1b[31m[E:${e}]\x1b[0m`); });
      } else { pending += data; }
    });

    const ro = new ResizeObserver(() => {
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        fit.fit(); const nd = fit.proposeDimensions();
        if (nd?.cols && nd?.rows && sessionRef.current?.sessionId) {
          pty.resize(sessionRef.current.sessionId, nd.cols, nd.rows).catch(() => {});
        }
      }, 150);
    });
    ro.observe(container);

    const d = fit.proposeDimensions();
    const spawnTimeout = setTimeout(() => {
      term.write(`\x1b[31m● Spawn timed out (10s). Agent: ${agent}, Cwd: ${cwd}\x1b[0m\r\n`);
    }, 10000);
    const spawnTime = Date.now();
    let retryAttempted = false;
    let resumeTimeoutId: ReturnType<typeof setTimeout> | undefined;

    function doSpawn(agentName: string, sessionResumeId?: string, restore = false) {
      // FIX: For new sessions of non-cmd agents, generate a UUID in the renderer.
      // This UUID is passed to the daemon which uses it with the agent's createTemplate
      // (e.g. --session-id UUID for Claude). Since we generate it HERE, we already know
      // the session ID and can save it immediately — no need to capture from output.
      let knownSessionId: string | undefined;
      if (!restore && !sessionResumeId && agentName !== 'cmd' && agentName !== 'cmd.exe') {
        knownSessionId = crypto.randomUUID();
      }
      const effectiveSessionId = restore ? sessionResumeId : knownSessionId;

      pty.spawn(agentName, cwd, d?.cols ?? 80, d?.rows ?? 24, effectiveSessionId, restore)
      .then((info) => {
        clearTimeout(spawnTimeout);
        sessionRef.current = info;

        // FIX: Immediately save the session ID we generated (for new sessions).
        // We already know the UUID since we generated it — no need to capture from output.
        if (knownSessionId && !sessionIdCaptured) {
          sessionIdCaptured = true;
          onSessionId?.(knownSessionId);
        }

        // Resume monitoring: detect resume failure patterns in output
        // Claude prints "No conversation found" when --resume fails, but doesn't exit —
        // it hangs in an error state. We must detect this and retry without resume.
        if (restore && sessionResumeId && !retryAttempted) {
          let resumeResolved = false;
          const RESUME_FAIL_PATTERNS = [
            /no conversation found/i,
            /could not find (?:the )?(?:conversation|session)/i,
            /session (?:not found|doesn't exist|does not exist)/i,
            /invalid (?:session|conversation) (?:id|identifier)/i,
            /failed to (?:resume|restore|load)/i,
            /requires a valid session id/i,
            /is not a uuid/i,
            /does not match any session/i,
            /no (?:saved )?session/i,
          ];

          const outputMonitor = pty.onOutput(info.sessionId, (data) => {
            if (resumeResolved) return;
            const clean = data.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
            // Check for resume failure patterns
            for (const pattern of RESUME_FAIL_PATTERNS) {
              if (pattern.test(clean)) {
                resumeResolved = true;
                if (resumeTimeoutId) clearTimeout(resumeTimeoutId);
                outputMonitor();
                retryAttempted = true;
                sessionIdCaptured = false; // FIX: Reset so new session can capture its ID
                term.write(`\r\n\x1b[33m● Resume failed: session not found. Starting new session...\x1b[0m\r\n`);
                const oldId = sessionRef.current?.sessionId;
                sessionRef.current = null;
                if (oldId) pty.kill(oldId).catch(() => {});
                setTimeout(() => doSpawn(agentName, undefined, false), 500);
                return;
              }
            }
            // Check for real interactive content (agent is actually running)
            // Must be substantial content that isn't an error message
            if (clean.length > 50 && !/error|failed|not found/i.test(clean)) {
              resumeResolved = true;
              if (resumeTimeoutId) clearTimeout(resumeTimeoutId);
              outputMonitor();
            }
          });
          cleanupRef.current.push(outputMonitor);

          // Fallback timeout: if no resolution after 15s, assume stuck and retry
          resumeTimeoutId = setTimeout(() => {
            if (!resumeResolved && sessionRef.current?.sessionId && !retryAttempted) {
              resumeResolved = true;
              outputMonitor();
              retryAttempted = true;
              sessionIdCaptured = false; // FIX: Reset so new session can capture its ID
              term.write(`\r\n\x1b[33m● Resume timed out (15s). Starting new session...\x1b[0m\r\n`);
              const oldId = sessionRef.current.sessionId;
              sessionRef.current = null;
              pty.kill(oldId).catch(() => {});
              setTimeout(() => doSpawn(agentName, undefined, false), 500);
            }
          }, 15000);
        }

        // Post-spawn session ID capture for OpenCode/Codex (/rename flow)
        const unsubSid = pty.onSessionIdChanged(info.sessionId, (sid) => {
          term.write(`\x1b[35m[Session: ${sid} — will resume on restart]\x1b[0m\r\n`);
          onSessionId?.(sid);
        });
        cleanupRef.current.push(unsubSid);
        onReady?.(info);

        // FIX: Immediately capture agentSessionId from the daemon's spawn response.
        // This is critical for the case where the daemon generates a UUID for a new
        // Claude session (--session-id). Without this, the renderer keeps the old
        // random resumeId that the agent doesn't recognize.
        if (info.agentSessionId && !sessionIdCaptured) {
          sessionIdCaptured = true;
          onSessionId?.(info.agentSessionId);
          term.write(`\x1b[35m[Session: ${info.agentSessionId} — will resume on restart]\x1b[0m\r\n`);
        }

        cleanupRef.current.push(pty.onOutput(info.sessionId, (data) => {
          term.write(data);
          // Parse token count: requires whitespace between number and "tokens"
          // Prevents ANSI escape '2mtokens' (dim mode) from matching
          const m = data.match(/([\d,.]+[km]?)\s+tokens\b/i);
          if (m && onToken) {
            const s = m[1].toLowerCase().replace(',', '');
            const n = s.endsWith('k') ? parseFloat(s) * 1000 : s.endsWith('m') ? parseFloat(s) * 1000000 : parseInt(s);
            if (!isNaN(n) && n > 10 && n < 100_000_000) onToken(n);
          }
          // Parse agent session ID from startup output (capture only once)
          // Only matches structured patterns like "Session ID: <id>" or "Session: <uuid>"
          // Skip if the output looks like an error (e.g. "No conversation found with session ID: ...")
          if (!sessionIdCaptured) {
            const hasErrorContext = /no conversation|not found|could not|failed to|error/i.test(clean);
            if (!hasErrorContext) {
              const sidMatch = data.match(/session\s*(?:id)?\s*[:：]\s*([a-f0-9\-]{8,}|ses_\w{8,}|[\w-]{20,})/i);
              if (sidMatch && sessionRef.current) {
                const sid = sidMatch[1];
                sessionIdCaptured = true;
                pty.setAgentSessionId(sessionRef.current.sessionId, sid).then(() => {
                  term.write(`\x1b[35m[Session: ${sid} — will resume on restart]\x1b[0m\r\n`);
                  onSessionId?.(sid);
                }).catch(() => {
                  term.write(`\x1b[31m[Session: ${sid} — FAILED to save]\x1b[0m\r\n`);
                });
              }
            }
          }
          // Parse agent status from output (deduplicated — only update on change)
          if (onStatus) {
            if (data.length < 3) return;
            let newStatus = '';
            if (/prompt|ready|\$\s|>\s|done|complete|finished|result|answer/i.test(data) && data.length < 200) newStatus = 'running';
            else if (/thinking|analyzing|reasoning|processing|generating|executing|working/i.test(data)) newStatus = 'thinking';
            else if (/waiting|needs.?input|permission|approval|ask.?user|confirm|allow/i.test(data)) newStatus = 'waiting';
            else if (/error|failed|exception|panic|crash|fatal/i.test(data)) newStatus = 'error';
            if (newStatus && newStatus !== lastStatus) {
              lastStatus = newStatus;
              onStatus(newStatus);
              // Auto-reset to running after 5s if no update
              clearTimeout(statusTimerRef.current);
              if (newStatus !== 'running' && newStatus !== 'error') {
                statusTimerRef.current = setTimeout(() => { lastStatus = 'running'; onStatus('running'); }, 5000);
              }
            }
          }
        }));
        cleanupRef.current.push(pty.onExit(info.sessionId, (code) => {
          if (resumeTimeoutId) clearTimeout(resumeTimeoutId);
          // Resume fallback: if process exits quickly with error and we were restoring,
          // retry without the resume flag (session may not exist in agent's local DB)
          const elapsed = Date.now() - spawnTime;
          if (code !== 0 && elapsed < 5000 && restore && sessionResumeId && !retryAttempted) {
            retryAttempted = true;
            sessionIdCaptured = false; // FIX: Reset so new session can capture its ID
            term.write(`\r\n\x1b[33m● Resume failed (exit: ${code}). Starting new session...\x1b[0m\r\n`);
            sessionRef.current = null;
            doSpawn(agentName, undefined, false);
            return;
          }
          term.write(`\r\n\x1b[33m● Session ended (exit: ${code})\x1b[0m\r\n`);
          sessionRef.current = null;
          onExit?.(code);
        }));
        if (pending) { pty.write(info.sessionId, pending).catch(() => {}); pending = ''; }
        term.write(`\x1b[32m● Ready (${info.sessionId})\x1b[0m\r\n`);
      })
      .catch((err) => {
        clearTimeout(spawnTimeout);
        term.write(`\r\n\x1b[31m● Failed: ${err}\x1b[0m\r\n`);
        sessionRef.current = null;
      });
    }

    doSpawn(agent, resumeId, isRestore);

    return () => {
      clearTimeout(t1); clearTimeout(t2); clearTimeout(t3);
      clearTimeout(timerRef.current); clearTimeout(statusTimerRef.current);
      if (resumeTimeoutId) clearTimeout(resumeTimeoutId);
      container.removeEventListener('click', focusIt);
      container.removeEventListener('contextmenu', onContextMenu);
      onDataDisposable.dispose();
      ro.disconnect();
      cleanupRef.current.forEach((f) => f());
      if (sessionRef.current?.sessionId) pty.kill(sessionRef.current.sessionId).catch(() => {});
      term.dispose();
    };
  }, [agent, container]);
}
