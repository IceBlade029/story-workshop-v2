/**
 * visible-view-repository.ts — 可见视图存储（design doc §3.4、§4.1、§4.3）。
 *
 * visible_views/<sceneId>.json  # 可见视图
 *
 * 可见视图由本地代码从细纲确定性生成（§6.3，无模型参与）。记录来源细纲
 * hash（sourceHash）与用户手改标记（userEdited）。新鲜度全部由 hash 比对
 * 驱动：细纲变更且未手改 → 自动重新生成；手改过 → needsRegeneration 置位
 * 并受保护，不静默覆盖（§6.4）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileExists, readJsonFile, writeJsonFile } from '../file-store';
import type { VisibleView } from '../../shared/types';

export class VisibleViewRepository {
  constructor(private readonly projectDir: string) {}

  private viewFilePath(sceneId: string): string {
    return path.join(this.projectDir, 'visible_views', `${sceneId}.json`);
  }

  read(sceneId: string): VisibleView | null {
    return readJsonFile<VisibleView>(this.viewFilePath(sceneId));
  }

  write(view: VisibleView): void {
    writeJsonFile(this.viewFilePath(view.sceneId), view);
  }

  exists(sceneId: string): boolean {
    return fileExists(this.viewFilePath(sceneId));
  }

  /** 细纲变更后标失效（§4.3）。 */
  markStale(sceneId: string): void {
    const view = this.read(sceneId);
    if (!view) return;
    this.write({ ...view, needsRegeneration: true });
  }

  /** 用户手改后置位，阻止静默覆盖（§6.3）。 */
  markUserEdited(sceneId: string): void {
    const view = this.read(sceneId);
    if (!view) return;
    this.write({ ...view, userEdited: true });
  }

  /** 删除某场景的可见视图（节点删除时清理，§9.4）。 */
  delete(sceneId: string): void {
    try {
      fs.unlinkSync(this.viewFilePath(sceneId));
    } catch {
      /* 不存在 */
    }
  }
}
