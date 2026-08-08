/**
 * App.tsx — 顶层形态（ux-review §2）。
 *
 * ┌────────────────────────────────────────────────┐
 * │ 顶部栏：项目名    [情节讨论] [正文写作]    ⚙      │
 * ├────────────────────────────────────────────────┤
 * │  讨论模块（全屏，独占界面）                       │
 * │  正文模块（全屏，独占界面，tab 切换进入）          │
 * └────────────────────────────────────────────────┘
 *
 * - 「情节讨论」「正文写作」是对等的一等公民模块，各自占满整个窗口，顶部 tab 切换；
 * - 模块 UI 状态互相独立：讨论模块的选中节点、正文模块的选中场景互不干扰，
 *   切换 tab 不丢状态（两模块同时挂载，display 切换）；
 * - 设置 = 顶部齿轮，弹窗（模态对话框）。
 */
import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { store, useStore, type ModuleId } from './store';
import { getApi } from './api';
import { confirmDialog, confirmDiscardDialog, promptDialog } from './components/ui/dialog';
import { LeftPanel } from './components/LeftPanel';
import { ConversationPane } from './components/ConversationPane';
import { Workspace } from './components/Workspace';
import { WritingModule } from './components/WritingModule';
import { SettingsDialog } from './components/ui/SettingsDialog';
import { ThemePicker } from './components/ui/ThemePicker';
import { GlobalSearchDialog } from './components/ui/GlobalSearchDialog';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { DialogHost } from './components/ui/dialog';
import { applyTheme } from './theme';
import './styles.css';

const MIN_LEFT = 180;
const MAX_LEFT = 480;
const MIN_RIGHT = 240;
const MAX_RIGHT = 560;

function loadWidth(key: string, fallback: number): number {
  const v = Number(localStorage.getItem(key));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function ProjectScreen(): React.ReactElement {
  const projects = useStore((s) => s.projects);
  const [name, setName] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  useEffect(() => {
    void store.loadProjects().catch((err) => store.showToast((err as Error).message, 'error'));
  }, []);

  const create = async (): Promise<void> => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await store.createProject(name.trim());
    } catch (err) {
      store.showToast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (dir: string, projectName: string): Promise<void> => {
    const ok = await confirmDialog({
      title: `删除项目「${projectName}」？`,
      message: '项目文件夹将移到系统回收站（可恢复）。若正在打开，会自动关闭并回到项目列表。',
      confirmText: '移到回收站',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await store.deleteProject(dir);
      store.showToast('项目已移到系统回收站', 'success');
    } catch (err) {
      store.showToast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="project-screen">
      <div className="project-screen-top">
        <ThemePicker />
      </div>
      <h1>故事工坊</h1>
      <p className="subtitle">大模型辅助故事创作：讨论 → 整理 → 细纲 → 可见视图 → 正文</p>

      <div className="project-form">
        <input
          data-testid="project-name"
          placeholder="项目名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void create(); }}
        />
        <button data-testid="project-create" className="primary" onClick={() => void create()} disabled={busy || !name.trim()}>
          创建项目
        </button>
        <button className="small-btn" onClick={() => void store.pickAndOpen()}>打开文件夹…</button>
      </div>

      {projects.length > 0 && (
        <div className="project-list">
          <h3>最近项目</h3>
          {projects.map((p) => (
            <div key={p.dir} className="project-item">
              <button className="project-item-main" onClick={() => void store.openProject(p.dir)}>
                <span>{p.name}</span>
                <span className="muted small">{new Date(p.createdAt).toLocaleString()}</span>
              </button>
              <button
                className="tiny-btn project-item-delete"
                disabled={busy}
                title="删除项目（移到系统回收站，可恢复）"
                onClick={() => void remove(p.dir, p.name)}
              >
                🗑
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 顶部栏（ux-review §2）：项目名菜单 + 模块 tab + 设置齿轮弹窗（§6.10）。 */
function TopBar(): React.ReactElement {
  const project = useStore((s) => s.project);
  const projects = useStore((s) => s.projects);
  const module = useStore((s) => s.module);
  const leftCollapsed = useStore((s) => s.leftCollapsed);
  const rightCollapsed = useStore((s) => s.rightCollapsed);
  const scenesCollapsed = useStore((s) => s.scenesCollapsed);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpen]);

  const MODULES: Array<{ id: ModuleId; label: string }> = [
    { id: 'discussion', label: '情节讨论' },
    { id: 'writing', label: '正文写作' },
  ];

  /** 离开当前项目前的未保存保护（§6.8：编辑器全部卸载，脏内容将丢失）。 */
  const confirmLeaveProject = async (): Promise<boolean> => {
    if (!store.hasDirtyEditors()) return true;
    const choice = await confirmDiscardDialog({
      title: '有未保存的修改',
      message: '切换项目将卸载当前编辑器，未保存内容会丢失。',
      confirmText: '保存并继续',
      discardText: '放弃修改',
      cancelText: '取消',
    });
    if (choice === 'cancel') return false;
    // 保存：逐个编辑器保存（守卫 save 列表）；任一失败则留下
    if (choice === 'save') {
      // 无统一保存入口（编辑器各自持有内容），此处直接放弃切换以避免静默丢数据
      store.showToast('请先在原编辑器内保存（Ctrl+S），再切换项目', 'info');
      return false;
    }
    return true;
  };

  const leaveToProjects = async (): Promise<void> => {
    if (!(await confirmLeaveProject())) return;
    setMenuOpen(false);
    await store.backToProjects();
  };

  const openOther = async (): Promise<void> => {
    if (!(await confirmLeaveProject())) return;
    setMenuOpen(false);
    await store.pickAndOpen();
  };

  const switchTo = async (dir: string): Promise<void> => {
    if (dir === project?.dir) {
      setMenuOpen(false);
      return;
    }
    if (!(await confirmLeaveProject())) return;
    setMenuOpen(false);
    await store.openProject(dir);
  };

  const showInFolder = (): void => {
    setMenuOpen(false);
    if (project) void getApi().project.showInFolder(project.dir).catch(() => {});
  };

  const rename = async (): Promise<void> => {
    if (!project) return;
    const name = await promptDialog({ title: '重命名项目', message: '仅更新显示名称，目录名不变。', defaultValue: project.name });
    if (name && name.trim() && name.trim() !== project.name) {
      try {
        await store.renameProject(name.trim());
        store.showToast('项目已重命名', 'success');
      } catch (err) {
        store.showToast((err as Error).message, 'error');
      }
    }
    setMenuOpen(false);
  };

  return (
    <div className="topbar">
      <div className="topbar-project-wrap" ref={menuRef}>
        <button className="topbar-project" onClick={() => setMenuOpen(!menuOpen)} title="项目菜单（切换/管理）">
          {project?.name ?? ''} ▾
        </button>
        {menuOpen && project && (
          <div className="ctx-menu topbar-menu">
            <button className="ctx-menu-item" onClick={() => void leaveToProjects()}>返回项目列表</button>
            <button className="ctx-menu-item" onClick={() => void openOther()}>打开其他项目…</button>
            <button className="ctx-menu-item" onClick={showInFolder}>在资源管理器中显示</button>
            <button className="ctx-menu-item" onClick={() => void rename()}>重命名项目…</button>
            {projects.length > 1 && (
              <>
                <div className="session-group-title">最近项目</div>
                {projects.map((p) => (
                  <button key={p.dir} className="ctx-menu-item" onClick={() => void switchTo(p.dir)}>
                    {p.name}
                    {p.dir === project.dir ? '（当前）' : ''}
                  </button>
                ))}
              </>
            )}
          </div>
        )}
      </div>
      <div className="topbar-tabs">
        {MODULES.map((m) => (
          <button
            key={m.id}
            className={module === m.id ? 'tab active' : 'tab'}
            onClick={() => store.setModule(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>
      {/* §6.12 一键折叠：讨论模块左右栏 / 写作模块场景树 / 专注写作（三栏全折） */}
      {module === 'discussion' && (
        <>
          <button
            className={`tiny-btn topbar-toggle${leftCollapsed ? ' active' : ''}`}
            onClick={() => store.toggleLeftPanel()}
            title={leftCollapsed ? '展开左栏（大纲/设定/会话）' : '折叠左栏（大纲/设定/会话）'}
          >
            左栏
          </button>
          <button
            className={`tiny-btn topbar-toggle${rightCollapsed ? ' active' : ''}`}
            onClick={() => store.toggleRightPanel()}
            title={rightCollapsed ? '展开右栏（对象详情）' : '折叠右栏（对象详情）'}
          >
            右栏
          </button>
        </>
      )}
      {module === 'writing' && (
        <button
          className={`tiny-btn topbar-toggle${scenesCollapsed ? ' active' : ''}`}
          onClick={() => store.toggleScenes()}
          title={scenesCollapsed ? '展开场景树' : '折叠场景树'}
        >
          场景
        </button>
      )}
      <button
        className={`tiny-btn topbar-toggle${leftCollapsed && rightCollapsed && scenesCollapsed ? ' active' : ''}`}
        onClick={() => store.toggleFocus()}
        title="专注写作：一键折叠/展开全部侧栏"
      >
        专注
      </button>
      <span className="spacer" />
      <ThemePicker />
      <button className="tiny-btn" onClick={() => setSettingsOpen(true)} title="设置（弹窗）">⚙</button>
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

function App(): React.ReactElement {
  const project = useStore((s) => s.project);
  const toast = useStore((s) => s.toast);
  const module = useStore((s) => s.module);
  const leftCollapsed = useStore((s) => s.leftCollapsed);
  const rightCollapsed = useStore((s) => s.rightCollapsed);
  const scenesCollapsed = useStore((s) => s.scenesCollapsed);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [cols, setCols] = React.useState({ left: 250, right: 340 });
  const colsRef = React.useRef(cols);
  colsRef.current = cols;

  useEffect(() => {
    setCols({ left: loadWidth('sw2:col-left', 250), right: loadWidth('sw2:col-right', 340) });
    store.initCollapsed();
  }, []);

  // 主题校正：project.settings.theme 为权威值（settings.json），
  // 打开项目/刷新状态时与 DOM 同步（首帧镜像由 entry.tsx 处理）。
  const lastAppliedTheme = React.useRef<string | null>(null);
  useEffect(() => {
    if (project && lastAppliedTheme.current !== project.settings.theme) {
      lastAppliedTheme.current = project.settings.theme;
      applyTheme(project.settings.theme);
    }
  }, [project]);

  // 订阅主进程 run 流式事件
  useEffect(() => {
    const off = getApi().run.onEvent((event) => store.applyRunEvent(event));
    return off;
  }, []);

  // 未保存保护（ux-review §6.8）：关窗前若有脏编辑器 → 浏览器式确认
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent): void => {
      if (store.hasDirtyEditors()) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  // 全局快捷键（§6.11）：Ctrl+K 搜索；Alt+1/2 模块切换
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === '1' || e.key === '2')) {
        e.preventDefault();
        store.setModule(e.key === '1' ? 'discussion' : 'writing');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const startDrag = (side: 'left' | 'right', e: React.MouseEvent): void => {
    e.preventDefault();
    const startX = e.clientX;
    const start = colsRef.current;
    const move = (ev: MouseEvent): void => {
      const dx = ev.clientX - startX;
      if (side === 'left') {
        setCols({ ...colsRef.current, left: clamp(start.left + dx, MIN_LEFT, MAX_LEFT) });
      } else {
        setCols({ ...colsRef.current, right: clamp(start.right - dx, MIN_RIGHT, MAX_RIGHT) });
      }
    };
    const up = (): void => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      localStorage.setItem('sw2:col-left', String(colsRef.current.left));
      localStorage.setItem('sw2:col-right', String(colsRef.current.right));
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <ErrorBoundary>
      <div className="app">
        {!project ? (
          <ProjectScreen />
        ) : (
          <div className="app-shell">
            <TopBar />
            <div className="app-modules">
              {/* 讨论模块：三栏（大纲|设定|会话 + 对话 + 右栏对象详情） */}
              <div
                className="discussion-module"
                style={{ display: module === 'discussion' ? undefined : 'none' }}
              >
                <div
                  className="layout"
                  style={{ '--col-left': `${leftCollapsed ? 0 : cols.left}px`, '--col-right': `${rightCollapsed ? 0 : cols.right}px` } as React.CSSProperties}
                >
                  {!leftCollapsed && <div className="splitter" style={{ left: `calc(${cols.left}px - 3px)` }} onMouseDown={(e) => startDrag('left', e)} />}
                  <LeftPanel collapsed={leftCollapsed} />
                  <ConversationPane />
                  <Workspace collapsed={rightCollapsed} />
                  {!rightCollapsed && (
                    <div
                      className="splitter"
                      style={{ left: `calc(100% - ${cols.right}px - 3px)` }}
                      onMouseDown={(e) => startDrag('right', e)}
                    />
                  )}
                </div>
              </div>
              {/* 正文模块：场景树 + 可见视图 + 正文工作区 */}
              <div
                className="writing-module-host"
                style={{ display: module === 'writing' ? undefined : 'none' }}
              >
                <WritingModule scenesCollapsed={scenesCollapsed} />
              </div>
            </div>
          </div>
        )}
        {searchOpen && <GlobalSearchDialog onClose={() => setSearchOpen(false)} />}
        {toast && <div className={`toast toast-${toast.kind}`}>{toast.message}</div>}
        <DialogHost />
      </div>
    </ErrorBoundary>
  );
}

export { App, ProjectScreen };
