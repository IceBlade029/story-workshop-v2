/**
 * workspace.ts — 一个项目目录下的全部存储仓库聚合。
 *
 * M3+ 的 Agent 运行时与后续 UI 层统一从这里取仓库实例，
 * 避免散落的构造调用。
 */
import { ProjectRepository } from './project-repository';
import { OutlineRepository } from './outline-repository';
import { ConversationRepository } from './conversation-repository';
import { AttachmentRepository } from './attachment-repository';
import { AssetRepository } from './asset-repository';
import { SnapshotRepository } from './snapshot-repository';
import { VisibleViewRepository } from './visible-view-repository';
import { OutputRepository } from './output-repository';
import { TrashRepository } from './trash-repository';

export class ProjectWorkspace {
  readonly project: ProjectRepository;
  readonly outline: OutlineRepository;
  readonly conversation: ConversationRepository;
  readonly attachments: AttachmentRepository;
  readonly assets: AssetRepository;
  readonly snapshots: SnapshotRepository;
  readonly visibleViews: VisibleViewRepository;
  readonly outputs: OutputRepository;
  readonly trash: TrashRepository;

  private constructor(projectDir: string) {
    this.project = ProjectRepository.open(projectDir)!;
    this.outline = new OutlineRepository(projectDir);
    this.conversation = new ConversationRepository(projectDir);
    this.attachments = new AttachmentRepository(projectDir);
    this.assets = new AssetRepository(projectDir);
    this.snapshots = new SnapshotRepository(projectDir);
    this.visibleViews = new VisibleViewRepository(projectDir);
    this.outputs = new OutputRepository(projectDir);
    this.trash = new TrashRepository(projectDir, this.outline);
  }

  /** 打开已有项目的 workspace；不是项目时返回 null。 */
  static open(projectDir: string): ProjectWorkspace | null {
    if (!ProjectRepository.open(projectDir)) return null;
    return new ProjectWorkspace(projectDir);
  }

  static create(projectDir: string, name: string): ProjectWorkspace {
    ProjectRepository.create(projectDir, name);
    return new ProjectWorkspace(projectDir);
  }

  get dir(): string {
    return this.project.dir;
  }
}
