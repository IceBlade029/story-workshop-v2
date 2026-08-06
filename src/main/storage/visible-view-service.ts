/**
 * visible-view-service.ts — 可见视图生成服务（design doc §3.4、§6.3、§6.4）。
 *
 * 可见视图由本地代码从细纲确定性生成：移除细纲中全部 {{暂不明示：…}} 标记
 * 区间（§6.1）。无模型参与、零 API 调用。
 *
 * 新鲜度全部由 hash 比对驱动（§4.3）：
 * - 生成时记录 sourceHash = 细纲文本 hash；
 * - 细纲变更（syncStale）且未被手改 → 自动重新生成；
 * - 手改过的视图受保护：不静默覆盖，置 needsRegeneration，由作者决定。
 *
 * 细纲来源：正式版优先，无正式版时用草稿（§5.5 提交后正式版即细纲权威文本；
 * 提交 = 草稿复制为正式版，内容 hash 不变时不会误触发重新生成）。
 */
import { OutlineRepository } from './outline-repository';
import { VisibleViewRepository } from './visible-view-repository';
import { stripDisclosureMarkers } from './marker';
import { sha256 } from './hash';
import type { OutlineNode, VisibleView } from '../../shared/types';

export class VisibleViewService {
  constructor(
    private readonly outline: OutlineRepository,
    private readonly views: VisibleViewRepository,
  ) {}

  /** 场景的细纲文本：正式版优先，其次草稿；没有内容（含空文本）时返回 null。 */
  sceneOutlineContent(sceneId: string): string | null {
    let content: string | null = null;
    if (this.outline.hasOfficial(sceneId)) content = this.outline.readOfficial(sceneId);
    else if (this.outline.hasDraft(sceneId)) content = this.outline.readDraft(sceneId);
    return content && content.trim() !== '' ? content : null;
  }

  /**
   * 生成（或重新生成）可见视图（§6.3）。重新生成会覆盖手改——调用方负责
   * 在 UI 上确认（§6.4）。失败抛错：非场景节点 / 场景无细纲内容。
   */
  generate(sceneId: string): VisibleView {
    const node = this.outline.findNode(sceneId);
    if (!node || node.type !== 'scene') throw new Error(`NOT_SCENE_NODE: ${sceneId}`);
    const source = this.sceneOutlineContent(sceneId);
    if (source === null) throw new Error(`NO_SCENE_OUTLINE: ${sceneId}`);
    const view: VisibleView = {
      sceneId,
      content: stripDisclosureMarkers(source),
      sourceHash: sha256(source),
      userEdited: false,
      needsRegeneration: false,
      generatedAt: new Date().toISOString(),
    };
    this.views.write(view);
    this.syncMeta(sceneId, view);
    return view;
  }

  /** 用户手改：置位 userEdited 并清除失效标记（§6.4；手改后视图由作者负责）。 */
  saveUserEdit(sceneId: string, content: string): VisibleView {
    const node = this.outline.findNode(sceneId);
    if (!node || node.type !== 'scene') throw new Error(`NOT_SCENE_NODE: ${sceneId}`);
    const existing = this.views.read(sceneId);
    const view: VisibleView = {
      sceneId,
      content,
      sourceHash: existing?.sourceHash ?? '',
      userEdited: true,
      needsRegeneration: false,
      generatedAt: existing?.generatedAt ?? new Date().toISOString(),
    };
    this.views.write(view);
    this.syncMeta(sceneId, view);
    return view;
  }

  /**
   * 细纲变更后的新鲜度同步（§4.3、§6.3）。sceneIds 缺省 = 全部场景节点。
   * 未手改 → 自动重新生成；手改过 → 置 needsRegeneration（不覆盖）；
   * 场景失去细纲内容 → 一律置 needsRegeneration。
   */
  syncStale(sceneIds?: string[]): void {
    for (const id of sceneIds ?? this.listSceneIds()) {
      const view = this.views.read(id);
      if (!view) continue;
      const source = this.sceneOutlineContent(id);
      const currentHash = source === null ? null : sha256(source);
      if (source !== null && currentHash === view.sourceHash) continue;
      if (view.userEdited || source === null) {
        if (!view.needsRegeneration) {
          const updated = { ...view, needsRegeneration: true };
          this.views.write(updated);
          this.syncMeta(id, updated);
        }
      } else {
        this.generate(id); // 未手改 → 自动重新生成
      }
    }
  }

  /** 全部场景节点 id（遍历大纲树）。 */
  listSceneIds(): string[] {
    const tree = this.outline.readTree();
    if (!tree) return [];
    const out: string[] = [];
    const walk = (node: OutlineNode): void => {
      if (node.type === 'scene') out.push(node.id);
      for (const child of node.children) walk(child);
    };
    walk(tree.root);
    return out;
  }

  /** meta.json 中的可见视图状态镜像（§4.1：meta 记录可见视图状态，供 UI 汇总）。 */
  private syncMeta(sceneId: string, view: VisibleView): void {
    const meta = this.outline.readMeta(sceneId);
    meta.visibleView = {
      exists: true,
      sourceHash: view.sourceHash,
      userEdited: view.userEdited,
      needsRegeneration: view.needsRegeneration,
      generatedAt: view.generatedAt,
    };
    this.outline.writeMeta(sceneId, meta);
  }
}
