/**
 * path-safety.ts — 落盘路径安全（P0：模型/用户可控 ID 一律校验后再拼路径）。
 *
 * 三层防线：
 * 1. assertSafeId：ID 白名单字符集正则，拒绝路径分隔符 / `..` / 空串 / 超长；
 * 2. assertSafeFormat：格式名正则（白名单字符集）；
 * 3. resolveWithin：path.resolve() 后断言目标仍在指定子目录内（纵深防御，
 *    即使未来有拼接漏洞也不至于写出项目子目录之外）。
 *
 * 全部仓库的 file-path builder 必须先用本模块校验输入，再拼接路径。
 */
import * as path from 'path';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const FORMAT_PATTERN = /^[a-z0-9-]{1,32}$/;

/** 校验实体 id（节点/场景/设定/附件/run/会话）；不合法直接抛错。 */
export function assertSafeId(id: string, label: string): string {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error(`INVALID_${label.toUpperCase().replace(/\s+/g, '_')}_ID: ${String(id).slice(0, 80)}`);
  }
  return id;
}

/** 校验格式名（novel / script 等）；不合法直接抛错。 */
export function assertSafeFormat(format: string): string {
  if (typeof format !== 'string' || !FORMAT_PATTERN.test(format)) {
    throw new Error(`INVALID_FORMAT: ${String(format).slice(0, 80)}`);
  }
  return format;
}

/**
 * 把文件名拼入 projectDir/<subDir>/ 并断言结果仍在子目录内。
 * 防止任何 `..`/绝对路径/符号型分隔符把写入带出项目子目录。
 */
export function resolveWithin(projectDir: string, subDir: string, fileName: string): string {
  const base = path.resolve(projectDir, subDir);
  const full = path.resolve(base, fileName);
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error('PATH_ESCAPE: 路径越界（不在指定子目录内）');
  }
  return full;
}
