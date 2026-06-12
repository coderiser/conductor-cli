import fs from 'fs';
import path from 'path';
import { DaemonServer } from './server.js';

const PIPE_PATH = '\\\\.\\pipe\\conductor-pty-daemon';
// Write logs to multiple locations for debugging
const LOG_CANDIDATES = [
  process.env.USERPROFILE,
  process.env.TEMP,
  'C:\\',
  path.resolve(__dirname, '..', '..'),  // project root
].filter(Boolean) as string[];

function tryLog(filename: string, msg: string) {
  for (const dir of LOG_CANDIDATES) {
    try {
      const logPath = path.join(dir, filename);
      fs.appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`);
      return; // success, stop trying
    } catch { /* try next */ }
  }
}

const log = (msg: string) => tryLog('conductor-daemon.log', msg);

log(`=== Daemon starting ===`);
log(`pid=${process.pid}, cwd=${process.cwd()}`);
log(`USERPROFILE=${process.env.USERPROFILE || 'UNSET'}`);
log(`TEMP=${process.env.TEMP || 'UNSET'}`);
log(`PIPE=${PIPE_PATH}`);
log(`__dirname=${__dirname}`);

// Catch unhandled errors so the daemon doesn't silently crash
process.on('uncaughtException', (err) => {
  tryLog('conductor-daemon-crash.log', `Uncaught: ${err.stack || err}`);
  console.error('[Daemon] Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  tryLog('conductor-daemon-crash.log', `Rejection: ${reason}`);
  console.error('[Daemon] Unhandled rejection:', reason);
});

process.on('exit', (code) => {
  log(`Process exit with code ${code}`);
});

const server = new DaemonServer(PIPE_PATH);
server.start();
log('Server.start() called');

process.on('SIGINT', () => {
  log('SIGINT received');
  server.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('SIGTERM received');
  server.stop();
  process.exit(0);
});

log('Daemon initialization complete');
console.log('PTY Daemon started');
