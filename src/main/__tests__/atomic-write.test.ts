import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Wrap fs.renameSync in a mock to verify tmp→rename pattern.
// vi.spyOn does not work on ESM module namespace objects, so we use vi.mock.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    openSync: vi.fn(actual.openSync),
    closeSync: vi.fn(actual.closeSync),
    unlinkSync: vi.fn(actual.unlinkSync),
    renameSync: vi.fn(actual.renameSync),
    fsyncSync: vi.fn(actual.fsyncSync),
  };
});

// Dynamic import to avoid hoisting issues
let writeJsonAtomic: (p: string, d: unknown) => void;
let writeTextAtomic: (p: string, c: string) => void;
let writeMarkdownAtomic: (p: string, c: string) => void;

beforeEach(async () => {
  vi.clearAllMocks();
  const mod = await import('../atomic-write');
  writeJsonAtomic = mod.writeJsonAtomic;
  writeTextAtomic = mod.writeTextAtomic;
  writeMarkdownAtomic = mod.writeMarkdownAtomic;
});

describe('atomic-write', () => {
  const testDir = path.join(os.tmpdir(), `atomic-write-test-${Date.now()}`);
  let testFile: string;

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
    testFile = path.join(testDir, 'test.json');
  });

  afterEach(() => {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  describe('writeJsonAtomic', () => {
    // BDD: 写入 JSON 文件经过 tmp → rename 流程 (happy-path)
    // Catches bug: file not created, or content mismatch
    it('writes valid JSON to file via tmp → rename', () => {
      writeJsonAtomic(testFile, { key: 'value', num: 42 });
      expect(fs.existsSync(testFile)).toBe(true);
      const content = JSON.parse(fs.readFileSync(testFile, 'utf-8'));
      expect(content).toEqual({ key: 'value', num: 42 });
    });

    // BDD: 写入失败时原始文件保持不变 (failure-path, Rule 2: 写入异常)
    // Catches bug: corrupting original file on failed write
    it('does not corrupt existing file on write failure', () => {
      writeJsonAtomic(testFile, { original: true });
      const original = fs.readFileSync(testFile, 'utf-8');

      // Try to write to an invalid path (should throw)
      const invalidPath = path.join(testDir, 'nonexistent', 'deep', 'file.json');
      try {
        writeJsonAtomic(invalidPath, { new: 'data' });
      } catch { /* expected: directory doesn't exist */ }

      // Original file untouched
      expect(fs.readFileSync(testFile, 'utf-8')).toBe(original);
    });

    // BDD: 不存在的目录自动创建 (happy-path, Rule 3: 目录不存在)
    // Catches bug: failing to create parent directories
    it('creates parent directories if needed', () => {
      const deepPath = path.join(testDir, 'a', 'b', 'c.json');
      writeJsonAtomic(deepPath, { deep: true });
      expect(fs.existsSync(deepPath)).toBe(true);
    });

    // BDD: 原子覆盖写入保持一致性 (happy-path)
    // Catches bug: partial overwrite or data corruption
    it('overwrites existing file atomically', () => {
      writeJsonAtomic(testFile, { version: 1 });
      writeJsonAtomic(testFile, { version: 2 });
      const data = JSON.parse(fs.readFileSync(testFile, 'utf-8'));
      expect(data.version).toBe(2);
    });

    // BDD: 临时文件被清理 (happy-path)
    // Catches bug: leaving .tmp files scattered on disk
    it('cleans up temp files after successful write', () => {
      writeJsonAtomic(testFile, { clean: true });
      const dir = path.dirname(testFile);
      const basename = path.basename(testFile);
      const files = fs.readdirSync(dir);
      const tmpFiles = files.filter(f => f.startsWith(`.${basename}.`) && f.endsWith('.tmp'));
      expect(tmpFiles).toHaveLength(0);
    });

    // BDD: 写入失败时原始文件保持不变 — temp file side-effect check
    // Catches bug: leaving orphan .tmp files after error
    it('cleans up temp files on write error', () => {
      // Create a file where a subdirectory is needed, forcing mkdir to fail
      const blockingPath = path.join(testDir, 'blocker');
      fs.writeFileSync(blockingPath, '');
      const badPath = path.join(blockingPath, 'sub', 'fail.json');

      try {
        writeJsonAtomic(badPath, { data: 'should fail' });
      } catch { /* expected */ }

      // No temp files should remain in the parent directory
      const files = fs.readdirSync(testDir);
      const tmpFiles = files.filter(f => f.endsWith('.tmp'));
      expect(tmpFiles).toHaveLength(0);
    });

    // BDD: rename 异常时原始文件保持不变 + 临时文件清理 (Rule 2: 写入异常 — rename 失败路径)
    // Catches cheat: unlinkSync(target) before renameSync would delete original on rename failure
    // 与 mkdir 失败测试互补，覆盖 rename 失败路径
    it('preserves original file and cleans tmp on rename failure', () => {
      const jsonFile = path.join(testDir, 'rename-failure-guard.json');
      writeJsonAtomic(jsonFile, { original: true });
      const originalContent = fs.readFileSync(jsonFile, 'utf-8');

      // Override the vi.mock'd renameSync to throw — simulates rename failure after tmp write succeeds
      const mockedRename = vi.mocked(fs.renameSync);
      const originalImpl = mockedRename.getMockImplementation();
      mockedRename.mockImplementation(() => {
        throw new Error('Simulated rename failure');
      });

      try {
        expect(() => {
          writeJsonAtomic(jsonFile, { new: 'data' });
        }).toThrow();

        // Original content must be preserved unmodified
        expect(fs.readFileSync(jsonFile, 'utf-8')).toBe(originalContent);

        // Temp files must be cleaned up after rename failure
        const dir = path.dirname(jsonFile);
        const basename = path.basename(jsonFile);
        const files = fs.readdirSync(dir);
        const tmpFiles = files.filter(f => f.startsWith(`.${basename}.`) && f.endsWith('.tmp'));
        expect(tmpFiles).toHaveLength(0);
      } finally {
        mockedRename.mockImplementation(originalImpl!);
        mockedRename.mockClear();
      }
    });

    // Security guarantee: 持久性保证 (Rule 3: fsync 刷入磁盘后才执行 rename)
    // Catches bug: skipping fsync before rename (data loss risk on crash)
    // Catches cheat: tmp/rename implementation that skips fsync
    it('calls fsyncSync before renameSync for durability', () => {
      const targetFile = path.join(testDir, 'durability.json');
      writeJsonAtomic(targetFile, { durable: true });

      // Verify fsyncSync was called at least once
      expect(vi.mocked(fs.fsyncSync)).toHaveBeenCalled();

      // Verify the order: last fsyncSync call happens before renameSync call
      const fsyncOrder = vi.mocked(fs.fsyncSync).mock.invocationCallOrder;
      const renameOrder = vi.mocked(fs.renameSync).mock.invocationCallOrder;
      expect(fsyncOrder[fsyncOrder.length - 1]).toBeLessThan(renameOrder[0]);
    });
  });

  describe('writeTextAtomic', () => {
    // BDD: 写入文本内容 (existing behavior — must remain unchanged)
    it('writes text content via tmp → rename', () => {
      const textFile = path.join(testDir, 'doc.md');
      writeTextAtomic(textFile, '# Hello\n\nWorld');
      expect(fs.existsSync(textFile)).toBe(true);
      expect(fs.readFileSync(textFile, 'utf-8')).toBe('# Hello\n\nWorld');
    });

    // BDD: 空内容写入 (failure-path)
    it('handles empty content', () => {
      const emptyFile = path.join(testDir, 'empty.txt');
      writeTextAtomic(emptyFile, '');
      expect(fs.readFileSync(emptyFile, 'utf-8')).toBe('');
    });

    // BDD: Unicode 内容正确保留 (failure-path)
    it('handles unicode content', () => {
      const unicodeFile = path.join(testDir, 'unicode.txt');
      writeTextAtomic(unicodeFile, '你好世界 🎉');
      expect(fs.readFileSync(unicodeFile, 'utf-8')).toBe('你好世界 🎉');
    });

    // BDD: rename 异常时原始文件保持不变 + 临时文件清理 (Rule 2: 写入异常 — rename 失败路径)
    // Catches cheat: unlinkSync(target) before renameSync would delete original on rename failure
    it('preserves original file and cleans tmp on rename failure', () => {
      const txtFile = path.join(testDir, 'rename-failure-guard.txt');
      writeTextAtomic(txtFile, 'Original text content');
      const originalContent = fs.readFileSync(txtFile, 'utf-8');

      const mockedRename = vi.mocked(fs.renameSync);
      const originalImpl = mockedRename.getMockImplementation();
      mockedRename.mockImplementation(() => {
        throw new Error('Simulated rename failure');
      });

      try {
        expect(() => {
          writeTextAtomic(txtFile, 'New content that must not appear');
        }).toThrow();

        expect(fs.readFileSync(txtFile, 'utf-8')).toBe(originalContent);

        const dir = path.dirname(txtFile);
        const basename = path.basename(txtFile);
        const files = fs.readdirSync(dir);
        const tmpFiles = files.filter(f => f.startsWith(`.${basename}.`) && f.endsWith('.tmp'));
        expect(tmpFiles).toHaveLength(0);
      } finally {
        mockedRename.mockImplementation(originalImpl!);
        mockedRename.mockClear();
      }
    });
  });

  describe('writeMarkdownAtomic', () => {
    // BDD: 写入 Markdown 文件经过 tmp → rename 流程 (happy-path)
    // Catches bug: writeMarkdownAtomic not exported or content mismatch
    it('writes markdown content via tmp → rename', () => {
      const mdFile = path.join(testDir, 'doc.md');
      writeMarkdownAtomic(mdFile, '# Title\n\nContent');
      expect(fs.existsSync(mdFile)).toBe(true);
      expect(fs.readFileSync(mdFile, 'utf-8')).toBe('# Title\n\nContent');
    });

    // BDD: 不存在的目录自动创建 (happy-path)
    // Catches bug: not creating intermediate directories for deep markdown paths
    it('creates parent directories for deep paths', () => {
      const deepPath = path.join(testDir, 'a', 'b', 'c', 'doc.md');
      writeMarkdownAtomic(deepPath, '# Deep');
      expect(fs.existsSync(deepPath)).toBe(true);
      expect(fs.readFileSync(deepPath, 'utf-8')).toBe('# Deep');
    });

    // BDD: 空内容写入 Markdown (failure-path)
    // Catches bug: crashing on empty string
    it('handles empty content', () => {
      const emptyFile = path.join(testDir, 'empty.md');
      writeMarkdownAtomic(emptyFile, '');
      expect(fs.existsSync(emptyFile)).toBe(true);
      expect(fs.readFileSync(emptyFile, 'utf-8')).toBe('');
    });

    // BDD: Unicode 内容正确保留 (failure-path)
    // Catches bug: corrupting non-ASCII characters
    it('handles unicode content', () => {
      const unicodeFile = path.join(testDir, 'unicode.md');
      writeMarkdownAtomic(unicodeFile, '你好世界 🎉');
      expect(fs.readFileSync(unicodeFile, 'utf-8')).toBe('你好世界 🎉');
    });

    // BDD: 写入失败时原始文件保持不变 (failure-path, Rule 2: 写入异常)
    // Catches bug: corrupting original file on failed markdown write
    it('preserves original file on write error', () => {
      const target = path.join(testDir, 'preserve.md');
      writeMarkdownAtomic(target, '# Original');
      const originalContent = fs.readFileSync(target, 'utf-8');

      // Create file where subdirectory would be needed, forcing mkdir to fail
      const blockingPath = path.join(testDir, 'md-blocker');
      fs.writeFileSync(blockingPath, '');
      const badPath = path.join(blockingPath, 'sub', 'fail.md');

      try {
        writeMarkdownAtomic(badPath, '# New content');
      } catch { /* expected */ }

      expect(fs.readFileSync(target, 'utf-8')).toBe(originalContent);
    });

    // BDD: 临时文件被清理 (happy-path)
    // Catches bug: leaving orphan .tmp files after markdown write
    it('cleans up temp files after successful write', () => {
      const mdFile = path.join(testDir, 'cleanup.md');
      writeMarkdownAtomic(mdFile, '# Temp cleanup');
      const dir = path.dirname(mdFile);
      const basename = path.basename(mdFile);
      const files = fs.readdirSync(dir);
      const tmpFiles = files.filter(f => f.startsWith(`.${basename}.`) && f.endsWith('.tmp'));
      expect(tmpFiles).toHaveLength(0);
    });

    // BDD: 验证 tmp → rename 原子写入模式 (Rule 1: 成功流程 — renameSync 必须被调用且参数正确)
    // Catches bug: writeMarkdownAtomic skipping tmp→rename and writing directly via writeFileSync
    // Catches cheat: dummy renameSync call with wrong paths while writing directly to target
    // 通过 vi.mock 包装的 fs.renameSync 验证 renameSync 被调用且参数为 tmp→target
    it('verifies tmp→rename pattern via renameSync spy', () => {
      const mdFile = path.join(testDir, 'rename-spy-verify.md');
      writeMarkdownAtomic(mdFile, '# Rename spy verification');
      // Verify renameSync was called with a tmp file path as source and target file as destination
      expect(vi.mocked(fs.renameSync)).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        mdFile
      );
    });

    // BDD: rename 异常时原始文件保持不变 + 临时文件清理 (Rule 2: 写入异常 — rename 失败路径)
    // Catches bug(1): 直接写入目标文件导致 rename 失败时原文件被损坏
    // Catches bug(2): rename 失败后残留 .tmp 文件未被清理
    // 与现有的 mkdir 失败测试互补，覆盖 rename 失败路径
    it('preserves original file and cleans tmp on rename failure', () => {
      const mdFile = path.join(testDir, 'rename-failure-guard.md');
      writeMarkdownAtomic(mdFile, '# Original content');
      const originalContent = fs.readFileSync(mdFile, 'utf-8');

      // Override the vi.mock'd renameSync to throw — simulates rename failure after tmp write succeeds
      const mockedRename = vi.mocked(fs.renameSync);
      const originalImpl = mockedRename.getMockImplementation();
      mockedRename.mockImplementation(() => {
        throw new Error('Simulated rename failure');
      });

      try {
        expect(() => {
          writeMarkdownAtomic(mdFile, '# New content that must not appear');
        }).toThrow();

        // Original content must be preserved unmodified
        expect(fs.readFileSync(mdFile, 'utf-8')).toBe(originalContent);

        // Temp files must be cleaned up after rename failure
        const dir = path.dirname(mdFile);
        const basename = path.basename(mdFile);
        const files = fs.readdirSync(dir);
        const tmpFiles = files.filter(f => f.startsWith(`.${basename}.`) && f.endsWith('.tmp'));
        expect(tmpFiles).toHaveLength(0);
      } finally {
        mockedRename.mockImplementation(originalImpl!);
        mockedRename.mockClear();
      }
    });
  });

  // ====================================================================
  // Comprehensive atomicity contract tests (one per function)
  // Closes G-01: fsync verified for writeTextAtomic and writeMarkdownAtomic (not just writeJsonAtomic)
  // Closes G-02: content provenance — writeFileSync receives actual user content (not empty)
  // Closes G-03: fsync file descriptor verified — fsyncSync receives the tmp file's fd, not a decoy
  // ====================================================================
  describe('atomicity contract — G-01/G-02/G-03', () => {
    // Shared verifier: asserts the full atomic write sequence
    function verifyContract(
      targetFile: string,
      userContent: string,
      verifyContent: () => void,
    ) {
      // --- G-02: Content provenance - writeFileSync receives actual user content ---
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledTimes(1);
      const wfCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      const tmpPath = wfCall[0] as string;
      expect(wfCall[1]).toBe(userContent);

      // --- Tmp path pattern: same directory as target, .tmp suffix ---
      expect(path.dirname(tmpPath)).toBe(path.dirname(targetFile));
      expect(path.basename(tmpPath)).toMatch(/^\..*\.tmp$/);

      // --- G-03: openSync returns an fd, fsyncSync receives that fd (not a decoy) ---
      expect(vi.mocked(fs.openSync)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(fs.openSync).mock.calls[0][0]).toBe(tmpPath);
      const fd = vi.mocked(fs.openSync).mock.results[0]?.value as number;
      expect(typeof fd).toBe('number');
      expect(fd).toBeGreaterThan(0);
      expect(vi.mocked(fs.fsyncSync)).toHaveBeenCalledWith(fd);
      expect(vi.mocked(fs.closeSync)).toHaveBeenCalledWith(fd);
      expect(vi.mocked(fs.renameSync)).toHaveBeenCalledWith(tmpPath, targetFile);

      // --- Call order: writeFileSync → openSync → fsyncSync → closeSync → renameSync ---
      const wfOrder = vi.mocked(fs.writeFileSync).mock.invocationCallOrder[0];
      const openOrder = vi.mocked(fs.openSync).mock.invocationCallOrder[0];
      const fsyncOrder = vi.mocked(fs.fsyncSync).mock.invocationCallOrder[0];
      const closeOrder = vi.mocked(fs.closeSync).mock.invocationCallOrder[0];
      const renameOrder = vi.mocked(fs.renameSync).mock.invocationCallOrder[0];
      expect(wfOrder).toBeLessThan(openOrder);
      expect(openOrder).toBeLessThan(fsyncOrder);
      expect(fsyncOrder).toBeLessThan(closeOrder);
      expect(closeOrder).toBeLessThan(renameOrder);

      // --- No tmp files remain after successful write ---
      const files = fs.readdirSync(path.dirname(targetFile));
      expect(files.filter(f => f.endsWith('.tmp'))).toHaveLength(0);

      // --- Final content correctness ---
      verifyContent();
    }

    it('writeJsonAtomic performs full atomic write sequence with fsync and content provenance', () => {
      const target = path.join(testDir, 'a-contract-json.json');
      const data = { a: 1, b: 'test' };
      const expected = JSON.stringify(data, null, 2);
      writeJsonAtomic(target, data);
      verifyContract(target, expected, () => {
        expect(JSON.parse(fs.readFileSync(target, 'utf-8'))).toEqual(data);
      });
    });

    // G-01 fix: writeTextAtomic must also fsync (not just writeJsonAtomic)
    it('writeTextAtomic performs full atomic write sequence with fsync and content provenance', () => {
      const target = path.join(testDir, 'a-contract-text.txt');
      const content = 'Atomic text content for contract test.';
      writeTextAtomic(target, content);
      verifyContract(target, content, () => {
        expect(fs.readFileSync(target, 'utf-8')).toBe(content);
      });
    });

    // G-01 fix: writeMarkdownAtomic must also fsync (not just writeJsonAtomic)
    it('writeMarkdownAtomic performs full atomic write sequence with fsync and content provenance', () => {
      const target = path.join(testDir, 'a-contract-md.md');
      const content = '# Atomic Markdown\n\nWith fsync.';
      writeMarkdownAtomic(target, content);
      verifyContract(target, content, () => {
        expect(fs.readFileSync(target, 'utf-8')).toBe(content);
      });
    });

    // Cheat fix: openSync/fsyncSync/closeSync must execute even for empty content
    // Catches cheat: guarding openSync/fsyncSync/closeSync with `if (content !== '')`
    // Verifies the full fsync sequence runs for empty strings, not just non-empty
    it('writeTextAtomic performs full atomic write sequence for empty content', () => {
      const target = path.join(testDir, 'a-contract-empty.txt');
      writeTextAtomic(target, '');
      verifyContract(target, '', () => {
        expect(fs.readFileSync(target, 'utf-8')).toBe('');
      });
    });

    // Cheat fix: writeMarkdownAtomic must also fsync for empty content (symmetric)
    // Catches cheat: writeMarkdownAtomic skipping openSync/fsyncSync/closeSync for ''
    it('writeMarkdownAtomic performs full atomic write sequence for empty content', () => {
      const target = path.join(testDir, 'a-contract-empty.md');
      writeMarkdownAtomic(target, '');
      verifyContract(target, '', () => {
        expect(fs.readFileSync(target, 'utf-8')).toBe('');
      });
    });

    // BDD: tmp 路径包含随机后缀，避免并发冲突 (Rule 5: tmp 文件路径含随机后缀)
    // Catches cheat: 固定 tmp 文件名（无随机成分）导致并发碰撞
    it('generates unique tmp paths for successive writes', () => {
      const target = path.join(testDir, 'unique-tmp-test.json');

      writeJsonAtomic(target, { v: 1 });
      const tmpPath1 = vi.mocked(fs.writeFileSync).mock.calls[0][0] as string;

      vi.clearAllMocks();

      writeJsonAtomic(target, { v: 2 });
      const tmpPath2 = vi.mocked(fs.writeFileSync).mock.calls[0][0] as string;

      expect(tmpPath1).not.toBe(tmpPath2);
    });
  });
});
