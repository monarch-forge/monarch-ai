/**
 * Monarch core entry point.
 *   env MONARCH_PORT (default 7717), MONARCH_HOST (default 127.0.0.1), MONARCH_HOME (data dir),
 *   MONARCH_PARENT_STDIN=1 → exit when stdin closes (set by the Tauri shell so the core dies with its parent).
 *   Exit code 75 (RESTART_EXIT_CODE) = "restart me" (after a sync pull restored the data dir): the Tauri shell
 *   respawns the core. Without the shell (dev / standalone) the core re-execs itself as a detached process
 *   (same argv/env, MONARCH_RESTARTED=1 → waits for the port to free up; output → logs/core-restart.log).
 *   Under `tsx watch` the replacement runs outside the watcher; restart `npm run dev` to get watching back.
 */
import { CORE_HOST, CORE_PORT } from '@monarch/shared';
import { initMemory } from './integrations/memory/index.ts';
import { initGoogle } from './integrations/google/index.ts';
import { initAgent } from './agent/orchestrator.ts';
import { activity, paths } from './kernel.ts';
import { createServer } from './server.ts';
import { startScheduler, stopScheduler } from './services/scheduler.ts';
import { startMetrics, stopMetrics } from './services/metrics.ts';
import { flushAll } from './services/persist.ts';
import { CORE_VERSION } from './services/meta.ts';
import { initEvolution, shutdownEvolution } from './extensions/index.ts';
import { stopVoice } from './services/voice.ts';
import { RESTART_EXIT_CODE, setRestartHandler, startSync, stopSync } from './services/sync.ts';
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { join } from 'node:path';

const port = Number(process.env.MONARCH_PORT) || CORE_PORT;
const host = process.env.MONARCH_HOST || CORE_HOST;

async function step(name: string, fn: () => Promise<void> | void, timeoutMs = 20_000): Promise<void> {
  const t0 = Date.now();
  try {
    await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs).unref()),
    ]);
    console.log(`[core] ${name} ready (${Date.now() - t0}ms)`);
  } catch (e) {
    console.error(`[core] ${name} failed:`, e instanceof Error ? e.message : e);
  }
}

process.on('unhandledRejection', (reason) => console.error('[core] unhandled rejection:', reason));
process.on('uncaughtException', (err) => console.error('[core] uncaught exception:', err));

const core = createServer();
let shuttingDown = false;

async function shutdown(reason: string, code = 0, beforeExit?: () => void): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[core] shutting down (${reason})`);
  const force = setTimeout(() => process.exit(code), 3000);
  force.unref();
  try {
    stopScheduler();
    stopMetrics();
    stopVoice();
    stopSync();
    await Promise.race([Promise.all([core.close(), shutdownEvolution()]), new Promise((r) => setTimeout(r, 1500))]);
  } catch (e) {
    console.error('[core] error during shutdown:', e);
  }
  if (beforeExit) {
    // sync restore: write the restored files and exit in the same tick — do NOT flush in-memory stores over them
    try {
      beforeExit();
    } catch (e) {
      console.error('[core] restore failed:', e);
    }
    if (process.env.MONARCH_PARENT_STDIN !== '1') respawnDetached();
    process.exit(code);
  }
  flushAll();
  // let other modules' debounced JsonStore writes (50ms) land before exiting
  setTimeout(() => process.exit(code), 150);
}

/** standalone restart: start a detached copy of this process (same node args + env) */
function respawnDetached(): void {
  try {
    const out = openSync(join(paths.logs, 'core-restart.log'), 'a');
    const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
      cwd: process.cwd(),
      env: { ...process.env, MONARCH_RESTARTED: '1' },
      detached: true,
      stdio: ['ignore', out, out],
    });
    child.unref();
    console.log(`[core] restarting as pid ${child.pid}`);
  } catch (e) {
    console.error('[core] could not respawn:', e);
  }
}

setRestartHandler((beforeExit) => void shutdown('sync restore', RESTART_EXIT_CODE, beforeExit));

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGHUP', () => void shutdown('SIGHUP'));
if (process.env.MONARCH_PARENT_STDIN === '1') {
  process.stdin.on('end', () => void shutdown('parent stdin closed'));
  process.stdin.on('error', () => void shutdown('parent stdin error'));
  process.stdin.resume();
}

async function main(): Promise<void> {
  console.log(`[core] Monarch core v${CORE_VERSION} — data dir ${paths.home}`);
  await step('memory', initMemory);
  await step('google', initGoogle);
  await step('agent', initAgent, 30_000);
  await step('extensions', initEvolution, 25_000);
  startScheduler();
  startMetrics();
  await step('sync', startSync);
  try {
    // after a self-restart the old process may still hold the port for a moment
    for (let i = 0; ; i++) {
      try {
        await core.listen(port, host);
        break;
      } catch (e) {
        if (process.env.MONARCH_RESTARTED !== '1' || (e as NodeJS.ErrnoException).code !== 'EADDRINUSE' || i >= 40) throw e;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.error(
      err.code === 'EADDRINUSE' ? `[core] port ${port} on ${host} is already in use — is another core running?` : `[core] listen failed:`,
      err.code === 'EADDRINUSE' ? '' : err,
    );
    await shutdown('listen failed', 1);
    return;
  }
  console.log(`[core] listening on http://${host}:${port} (ws://${host}:${port}/ws)`);
  activity('SYS', `Core online (v${CORE_VERSION})`);
}

void main();
