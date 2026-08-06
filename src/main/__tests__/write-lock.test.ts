/**
 * write-lock.test.ts — Tests for in-memory per-project write lock.
 *
 * The lock is purely in-memory (refcount).  The .story-workshop.lock/
 * directory is a crash-diagnostic marker, created on first acquire and
 * removed on last release.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let acquireProjectLock: (p: string) => void;
let releaseProjectLock: (p: string) => void;

describe('write-lock (in-memory)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `wl-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(testDir, { recursive: true });
    // Fresh import per test for clean refCounts
    const mod = await import('../write-lock');
    acquireProjectLock = mod.acquireProjectLock;
    releaseProjectLock = mod.releaseProjectLock;
  });

  afterEach(() => {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  function lockDir(): string {
    return path.join(testDir, '.story-workshop.lock');
  }

  // -----------------------------------------------------------------------
  // Basic acquire / release
  // -----------------------------------------------------------------------

  it('acquires and releases a lock', () => {
    acquireProjectLock(testDir);
    expect(fs.existsSync(lockDir())).toBe(true);
    expect(fs.existsSync(path.join(lockDir(), 'info.json'))).toBe(true);

    releaseProjectLock(testDir);
    expect(fs.existsSync(lockDir())).toBe(false);
  });

  it('creates diagnostic marker with pid and timestamp', () => {
    acquireProjectLock(testDir);

    const meta = JSON.parse(fs.readFileSync(path.join(lockDir(), 'info.json'), 'utf-8'));
    expect(meta.pid).toBe(process.pid);
    expect(meta.timestamp).toBeDefined();
    expect(meta.hostname).toBe(os.hostname());
  });

  // -----------------------------------------------------------------------
  // Reentrant (same project, nested acquire/release)
  // -----------------------------------------------------------------------

  it('supports reentrant acquire/release', () => {
    acquireProjectLock(testDir);
    acquireProjectLock(testDir); // reentrant

    // Lock dir still exists
    expect(fs.existsSync(lockDir())).toBe(true);

    releaseProjectLock(testDir);
    // Still held (count 2→1)
    expect(fs.existsSync(lockDir())).toBe(true);

    releaseProjectLock(testDir);
    // Fully released
    expect(fs.existsSync(lockDir())).toBe(false);
  });

  it('release without acquire is a no-op', () => {
    expect(() => releaseProjectLock(testDir)).not.toThrow();
  });

  // -----------------------------------------------------------------------
  // Independent projects
  // -----------------------------------------------------------------------

  it('independent projects get independent locks', () => {
    const dirA = path.join(testDir, 'project-a');
    const dirB = path.join(testDir, 'project-b');
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);

    acquireProjectLock(dirA);
    acquireProjectLock(dirB);

    expect(fs.existsSync(path.join(dirA, '.story-workshop.lock'))).toBe(true);
    expect(fs.existsSync(path.join(dirB, '.story-workshop.lock'))).toBe(true);

    releaseProjectLock(dirA);
    expect(fs.existsSync(path.join(dirA, '.story-workshop.lock'))).toBe(false);
    expect(fs.existsSync(path.join(dirB, '.story-workshop.lock'))).toBe(true);

    releaseProjectLock(dirB);
  });

  // -----------------------------------------------------------------------
  // Crash marker recovery
  // -----------------------------------------------------------------------

  it('cleans up stale crash marker from previous instance', () => {
    // Simulate a crash marker from a previous (dead) instance
    fs.mkdirSync(lockDir(), { recursive: true });
    fs.writeFileSync(
      path.join(lockDir(), 'info.json'),
      JSON.stringify({ pid: 99999, timestamp: new Date(0).toISOString(), hostname: 'old' }),
      'utf-8',
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    acquireProjectLock(testDir);

    // Warning was logged about the stale marker
    expect(warnSpy).toHaveBeenCalled();
    const msg = warnSpy.mock.calls[0][0] as string;
    expect(msg).toContain('stale lock marker');

    // New marker was created with current PID
    const meta = JSON.parse(fs.readFileSync(path.join(lockDir(), 'info.json'), 'utf-8'));
    expect(meta.pid).toBe(process.pid);

    warnSpy.mockRestore();
    releaseProjectLock(testDir);
  });

  // -----------------------------------------------------------------------
  // Error: cannot create project directory
  // -----------------------------------------------------------------------

  it('throws LOCK_CREATE_FAILED when project dir cannot be created', () => {
    // Place a file where the project directory would be
    const blocked = path.join(testDir, 'blocked');
    fs.writeFileSync(blocked, '');

    expect(() => acquireProjectLock(blocked)).toThrow(/LOCK_CREATE_FAILED/);
  });
});
