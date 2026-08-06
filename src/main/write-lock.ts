/**
 * write-lock.ts — Per-project synchronous reentrant write marker.
 *
 * Cross-instance protection is handled by app.requestSingleInstanceLock()
 * in the Electron main entry point — only one instance runs at a time.
 *
 * Within the main process, this module provides a simple in-memory
 * reference count per project directory.  It supports REENTRANT use
 * (nested acquire / release by the same call chain) but does NOT
 * serialise concurrent async IPC handlers — it does not queue or block
 * callers.  All current write paths are synchronous (no `await` inside
 * the critical section), so this is sufficient.
 *
 * CONSTRAINT: callers MUST NOT introduce `await` between acquire and
 * release.  If an async critical section is ever needed, replace this
 * module with a queued `withProjectWriteLock(projectDir, async fn)` API.
 *
 * A .story-workshop.lock/ directory is created as a CRASH DIAGNOSTIC
 * marker (pid + timestamp).  If the app exits normally the directory
 * is removed.  If it persists across restarts, the previous instance
 * crashed — a warning is logged and the marker is cleaned up.
 *
 * This module does NOT implement distributed locking.  Network-share
 * multi-host editing is not supported.
 *
 * Usage:
 *   acquireProjectLock("/path/to/project")
 *   // ... do SYNCHRONOUS writes only — no `await` ...
 *   releaseProjectLock("/path/to/project")
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const LOCK_DIR_NAME = '.story-workshop.lock';

/** Per-project reference count. */
const refCounts = new Map<string, number>();

/**
 * Acquire the synchronous reentrant write marker for a project directory.
 *
 * IMPORTANT: this is a refcount, not a mutex.  It does NOT block or
 * queue concurrent callers.  The critical section between acquire and
 * release MUST remain synchronous — no `await`.
 *
 * On first acquisition creates a diagnostic marker directory.
 * If a marker from a previous (crashed) instance exists it is
 * logged and cleaned up — the lock is always granted.
 *
 * @throws LOCK_CREATE_FAILED if the diagnostic directory cannot be written.
 */
export function acquireProjectLock(projectDir: string): void {
  const count = refCounts.get(projectDir) ?? 0;

  if (count === 0) {
    // Ensure project directory exists
    if (!fs.existsSync(projectDir)) {
      try {
        fs.mkdirSync(projectDir, { recursive: true });
      } catch {
        throw new Error('LOCK_CREATE_FAILED');
      }
    }

    const lockDir = path.join(projectDir, LOCK_DIR_NAME);

    // Clean up crash marker from a previous instance
    if (fs.existsSync(lockDir)) {
      console.warn(
        `Found stale lock marker in ${projectDir} — ` +
        `previous instance may have crashed. Cleaning up.`,
      );
      try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }

    // Create diagnostic marker
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(
        path.join(lockDir, 'info.json'),
        JSON.stringify({
          pid: process.pid,
          timestamp: new Date().toISOString(),
          hostname: os.hostname(),
        }, null, 2),
        'utf-8',
      );
    } catch {
      throw new Error('LOCK_CREATE_FAILED');
    }
  }

  refCounts.set(projectDir, count + 1);
}

/**
 * Release a write lock previously acquired for the given project directory.
 *
 * Reentrant: decrements the reference count.  The diagnostic marker is
 * removed when the count reaches zero.
 */
export function releaseProjectLock(projectDir: string): void {
  const count = refCounts.get(projectDir);
  if (count === undefined || count <= 0) return;

  if (count === 1) {
    const lockDir = path.join(projectDir, LOCK_DIR_NAME);
    try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* best effort */ }
    refCounts.delete(projectDir);
  } else {
    refCounts.set(projectDir, count - 1);
  }
}

/**
 * 在写锁标记保护下执行一段同步写入（acquire → fn → release）。
 *
 * 与 acquireProjectLock 一样：fn 必须是同步的（不得引入 await）。
 * 供各仓库/工具把「原子写」包进锁标记，用于崩溃诊断。
 */
export function withProjectWriteLock<T>(projectDir: string, fn: () => T): T {
  acquireProjectLock(projectDir);
  try {
    return fn();
  } finally {
    releaseProjectLock(projectDir);
  }
}
