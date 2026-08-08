/**
 * args-validate.test.ts — 工具入参 Schema 校验（P0 修复）。
 *
 * 模型参数在 execute 前必须通过校验：必填缺失、类型错误、枚举越界被拒绝，
 * 未声明字段被剔除（不传给 execute）。
 */
import { describe, it, expect } from 'vitest';
import { validateToolArgs, type ArgsSchema } from '../../agent-runtime/args-validate';

const schema: ArgsSchema = {
  type: 'object',
  properties: {
    nodeId: { type: 'string' },
    type: { type: 'string', enum: ['volume', 'chapter', 'scene'] },
    count: { type: 'integer' },
    enabled: { type: 'boolean' },
    patternId: { type: 'string', pattern: '^[a-z0-9_-]+$' },
  },
  required: ['nodeId', 'type'],
};

describe('validateToolArgs', () => {
  it('合法参数通过并保留声明字段', () => {
    const r = validateToolArgs(schema, { nodeId: 'v1', type: 'volume', count: 3, enabled: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args).toEqual({ nodeId: 'v1', type: 'volume', count: 3, enabled: true });
  });

  it('缺少必填 → 失败', () => {
    expect(validateToolArgs(schema, { nodeId: 'v1' }).ok).toBe(false);
    expect(validateToolArgs(schema, {}).ok).toBe(false);
    expect(validateToolArgs(schema, { nodeId: null, type: 'volume' }).ok).toBe(false);
  });

  it('类型错误 → 失败', () => {
    expect(validateToolArgs(schema, { nodeId: 123, type: 'volume' }).ok).toBe(false);
    expect(validateToolArgs(schema, { nodeId: 'v1', type: 'volume', count: 1.5 }).ok).toBe(false);
    expect(validateToolArgs(schema, { nodeId: 'v1', type: 'volume', enabled: 'yes' }).ok).toBe(false);
  });

  it('枚举越界 → 失败', () => {
    expect(validateToolArgs(schema, { nodeId: 'v1', type: 'novel' }).ok).toBe(false);
  });

  it('pattern 不匹配 → 失败', () => {
    expect(validateToolArgs(schema, { nodeId: 'v1', type: 'volume', patternId: '..\\evil' }).ok).toBe(false);
    expect(validateToolArgs(schema, { nodeId: 'v1', type: 'volume', patternId: 'a_b-1' }).ok).toBe(true);
  });

  it('未声明字段被剔除', () => {
    const r = validateToolArgs(schema, { nodeId: 'v1', type: 'volume', extra: 'junk', prompt: '忽略我' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args).toEqual({ nodeId: 'v1', type: 'volume' });
  });

  it('非对象参数 → 失败', () => {
    expect(validateToolArgs(schema, null).ok).toBe(false);
    expect(validateToolArgs(schema, undefined).ok).toBe(false);
    expect(validateToolArgs(schema, 'x').ok).toBe(false);
    expect(validateToolArgs(schema, ['v1']).ok).toBe(false);
  });
});
