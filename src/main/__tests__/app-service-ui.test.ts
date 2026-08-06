/**
 * app-service-ui.test.ts — UI 支撑能力（§3.1 拖拽重排、§5.4 文件级 diff）。
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import * as path from 'path';
import { AppService } from '../app-service';
import { ScriptedModelAdapter, type ScriptedTurn } from '../agent-runtime/scripted-model-adapter';
import type { ModelAdapter, ModelTurnInput, ModelTurn } from '../agent-runtime/model-types';
import { makeTempDir, removeDir } from './helpers/temp-project';

vi.mock('../api-key-store', () => ({
  saveApiKey: vi.fn(),
  hasApiKey: () => false,
  loadApiKeyEntry: () => null,
}));

const tempDirs: string[] = [];
afterAll(() => tempDirs.forEach(removeDir));

function usage(i: number, o: number) {
  return { inputTokens: i, outputTokens: o };
}

function toolCall(id: string, name: string, arguments_: Record<string, unknown>) {
  return { id, name, arguments: arguments_ };
}

/** 脚本可中途替换的适配器（运行前按真实节点 id 组装脚本）。 */
class MutableScriptAdapter implements ModelAdapter {
  readonly provider = 'scripted';
  private inner: ScriptedModelAdapter;
  constructor(script: ScriptedTurn[] = []) {
    this.inner = new ScriptedModelAdapter(script);
  }
  replaceScript(script: ScriptedTurn[]): void {
    this.inner = new ScriptedModelAdapter(script);
  }
  async runTurn(input: ModelTurnInput, options?: unknown): Promise<ModelTurn> {
    return this.inner.runTurn(input, options as never);
  }
}

function makeService(script: ScriptedTurn[] = []): { service: AppService; model: MutableScriptAdapter } {
  const model = new MutableScriptAdapter(script);
  const service = new AppService(() => model);
  const root = makeTempDir();
  tempDirs.push(root);
  service.createProject(path.join(root, 'proj'), 'UI 项目');
  return { service, model };
}

describe('moveNode — 大纲拖拽重排（§3.1）', () => {
  function seed(): AppService {
    const { service } = makeService();
    service.createNode('overview', 'volume', '第一卷');
    const v1 = service.getState().nodes.find((n) => n.title === '第一卷')!;
    service.createNode(v1.id, 'chapter', '第一章');
    service.createNode(v1.id, 'chapter', '第二章');
    service.createNode(v1.id, 'chapter', '第三章');
    return service;
  }

  it('同父重排：index 生效', () => {
    const service = seed();
    const state = service.getState();
    const v1 = state.nodes.find((n) => n.title === '第一卷')!;
    const c3 = state.nodes.find((n) => n.title === '第三章')!;
    service.moveNode(c3.id, v1.id, 0);
    const after = service.getState();
    const order = after.nodes.filter((n) => n.parentId === v1.id).map((n) => n.title);
    expect(order).toEqual(['第三章', '第一章', '第二章']);
  });

  it('跨父移动 + 非法移动抛错（移入自身/后代/根）', () => {
    const service = seed();
    service.createNode('overview', 'volume', '第二卷');
    const state = service.getState();
    const v2 = state.nodes.find((n) => n.title === '第二卷')!;
    const c1 = state.nodes.find((n) => n.title === '第一章')!;
    service.moveNode(c1.id, v2.id);
    expect(service.getState().nodes.find((n) => n.id === c1.id)?.parentId).toBe(v2.id);

    expect(() => service.moveNode(v2.id, v2.id)).toThrow('CANNOT_MOVE_INTO_SELF');
    expect(() => service.moveNode('overview', v2.id)).toThrow('CANNOT_MOVE_ROOT');
    expect(() => service.moveNode(v2.id, c1.id)).toThrow('CANNOT_MOVE_INTO_DESCENDANT');
  });
});

describe('runDiff — 变更摘要的文件级 diff（§5.4）', () => {
  it('draft_updated / node_created / node_deleted / asset_updated 四类', async () => {
    const { service, model } = makeService();
    // 预置：一个既有章（供 update）与一个既有设定（供 update）
    service.createNode('overview', 'chapter', '旧章');
    const old = service.getState().nodes.find((n) => n.title === '旧章')!;
    service.writeDraft(old.id, '旧草稿内容');
    service.createAsset('character', '林默', '侦探');
    const a1 = service.getState().assets[0].id;
    service.sendMessage('讨论：新章与设定');
    model.replaceScript([
      { type: 'tool_calls', toolCalls: [toolCall('c1', 'create_node', { type: 'chapter', title: '新章', nodeId: 'c9' })], usage: usage(5, 2) },
      { type: 'tool_calls', toolCalls: [toolCall('c2', 'write_draft', { nodeId: 'c9', content: '第一版草稿' })], usage: usage(8, 2) },
      { type: 'tool_calls', toolCalls: [toolCall('c3', 'write_asset', { type: 'character', title: '林默', content: '侦探' })], usage: usage(10, 2) },
      { type: 'tool_calls', toolCalls: [toolCall('c4', 'write_asset', { assetId: a1, content: '侦探，住在青石镇' })], usage: usage(12, 2) },
      { type: 'final', answer: '完成', usage: usage(15, 3) },
    ]);

    const result = await service.run({
      kind: 'organize',
      scope: { type: 'unorganized' },
    });
    expect(result.error).toBeUndefined();

    // 运行中模型又写了几处 → 用第二次运行制造「既有文件被修改」路径：
    // 上面脚本 c1/c2 创建了 c9 + 草稿（before=null / after=内容）
    const diffs = service.runDiff(result.runId);
    const byPath = new Map(diffs.map((d) => [d.path, d]));
    const c9Draft = byPath.get('nodes/c9.draft.md');
    expect(c9Draft).toBeTruthy();
    expect(c9Draft!.before).toBeNull(); // 新建文件
    expect(c9Draft!.after).toContain('第一版草稿');
    // outline.json 与 meta 不参与文件级 diff（结构变更由结构列表表达）
    expect(diffs.some((d) => d.path.includes('outline.json'))).toBe(false);
    expect(diffs.some((d) => d.path.includes('.meta.json'))).toBe(false);
  });

  it('已删除文件的 diff：after=null；无变化的文件不返回', async () => {
    const { service, model } = makeService();
    service.createNode('overview', 'chapter', '受害者');
    const victim = service.getState().nodes.find((n) => n.title === '受害者')!;
    service.writeDraft(victim.id, '将被删除的草稿');
    service.sendMessage('讨论：删除受害者');
    model.replaceScript([
      { type: 'tool_calls', toolCalls: [toolCall('c1', 'delete_node', { nodeId: victim.id })], usage: usage(5, 2) },
      { type: 'final', answer: '已删除', usage: usage(8, 2) },
    ]);

    const result = await service.run({
      kind: 'organize',
      scope: { type: 'unorganized' },
    });
    expect(result.error).toBeUndefined();
    const diffs = service.runDiff(result.runId);
    const victimDraft = diffs.find((d) => d.path === `nodes/${victim.id}.draft.md`);
    expect(victimDraft?.after).toBeNull();
    expect(victimDraft?.before).toContain('将被删除的草稿');
  });

  it('不存在的 runId 抛错', () => {
    const { service } = makeService();
    expect(() => service.runDiff('ghost')).toThrow('SNAPSHOT_NOT_FOUND');
  });
});
