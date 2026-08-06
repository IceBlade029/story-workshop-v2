/**
 * app-service-m5.test.ts — M5 披露与正文管道（design doc §11.3 M5）。
 *
 * 覆盖：暂不明示标记 → 可见视图生成与自动重生成、手改保护、正文生成
 * （detail_fill）、outputs 落盘与失效标记、删除清理、隔离验证。
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
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

/** 记录每次模型输入的适配器；脚本可中途替换（多轮运行测试用）。 */
class RecordingAdapter implements ModelAdapter {
  readonly provider = 'recording';
  readonly inputs: ModelTurnInput[] = [];
  private inner: ScriptedModelAdapter;

  constructor(script: ScriptedTurn[]) {
    this.inner = new ScriptedModelAdapter(script);
  }

  /** 替换后续运行的脚本（模拟第二次运行）。 */
  replaceScript(script: ScriptedTurn[]): void {
    this.inner = new ScriptedModelAdapter(script);
  }

  async runTurn(input: ModelTurnInput, options?: unknown): Promise<ModelTurn> {
    this.inputs.push(input);
    return this.inner.runTurn(input, options as never);
  }
}

function makeService(script: ScriptedTurn[] = []): { service: AppService; model: RecordingAdapter } {
  const model = new RecordingAdapter(script);
  const createModel = (): ModelAdapter => model;
  const service = new AppService(createModel);
  const root = makeTempDir();
  tempDirs.push(root);
  service.createProject(path.join(root, 'proj'), 'M5 项目');
  return { service, model };
}

const SCENE_DRAFT = '陈默（{{暂不明示：陈默是凶手}}）约林静在天桥见面。\n两人对峙。';

function addScene(service: AppService, type: 'scene' | 'volume' = 'scene', title = '天桥决斗'): string {
  service.createNode('overview', type, title);
  const node = service.getState().nodes.find((n) => n.title === title)!;
  if (type === 'scene') service.writeDraft(node.id, SCENE_DRAFT);
  return node.id;
}

/** detail_fill 脚本（按真实场景 id 组装，一次运行 4 轮）。 */
function detailScript(sceneId: string, content = '正文：陈默约林静在天桥见面。'): ScriptedTurn[] {
  return [
    { type: 'tool_calls', toolCalls: [toolCall('c1', 'read_visible_view', { sceneId })], usage: usage(10, 3) },
    { type: 'tool_calls', toolCalls: [toolCall('c2', 'read_format_template', { format: 'novel' })], usage: usage(20, 3) },
    { type: 'tool_calls', toolCalls: [toolCall('c3', 'write_output', { sceneId, format: 'novel', content })], usage: usage(30, 6) },
    { type: 'final', answer: '正文已生成。', usage: usage(40, 4) },
  ];
}

describe('M5 — 暂不明示标记与可见视图（§6.1、§6.3、§6.4）', () => {
  it('生成可见视图：机械移除标记；getState 携带状态', () => {
    const { service } = makeService([]);
    const sceneId = addScene(service);
    service.generateVisibleView(sceneId);

    const view = service.readVisibleView(sceneId)!;
    expect(view.content).toBe('陈默（）约林静在天桥见面。\n两人对峙。');
    expect(view.content).not.toContain('暂不明示');
    expect(view.sourceHash.length).toBe(64);

    const node = service.getState().nodes.find((n) => n.id === sceneId)!;
    expect(node.visibleView?.exists).toBe(true);
    expect(node.visibleView?.userEdited).toBe(false);
    expect(node.visibleView?.needsRegeneration).toBe(false);
  });

  it('细纲变更 → 自动重新生成（未手改）', () => {
    const { service } = makeService([]);
    const sceneId = addScene(service);
    service.generateVisibleView(sceneId);

    service.writeDraft(sceneId, SCENE_DRAFT.replace('林静', '林静（{{暂不明示：林静是目击者}}）'));
    const view = service.readVisibleView(sceneId)!;
    expect(view.content).toBe('陈默（）约林静（）在天桥见面。\n两人对峙。');
    expect(view.needsRegeneration).toBe(false);
  });

  it('手改后受保护：细纲变更 → needsRegeneration，内容不覆盖；重新生成覆盖手改', () => {
    const { service } = makeService([]);
    const sceneId = addScene(service);
    service.generateVisibleView(sceneId);
    service.updateVisibleView(sceneId, '手改：加一段暗示');

    service.writeDraft(sceneId, SCENE_DRAFT + '\n新增冲突');
    const view = service.readVisibleView(sceneId)!;
    expect(view.content).toBe('手改：加一段暗示');
    expect(view.needsRegeneration).toBe(true);
    expect(service.getState().nodes.find((n) => n.id === sceneId)!.visibleView?.needsRegeneration).toBe(true);

    // 显式重新生成（UI 确认后）→ 覆盖手改并复位
    service.generateVisibleView(sceneId);
    const regen = service.readVisibleView(sceneId)!;
    expect(regen.content).toContain('新增冲突');
    expect(regen.userEdited).toBe(false);
    expect(regen.needsRegeneration).toBe(false);
  });

  it('非场景节点生成视图抛错；删除节点清理视图与输出', () => {
    const { service } = makeService([]);
    const sceneId = addScene(service);
    service.generateVisibleView(sceneId);
    const volumeId = addScene(service, 'volume', '第一卷');
    expect(() => service.generateVisibleView(volumeId)).toThrow('NOT_SCENE_NODE');

    service.deleteNode(sceneId);
    expect(service.readVisibleView(sceneId)).toBeNull();
    expect(fs.existsSync(path.join(service.dir, 'visible_views', `${sceneId}.json`))).toBe(false);
  });
});

describe('M5 — 正文生成与 outputs 落盘（§6.5、§3.5）', () => {
  it('detail_fill：可见视图 → 模板 → 正文落盘；沙箱隔离（对话日志零痕迹）；模型输入只有任务指令与白名单工具', async () => {
    const { service, model } = makeService();
    const sceneId = addScene(service);
    service.generateVisibleView(sceneId);
    model.replaceScript(detailScript(sceneId));

    const before = service.getState().messages;
    const result = await service.runDetailFill(sceneId, 'novel');
    expect(result.error).toBeUndefined();
    expect(result.taskKind).toBe('detail_fill');
    expect(result.snapshotId).toBe(result.runId);

    // 输出落盘
    const outputPath = path.join(service.dir, 'outputs', `${sceneId}.novel.md`);
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.readFileSync(outputPath, 'utf-8')).toBe('正文：陈默约林静在天桥见面。');

    // 沙箱隔离（ux-review §5.2 修订）：正文生成不产生任何对话消息（无提示/无运行事件/无 AI 回答）
    const after = service.getState().messages;
    expect(after).toHaveLength(before.length);
    expect(after.some((m) => m.content.includes('已生成'))).toBe(false);
    expect(after.some((m) => m.role === 'ai')).toBe(false);

    // 隔离验证：模型输入消息只有任务指令（无细纲/标记/设定内容），工具只有白名单三个
    const input = model.inputs[0];
    const content = input.messages.map((m) => ('content' in m ? m.content : '')).join('\n');
    expect(content).not.toContain('陈默是凶手');
    expect(content).not.toContain('天桥');
    expect(input.tools?.map((t) => t.name)).toEqual(['read_visible_view', 'read_format_template', 'write_output']);
    // 可见视图里物理上没有标记——正文生成器拿不到标记与细纲（§6.5）
    expect(service.readVisibleView(sceneId)!.content).not.toContain('暂不明示');
    // 最终回答保留在调用详情记录里（§4.7 全任务一致透明）
    expect(service.inspectRun(result.runId)?.returned.finalAnswer).toContain('已写入运行记录');
  });

  it('输出失效：视图变更后 stale=true；重新生成后恢复', async () => {
    const { service, model } = makeService();
    const sceneId = addScene(service);
    service.generateVisibleView(sceneId);
    model.replaceScript(detailScript(sceneId));
    await service.runDetailFill(sceneId, 'novel');
    expect(service.listOutputs(sceneId)).toEqual([
      expect.objectContaining({ format: 'novel', stale: false }),
    ]);
    expect(service.listFormats()).toEqual(['novel', 'script']);

    // 视图变更 → 输出失效（§3.5）
    service.updateVisibleView(sceneId, '手改视图');
    expect(service.listOutputs(sceneId)[0].stale).toBe(true);

    // 重新生成正文 → 失效恢复
    model.replaceScript(detailScript(sceneId, '第二版正文'));
    const regen = await service.runDetailFill(sceneId, 'novel');
    expect(regen.error).toBeUndefined();
    expect(service.listOutputs(sceneId)[0].stale).toBe(false);
  });

  it('反馈重生成：输入 = 旧输出 + 反馈（仍只读可见视图）', async () => {
    const { service, model } = makeService();
    const sceneId = addScene(service);
    service.generateVisibleView(sceneId);
    model.replaceScript(detailScript(sceneId));
    await service.runDetailFill(sceneId, 'novel');

    model.replaceScript(detailScript(sceneId, '第二版正文'));
    const result = await service.runDetailFill(sceneId, 'novel', '节奏太快，加一段心理描写');
    expect(result.error).toBeUndefined();
    const lastInput = model.inputs.at(-1)!;
    const content = lastInput.messages.map((m) => ('content' in m ? m.content : '')).join('\n');
    expect(content).toContain('上一版输出');
    expect(content).toContain('正文：陈默约林静在天桥见面。');
    expect(content).toContain('节奏太快，加一段心理描写');
  });

  it('无可见视图 / 视图需重新生成：拒绝运行（§6.4）', async () => {
    const { service, model } = makeService();
    const sceneId = addScene(service);
    model.replaceScript(detailScript(sceneId));
    await expect(service.runDetailFill(sceneId, 'novel')).rejects.toThrow('NO_VISIBLE_VIEW');

    service.generateVisibleView(sceneId);
    service.updateVisibleView(sceneId, '手改');
    service.writeDraft(sceneId, SCENE_DRAFT + '\n变更'); // 手改 → needsRegeneration
    await expect(service.runDetailFill(sceneId, 'novel')).rejects.toThrow('VIEW_NEEDS_REGENERATION');
  });

  it('非场景节点不能生成正文', async () => {
    const { service } = makeService([]);
    const volumeId = addScene(service, 'volume', '第一卷');
    await expect(service.runDetailFill(volumeId, 'novel')).rejects.toThrow('NOT_SCENE_NODE');
  });
});

describe('M5 — 就地改写（revise，ux-review §5.3）', () => {
  it('runRevise：只读白名单，模型最终回答 = 替换文本；applyRevise 确定性替换 + 快照；undoRevise 单级撤销', async () => {
    const { service, model } = makeService();
    const sceneId = addScene(service);
    service.generateVisibleView(sceneId);
    model.replaceScript(detailScript(sceneId));
    await service.runDetailFill(sceneId, 'novel');
    const original = fs.readFileSync(path.join(service.dir, 'outputs', `${sceneId}.novel.md`), 'utf-8');
    const mid = Math.floor(original.length / 2);

    // 改写：模型只返回替换文本（沙箱隔离：运行本身也不产生对话消息）
    const messagesBefore = service.getState().messages;
    model.replaceScript([{ type: 'final', answer: '【更强张力版】', usage: usage(5, 2) }]);
    const result = await service.runRevise(sceneId, 'novel', mid, mid + 4, '更有张力');
    expect(result.error).toBeUndefined();
    expect(result.taskKind).toBe('revise');
    expect(service.getState().messages).toHaveLength(messagesBefore.length);
    expect(service.getState().messages.some((m) => m.content.includes('【更强张力版】'))).toBe(false);
    // 运行期间不写盘（替换在接受时执行）
    expect(fs.readFileSync(path.join(service.dir, 'outputs', `${sceneId}.novel.md`), 'utf-8')).toBe(original);
    // 白名单：无写入工具
    const input = model.inputs.at(-1)!;
    expect(input.tools?.map((t) => t.name).sort()).toEqual(['list_assets', 'read_asset', 'read_output', 'read_visible_view'].sort());
    // 任务消息包含选中区间与指令
    const content = input.messages.map((m) => ('content' in m ? m.content : '')).join('\n');
    expect(content).toContain('更有张力');
    expect(content).toContain(original.slice(mid, mid + 4));

    // 接受：替换 = 新文本替换原选区
    service.applyRevise(sceneId, 'novel', mid, mid + 4, '【更强张力版】');
    const after = fs.readFileSync(path.join(service.dir, 'outputs', `${sceneId}.novel.md`), 'utf-8');
    expect(after).toBe(original.slice(0, mid) + '【更强张力版】' + original.slice(mid + 4));
    // 沙箱隔离（ux-review §5.2 修订）：改写接受不产生任何对话消息（替换文本不泄漏进讨论）
    expect(service.getState().messages.some((m) => m.content.includes('已改写'))).toBe(false);
    expect(service.getState().messages.some((m) => m.content.includes('【更强张力版】'))).toBe(false);

    // 撤销上次改写（单级）
    service.undoRevise(sceneId, 'novel');
    expect(fs.readFileSync(path.join(service.dir, 'outputs', `${sceneId}.novel.md`), 'utf-8')).toBe(original);
  });

  it('runRevise：无正文/区间非法 → 拒绝', async () => {
    const { service, model } = makeService();
    const sceneId = addScene(service);
    service.generateVisibleView(sceneId);
    model.replaceScript(detailScript(sceneId));
    await service.runDetailFill(sceneId, 'novel');

    await expect(service.runRevise(sceneId, 'novel', 0, 99999, '润色')).rejects.toThrow('INVALID_RANGE');
    const volumeId = addScene(service, 'volume', '第一卷');
    await expect(service.runRevise(volumeId, 'novel', 0, 1, '润色')).rejects.toThrow('NOT_SCENE_NODE');
  });

  it('applyRevise：替换为空 = 删除选中区间（§5.3 契约）', async () => {
    const { service, model } = makeService();
    const sceneId = addScene(service);
    service.generateVisibleView(sceneId);
    model.replaceScript(detailScript(sceneId));
    await service.runDetailFill(sceneId, 'novel');
    const original = fs.readFileSync(path.join(service.dir, 'outputs', `${sceneId}.novel.md`), 'utf-8');

    service.applyRevise(sceneId, 'novel', 2, 4, '');
    const after = fs.readFileSync(path.join(service.dir, 'outputs', `${sceneId}.novel.md`), 'utf-8');
    expect(after).toBe(original.slice(0, 2) + original.slice(4));
  });
});
