import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type MutableRefObject } from "react";
import MarkdownIt from "markdown-it";
import {
  BookOpen,
  Braces,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Code2,
  ExternalLink,
  File,
  FileCog,
  FileText,
  FlaskConical,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  ListCollapse,
  MessageSquare,
  Package,
  ScrollText,
  Settings as SettingsIcon,
  ShieldCheck,
  Terminal,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { fetchFile, fetchHttpDeliveryStatus, fetchRepos, fetchTree, imageFileUrl, openRepository, pdfFileUrl, startHttpDelivery, stopHttpDelivery } from "./api";
import type { AIChatSessionState, DiffStatus, FileResponse, HttpDeliveryItemStatus, HttpDeliveryStatus, RepoListItem, RepoSyncStatus, TreeNode, TreeSnapshot } from "./types";
import { AIChatPanel } from "./AIChatPanel";
import { SettingsView } from "./SettingsView";
import { activeAIModelBehavior, defaultAISettings, defaultBasicSettings, loadBasicSettings, normalizeReaderFontScale, persistBasicSettings, type AISettingsState, type BasicSettings, type ReaderFontScale } from "./settingsState";
import { injectMarkdownCodeToolbarButtons, installCodeBlockRule } from "../shared/markdownCodeBlocks";
import { installTableScrollRule } from "../shared/markdownTableScroll";
import { installTaskListRule } from "../shared/markdownTaskLists";

type TreeCache = TreeSnapshot;
type ViewMode = "rendered" | "source" | "raw";
type AppView = "viewer" | "settings";
type SettingsCategory = "basic" | "repositories" | "aiChat";
type RightPanelMode = "outline" | "memo" | "aiChat";
type MemoMode = "raw" | "render";
type CopyState = "idle" | "copied" | "error";
type RepoSyncViewStatus = RepoSyncStatus | { state: "syncing"; message: string; fetched: false };

type FileTab = {
  id: string;
  path: string;
  title: string;
  file: FileResponse | null;
  loading: boolean;
  error: string;
  viewMode: ViewMode;
  isPreview: boolean;
  isPinned: boolean;
  openedAt: number;
};

type TabsByRepo = Record<string, FileTab[]>;
type ActiveTabByRepo = Record<string, string>;
type OpenFileOptions = { keep?: boolean };
type TabContextMenu = { tabId: string; x: number; y: number } | null;
type PathContextMenu = { node: TreeNode; relativePath: string; absolutePath: string; x: number; y: number } | null;
type FileTreeRow = {
  node: TreeNode;
  depth: number;
  ancestors: FileTreeStickyItem[];
  isExpanded: boolean;
  isSelected: boolean;
  iconKind: TreeIconKind;
};
type FileTreeStickyItem = {
  path: string;
  name: string;
  depth: number;
  iconKind: TreeIconKind;
};

const MAX_FILE_TABS = 5;
const HTTP_DELIVERY_MAX_SESSIONS = 5;
const TREE_ROW_HEIGHT_PX = 31;
const HTML_VIEWER_BASE_FONT_SIZE_PX = 16;
const defaultAIChatSession: AIChatSessionState = {
  messages: [],
  draft: "",
  pending: false,
  error: "",
  lastRequest: "",
  attachments: [],
};
const memoMarkdown = new MarkdownIt({ html: false, linkify: true });
installTableScrollRule(memoMarkdown);
installCodeBlockRule(memoMarkdown);
installTaskListRule(memoMarkdown);

export function App() {
  const [appView, setAppView] = useState<AppView>("viewer");
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>("basic");
  const [basicSettings, setBasicSettings] = useState<BasicSettings>(defaultBasicSettings);
  const [basicSaveError, setBasicSaveError] = useState("");
  const [aiSettings, setAISettings] = useState<AISettingsState>(defaultAISettings);
  const [repos, setRepos] = useState<RepoListItem[]>([]);
  const [activeRepoId, setActiveRepoId] = useState("");
  const [treeCache, setTreeCache] = useState<TreeCache>({});
  const [repoSyncByRepo, setRepoSyncByRepo] = useState<Record<string, RepoSyncViewStatus>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const [tabsByRepo, setTabsByRepo] = useState<TabsByRepo>({});
  const [activeTabByRepo, setActiveTabByRepo] = useState<ActiveTabByRepo>({});
  const [rightPanelMode, setRightPanelMode] = useState<RightPanelMode>("outline");
  const [aiChatSession, setAIChatSession] = useState<AIChatSessionState>(defaultAIChatSession);
  const [memoText, setMemoText] = useState("");
  const [memoMode, setMemoMode] = useState<MemoMode>("raw");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tabNotice, setTabNotice] = useState("");
  const [fileCopyState, setFileCopyState] = useState<CopyState>("idle");
  const [pathMenu, setPathMenu] = useState<PathContextMenu>(null);
  const [httpDeliveryStatus, setHttpDeliveryStatus] = useState<HttpDeliveryStatus>({ state: "idle", items: [] });
  const [httpDeliveryError, setHttpDeliveryError] = useState("");
  const [httpDeliveryPendingPath, setHttpDeliveryPendingPath] = useState("");
  const [httpDeliveryStoppingIds, setHttpDeliveryStoppingIds] = useState<Set<string>>(() => new Set());
  const [treeScrollTop, setTreeScrollTop] = useState(0);
  const [treeHorizontalScrollLeft, setTreeHorizontalScrollLeft] = useState(0);
  const treeSectionRef = useRef<HTMLDivElement | null>(null);
  const treeHorizontalScrollRef = useRef<HTMLDivElement | null>(null);
  const pathMenuRef = useRef<HTMLDivElement | null>(null);
  const viewerBodyRef = useRef<HTMLDivElement | null>(null);
  const repoLoadTokenRef = useRef(0);

  useEffect(() => {
    const loaded = loadBasicSettings();
    setBasicSettings(loaded.settings);
    setBasicSaveError(loaded.error);
  }, []);

  const activeRepo = useMemo(() => repos.find((repo) => repo.id === activeRepoId) || null, [activeRepoId, repos]);
  const activeRepoSyncStatus = activeRepoId ? repoSyncByRepo[activeRepoId] || null : null;
  const visibleRepoSyncStatus = activeRepoSyncStatus && shouldShowRepoSyncStatus(activeRepoSyncStatus) ? activeRepoSyncStatus : null;
  const repoTabs = tabsByRepo[activeRepoId] || [];
  const orderedTabs = useMemo(() => orderTabs(repoTabs), [repoTabs]);
  const activeTabId = activeTabByRepo[activeRepoId] || "";
  const activeTab = repoTabs.find((tab) => tab.id === activeTabId) || repoTabs[0] || null;
  const activeFile = activeTab?.file || null;
  const selectedPath = activeTab?.path || "";
  const outline = useMemo(() => extractOutline(activeFile), [activeFile]);
  const canCopyActiveFile = Boolean(activeFile && isCopyableFileKind(activeFile.kind));
  const fileCopyLabel =
    fileCopyState === "copied" ? "File content copied" : fileCopyState === "error" ? "File content copy failed" : "Copy file content";
  const currentHttpDeliveryItem = useMemo(
    () => httpDeliveryStatus.items.find((item) => item.repoId === activeRepoId && item.path === selectedPath) || null,
    [activeRepoId, httpDeliveryStatus.items, selectedPath],
  );
  const canDeliverActiveFile = Boolean(activeFile && selectedPath && activeFile.fileInfo.viewerStatus !== "deleted");
  const httpDeliveryAtCapacity = httpDeliveryStatus.items.length >= HTTP_DELIVERY_MAX_SESSIONS;
  const httpDeliveryButtonDisabled = Boolean(httpDeliveryPendingPath || (!currentHttpDeliveryItem && httpDeliveryAtCapacity));
  const httpDeliveryButtonLabel = currentHttpDeliveryItem
    ? "HTTP Delivery active"
    : httpDeliveryAtCapacity
      ? `HTTP Delivery supports up to ${HTTP_DELIVERY_MAX_SESSIONS} files`
      : "Start HTTP Delivery";
  const readerTypographyStyle = useMemo(() => buildReaderTypographyStyle(basicSettings.readerFontScale), [basicSettings.readerFontScale]);
  const aiModelBehavior = useMemo(() => activeAIModelBehavior(aiSettings), [aiSettings]);

  const updateBasicSettings = useCallback((settings: BasicSettings) => {
    setBasicSettings(settings);
    setBasicSaveError(persistBasicSettings(settings));
  }, []);

  const updateAIChatSession = useCallback((updater: (session: AIChatSessionState) => AIChatSessionState) => {
    setAIChatSession((current) => updater(current));
  }, []);

  const openSettings = useCallback((category: SettingsCategory = "basic") => {
    setSettingsCategory(category);
    setAppView("settings");
  }, []);

  const loadTree = useCallback(async (repoId: string, path: string) => {
    const nodes = await fetchTree(repoId, path);
    setTreeCache((current) => ({ ...current, [path]: nodes }));
    return nodes;
  }, []);

  const refreshFileTab = useCallback(async (repoId: string, tabId: string, path: string) => {
    setTabsByRepo((current) => ({
      ...current,
      [repoId]: (current[repoId] || []).map((tab) => (tab.id === tabId ? { ...tab, loading: true, error: "" } : tab)),
    }));
    try {
      const nextFile = await fetchFile(repoId, path);
      setTabsByRepo((current) => ({
        ...current,
        [repoId]: (current[repoId] || []).map((tab) =>
          tab.id === tabId
            ? {
                ...tab,
                title: nextFile.name,
                file: nextFile,
                loading: false,
                error: "",
                viewMode: normalizeViewMode(nextFile, tab.viewMode),
              }
            : tab,
        ),
      }));
    } catch (nextError) {
      setTabsByRepo((current) => ({
        ...current,
        [repoId]: (current[repoId] || []).map((tab) =>
          tab.id === tabId
            ? {
                ...tab,
                file: null,
                loading: false,
                error: nextError instanceof Error ? nextError.message : String(nextError),
              }
            : tab,
        ),
      }));
    }
  }, []);

  const openFile = useCallback(
    async (repoId: string, path: string, options: OpenFileOptions = {}) => {
      if (!path) return;
      const tabId = createTabId(repoId, path);
      const currentTabs = tabsByRepo[repoId] || [];
      const existingTab = currentTabs.find((tab) => tab.id === tabId);
      setError("");
      setTabNotice("");

      if (existingTab) {
        setActiveTabByRepo((current) => ({ ...current, [repoId]: existingTab.id }));
        await refreshFileTab(repoId, existingTab.id, path);
        return;
      }

      const replaceablePreview = currentTabs.find((tab) => tab.isPreview && !tab.isPinned);
      if (!replaceablePreview && currentTabs.length >= MAX_FILE_TABS) {
        setTabNotice("Maximum of five file tabs reached. Close or unpin a tab before opening another file.");
        return;
      }

      const placeholder = createPlaceholderTab(repoId, path, { keep: options.keep });
      const nextTabs = replaceablePreview ? currentTabs.map((tab) => (tab.id === replaceablePreview.id ? placeholder : tab)) : [...currentTabs, placeholder];
      setTabsByRepo((current) => ({ ...current, [repoId]: nextTabs }));
      setActiveTabByRepo((current) => ({ ...current, [repoId]: tabId }));

      await refreshFileTab(repoId, tabId, path);
    },
    [refreshFileTab, tabsByRepo],
  );

  const selectRepo = useCallback(
    async (repo: RepoListItem) => {
      const loadToken = repoLoadTokenRef.current + 1;
      repoLoadTokenRef.current = loadToken;
      setActiveRepoId(repo.id);
      setTreeCache({});
      setExpanded(new Set([""]));
      setError("");
      setTabNotice("");
      setRepoSyncByRepo((current) => ({
        ...current,
        [repo.id]: { state: "syncing", message: "Loading repository metadata...", fetched: false },
      }));
      try {
        const opened = await openRepository(repo.id);
        if (repoLoadTokenRef.current !== loadToken || opened.repoId !== repo.id) return;
        setTreeCache(opened.tree);
        setRepoSyncByRepo((current) => ({ ...current, [repo.id]: opened.sync }));
        const existingTabs = tabsByRepo[repo.id] || [];
        if (existingTabs.length) {
          const nextActiveTabId = activeTabByRepo[repo.id] || existingTabs[0].id;
          const nextActiveTab = existingTabs.find((tab) => tab.id === nextActiveTabId) || existingTabs[0];
          setActiveTabByRepo((current) => ({ ...current, [repo.id]: nextActiveTab.id }));
          await refreshFileTab(repo.id, nextActiveTab.id, nextActiveTab.path);
        } else if (repo.defaultPath) {
          await openFile(repo.id, repo.defaultPath);
        }
      } catch (nextError) {
        if (repoLoadTokenRef.current !== loadToken) return;
        const message = nextError instanceof Error ? nextError.message : String(nextError);
        setRepoSyncByRepo((current) => ({
          ...current,
          [repo.id]: { state: "warning", message, fetched: false },
        }));
        setError(message);
      }
    },
    [activeTabByRepo, openFile, refreshFileTab, tabsByRepo],
  );

  const reloadRepositoriesAfterSettingsSave = useCallback(async () => {
    const nextRepos = await fetchRepos();
    setRepos(nextRepos);
    const stillActive = nextRepos.some((repo) => repo.id === activeRepoId);
    if (!stillActive && nextRepos[0]) {
      await selectRepo(nextRepos[0]);
    }
  }, [activeRepoId, selectRepo]);

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      setLoading(true);
      setError("");
      try {
        const nextRepos = await fetchRepos();
        if (cancelled) return;
        setRepos(nextRepos);
        const firstRepo = nextRepos[0];
        if (firstRepo) await selectRepo(firstRepo);
      } catch (nextError) {
        if (!cancelled) setError(nextError instanceof Error ? nextError.message : String(nextError));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void boot();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void refreshHttpDeliveryStatus();
  }, []);

  useEffect(() => {
    if (!pathMenu) return undefined;
    function closeMenu(event: MouseEvent) {
      const target = event.target;
      if (target instanceof Node && pathMenuRef.current?.contains(target)) return;
      setPathMenu(null);
    }
    function closeMenuOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setPathMenu(null);
    }
    window.addEventListener("click", closeMenu);
    window.addEventListener("keydown", closeMenuOnEscape);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("keydown", closeMenuOnEscape);
    };
  }, [pathMenu]);

  useEffect(() => {
    setFileCopyState("idle");
  }, [activeFile?.path]);

  useEffect(() => {
    if (fileCopyState === "idle") return;
    const timeoutId = window.setTimeout(() => setFileCopyState("idle"), 1800);
    return () => window.clearTimeout(timeoutId);
  }, [fileCopyState]);

  async function toggleDirectory(path: string) {
    if (!activeRepoId) return;
    const nextExpanded = new Set(expanded);
    if (nextExpanded.has(path)) {
      nextExpanded.delete(path);
      setExpanded(nextExpanded);
      return;
    }
    nextExpanded.add(path);
    setExpanded(nextExpanded);
    if (!treeCache[path]) {
      try {
        await loadTree(activeRepoId, path);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      }
    }
  }

  function collapseAllFolders() {
    setExpanded(new Set([""]));
  }

  function activateTab(tabId: string) {
    if (!activeRepoId) return;
    setActiveTabByRepo((current) => ({ ...current, [activeRepoId]: tabId }));
    setTabNotice("");
  }

  function toggleFixedTab(tabId: string) {
    if (!activeRepoId) return;
    setTabsByRepo((current) => ({
      ...current,
      [activeRepoId]: (current[activeRepoId] || []).map((tab) =>
        tab.id === tabId ? { ...tab, isPreview: !tab.isPreview, isPinned: tab.isPreview ? tab.isPinned : false } : tab,
      ),
    }));
  }

  function togglePin(tabId: string) {
    if (!activeRepoId) return;
    setTabsByRepo((current) => ({
      ...current,
      [activeRepoId]: (current[activeRepoId] || []).map((tab) =>
        tab.id === tabId ? { ...tab, isPinned: !tab.isPinned, isPreview: false } : tab,
      ),
    }));
  }

  function closeTab(tabId: string) {
    if (!activeRepoId) return;
    const remainingTabs = repoTabs.filter((tab) => tab.id !== tabId);
    setTabsByRepo((current) => ({ ...current, [activeRepoId]: remainingTabs }));
    if (activeTabId === tabId) {
      const nextActive = orderTabs(remainingTabs)[0]?.id || "";
      setActiveTabByRepo((current) => ({ ...current, [activeRepoId]: nextActive }));
    }
    setTabNotice("");
  }

  function changeViewMode(mode: ViewMode) {
    if (!activeRepoId || !activeTab) return;
    setTabsByRepo((current) => ({
      ...current,
      [activeRepoId]: (current[activeRepoId] || []).map((tab) => (tab.id === activeTab.id ? { ...tab, viewMode: mode } : tab)),
    }));
  }

  function scrollToHeading(headingId: string) {
    const target = Array.from(viewerBodyRef.current?.querySelectorAll<HTMLElement>("[data-outline-id]") || []).find(
      (element) => element.dataset.outlineId === headingId,
    );
    target?.scrollIntoView({ block: "start" });
  }

  async function revealTabInTree(tabId: string) {
    if (!activeRepoId) return;
    const tab = (tabsByRepo[activeRepoId] || []).find((candidate) => candidate.id === tabId);
    if (!tab || tab.id !== activeTabId || !isRevealableFilePath(tab.path)) return;
    const ancestorPaths = fileTreeAncestorPaths(tab.path);
    try {
      await Promise.all(
        ["", ...ancestorPaths].map((path) => {
          if (treeCache[path]) return Promise.resolve(treeCache[path]);
          return loadTree(activeRepoId, path);
        }),
      );
      setExpanded((current) => {
        const next = new Set(current);
        next.add("");
        ancestorPaths.forEach((path) => next.add(path));
        return next;
      });
      window.setTimeout(() => {
        const target = Array.from(treeSectionRef.current?.querySelectorAll<HTMLElement>("[data-tree-path]") || []).find(
          (element) => element.dataset.treePath === tab.path,
        );
        target?.scrollIntoView({ block: "nearest" });
        target?.focus({ preventScroll: true });
      }, 0);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }

  async function copyActiveFileContent() {
    if (!activeFile || !isCopyableFileKind(activeFile.kind)) return;
    try {
      await writeClipboardText(activeFile.content);
      setFileCopyState("copied");
    } catch {
      setFileCopyState("error");
    }
  }

  async function refreshHttpDeliveryStatus() {
    try {
      setHttpDeliveryStatus(await fetchHttpDeliveryStatus());
      setHttpDeliveryError("");
    } catch (nextError) {
      setHttpDeliveryError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }

  function startDeliveryWithNewTab(path: string) {
    const repoId = activeRepoId;
    const deliveryTab = repoId && path ? openHttpDeliveryBlankTab({ repoId, path }) : null;
    void startDeliveryForPath(path, deliveryTab);
  }

  async function startDeliveryForPath(path: string, deliveryTab: Window | null = null) {
    if (!activeRepoId || !path) {
      closePendingHttpDeliveryTab(deliveryTab);
      return;
    }
    const repoId = activeRepoId;
    setHttpDeliveryPendingPath(path);
    setHttpDeliveryError("");
    try {
      const status = await startHttpDelivery(repoId, path);
      setHttpDeliveryStatus(status);
      const item = findHttpDeliveryItem(status, repoId, path);
      if (item) navigateHttpDeliveryTab(deliveryTab, item.url);
      else closePendingHttpDeliveryTab(deliveryTab);
    } catch (nextError) {
      closePendingHttpDeliveryTab(deliveryTab);
      setHttpDeliveryError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setHttpDeliveryPendingPath("");
    }
  }

  async function stopDeliveryItem(deliveryId: string) {
    setHttpDeliveryStoppingIds((current) => new Set(current).add(deliveryId));
    setHttpDeliveryError("");
    try {
      setHttpDeliveryStatus(await stopHttpDelivery(deliveryId));
    } catch (nextError) {
      setHttpDeliveryError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setHttpDeliveryStoppingIds((current) => {
        const next = new Set(current);
        next.delete(deliveryId);
        return next;
      });
    }
  }

  function openPathMenu(node: TreeNode, event: ReactMouseEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    setPathMenu({
      node,
      relativePath: node.path,
      absolutePath: joinRepoPath(activeRepo?.root || "", node.path),
      x: Math.max(8, event.clientX),
      y: Math.max(8, event.clientY),
    });
  }

  async function copyPathFromMenu(path: string) {
    try {
      await writeClipboardText(path);
    } catch {
      // Clipboard permission can be denied; closing the menu keeps the local UI stable.
    } finally {
      setPathMenu(null);
    }
  }

  function openPathMenuFileInNewTab() {
    if (!activeRepoId || !pathMenu || pathMenu.node.type !== "file") return;
    void openFile(activeRepoId, pathMenu.relativePath, { keep: true });
    setPathMenu(null);
  }

  function jumpToTreePath(path: string) {
    const candidates = Array.from(treeSectionRef.current?.querySelectorAll<HTMLElement>(`.tree-row[data-tree-path="${cssEscape(path)}"]`) || []);
    const target = candidates.find((element) => !element.classList.contains("tree-sticky-row"));
    target?.scrollIntoView({ block: "start" });
    target?.focus({ preventScroll: true });
  }

  if (appView === "settings") {
    return (
      <SettingsView
        basicSettings={basicSettings}
        aiSettings={aiSettings}
        initialCategory={settingsCategory}
        basicSaveError={basicSaveError}
        onBack={() => setAppView("viewer")}
        onBasicSettingsChange={updateBasicSettings}
        onAISettingsChange={setAISettings}
        onRepositoriesChanged={reloadRepositoriesAfterSettingsSave}
      />
    );
  }

  const appShellClass = `app-shell layout-${basicSettings.layout} color-${basicSettings.colorMode}`;

  return (
    <main className={appShellClass} data-color-mode={basicSettings.colorMode}>
      <aside className="sidebar" aria-label="Repositories and files">
        <button
          type="button"
          className="icon-button tree-action-button sidebar-tree-action"
          aria-label="Collapse all folders"
          title="Collapse all folders"
          onClick={collapseAllFolders}
        >
          <ListCollapse aria-hidden="true" focusable="false" strokeWidth={1.8} />
        </button>
        <header className="sidebar-header">
          <h1>Reader-Wiki</h1>
          <p>Local read-only repository viewer</p>
        </header>
        {loading ? <p className="state-text">Loading repositories...</p> : null}
        <label className="repo-picker-label" htmlFor="repo-picker">
          Repository
        </label>
        <select
          id="repo-picker"
          className="repo-picker"
          value={activeRepoId}
          onChange={(event) => {
            const repo = repos.find((candidate) => candidate.id === event.target.value);
            if (repo) void selectRepo(repo);
          }}
        >
          {repos.map((repo) => (
            <option key={repo.id} value={repo.id}>
              {repo.label}
            </option>
          ))}
        </select>
        {activeRepo ? <p className="repo-root" title={activeRepo.root}>{activeRepo.root}</p> : null}
        {visibleRepoSyncStatus ? (
          <p className={`repo-sync-status ${visibleRepoSyncStatus.state}`} aria-live="polite">
            {visibleRepoSyncStatus.message}
          </p>
        ) : null}
        <HttpDeliveryPanel status={httpDeliveryStatus} stoppingItemIds={httpDeliveryStoppingIds} error={httpDeliveryError} onStop={(deliveryId) => void stopDeliveryItem(deliveryId)} />
        {repos.length === 0 && !loading ? <p className="state-text">No repositories are configured.</p> : null}
        {activeRepoId ? (
          <div className="tree-section" ref={treeSectionRef} onScroll={(event) => setTreeScrollTop(event.currentTarget.scrollTop)}>
            <TreeView
              nodes={treeCache[""] || []}
              treeCache={treeCache}
              expanded={expanded}
              selectedPath={selectedPath}
              treeScrollTop={treeScrollTop}
              horizontalScrollLeft={treeHorizontalScrollLeft}
              horizontalScrollRef={treeHorizontalScrollRef}
              onToggleDirectory={(path) => void toggleDirectory(path)}
              onOpenFile={(path) => void openFile(activeRepoId, path)}
              onOpenPathMenu={openPathMenu}
              onStickyJump={jumpToTreePath}
              onHorizontalScroll={(scrollLeft) => setTreeHorizontalScrollLeft(scrollLeft)}
            />
            {pathMenu ? (
              <div
                className="path-context-menu"
                ref={pathMenuRef}
                role="menu"
                aria-label={`${pathMenu.relativePath} path actions`}
                style={{ left: pathMenu.x, top: pathMenu.y }}
                onClick={(event) => event.stopPropagation()}
              >
                <button type="button" role="menuitem" onClick={() => void copyPathFromMenu(pathMenu.absolutePath)}>
                  Copy Absolute Path
                </button>
                <button type="button" role="menuitem" onClick={() => void copyPathFromMenu(pathMenu.relativePath)}>
                  Copy Relative Path
                </button>
                {pathMenu.node.type === "file" ? (
                  <button type="button" role="menuitem" onClick={openPathMenuFileInNewTab}>
                    Open in New Tab
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="sidebar-settings-zone" aria-label="Reader-Wiki settings">
          <button type="button" className="icon-button sidebar-settings-button" aria-label="Open Settings" title="Open Settings" onClick={() => openSettings("basic")}>
            <SettingsIcon aria-hidden="true" focusable="false" />
          </button>
        </div>
      </aside>

      <section className="workspace" aria-label="Reader workspace">
        <header className="viewer-header">
          <div>
            <h2>{selectedPath || "Select a file"}</h2>
          </div>
          <ViewModeControl file={activeFile} mode={activeTab?.viewMode || "rendered"} onChange={changeViewMode} />
        </header>
        <FileTabBar
          tabs={orderedTabs}
          activeTabId={activeTab?.id || ""}
          notice={tabNotice}
          onActivate={activateTab}
          onToggleFixed={toggleFixedTab}
          onTogglePin={togglePin}
          onClose={closeTab}
          onReveal={(tabId) => void revealTabInTree(tabId)}
          onHttpDelivery={(tabId) => {
            const tab = repoTabs.find((candidate) => candidate.id === tabId);
            if (tab) startDeliveryWithNewTab(tab.path);
          }}
        />
        {error ? <p className="state-text error">{error}</p> : null}
        <div className="viewer-body" ref={viewerBodyRef} style={readerTypographyStyle}>
          {canDeliverActiveFile || canCopyActiveFile ? (
            <div className="viewer-copy-actions">
              {canDeliverActiveFile ? (
                <button
                  type="button"
                  className={`viewer-copy-button http-delivery-open-button${currentHttpDeliveryItem ? " active" : ""}`}
                  aria-label={httpDeliveryButtonLabel}
                  title={currentHttpDeliveryItem?.url || httpDeliveryButtonLabel}
                  disabled={httpDeliveryButtonDisabled}
                  onClick={() => startDeliveryWithNewTab(selectedPath)}
                >
                  <ExternalLink aria-hidden="true" focusable="false" strokeWidth={1.9} />
                </button>
              ) : null}
              {canCopyActiveFile ? (
                <button type="button" className={`viewer-copy-button ${fileCopyState}`} aria-label={fileCopyLabel} title={fileCopyLabel} onClick={() => void copyActiveFileContent()}>
                  {fileCopyState === "copied" ? <CheckIcon /> : <CopyIcon />}
                </button>
              ) : null}
            </div>
          ) : null}
          <FileViewer tab={activeTab} outline={outline} readerFontScale={basicSettings.readerFontScale} colorMode={basicSettings.colorMode} />
        </div>
      </section>

      <RightPanel
        mode={rightPanelMode}
        onModeChange={setRightPanelMode}
        file={activeFile}
        outline={outline}
        onHeadingSelect={scrollToHeading}
        memoText={memoText}
        memoMode={memoMode}
        onMemoTextChange={setMemoText}
        onMemoModeChange={setMemoMode}
        aiSettings={aiSettings}
        aiChatSession={aiChatSession}
        onAIChatSessionChange={updateAIChatSession}
        aiModelBehavior={aiModelBehavior}
        activeRepoId={activeRepoId}
        onOpenSettings={() => openSettings("aiChat")}
      />
    </main>
  );
}

function TreeView({
  nodes,
  treeCache,
  expanded,
  selectedPath,
  treeScrollTop,
  horizontalScrollLeft,
  horizontalScrollRef,
  onToggleDirectory,
  onOpenFile,
  onOpenPathMenu,
  onStickyJump,
  onHorizontalScroll,
}: {
  nodes: TreeNode[];
  treeCache: TreeCache;
  expanded: Set<string>;
  selectedPath: string;
  treeScrollTop: number;
  horizontalScrollLeft: number;
  horizontalScrollRef: MutableRefObject<HTMLDivElement | null>;
  onToggleDirectory: (path: string) => void;
  onOpenFile: (path: string) => void;
  onOpenPathMenu: (node: TreeNode, event: ReactMouseEvent<HTMLElement>) => void;
  onStickyJump: (path: string) => void;
  onHorizontalScroll: (scrollLeft: number) => void;
}) {
  const rows = collectFileTreeRows(nodes, treeCache, expanded, selectedPath);
  const stickyItems = buildFileTreeStickyItems(rows, treeScrollTop);
  return (
    <div className="tree-layout">
      {stickyItems.length ? <FileTreeStickyAncestors items={stickyItems} horizontalScrollLeft={horizontalScrollLeft} onJump={onStickyJump} /> : null}
      <div className="tree-list-scrollport" ref={horizontalScrollRef} onScroll={(event) => onHorizontalScroll(event.currentTarget.scrollLeft)}>
        <ul className="tree tree-list-column">
          {rows.map((row, rowIndex) => {
            const { node, depth, isExpanded, isSelected, iconKind } = row;
            return (
              <li key={node.path}>
                <button
                  type="button"
                  className={`tree-row ${node.type}${isSelected ? " selected" : ""}`}
                  data-icon-kind={iconKind}
                  data-tree-path={node.path}
                  data-tree-depth={depth}
                  data-tree-index={rowIndex}
                  style={treeRowStyle(depth)}
                  onClick={() => (node.type === "directory" ? onToggleDirectory(node.path) : onOpenFile(node.path))}
                  onContextMenu={(event) => onOpenPathMenu(node, event)}
                >
                  <span className={`tree-diff-marker${node.gitStatus ? ` ${node.gitStatus}` : ""}`} data-git-status={node.gitStatus || undefined} aria-hidden="true" />
                  <span className="tree-chevron" aria-hidden="true">
                    {node.type === "directory" ? isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} /> : null}
                  </span>
                  <TreeIcon kind={iconKind} className="tree-icon" />
                  <span className="tree-name">{node.name}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function collectFileTreeRows(nodes: TreeNode[], treeCache: TreeCache, expanded: Set<string>, selectedPath: string): FileTreeRow[] {
  const rows: FileTreeRow[] = [];
  function visit(nextNodes: TreeNode[], depth: number, ancestors: FileTreeStickyItem[]) {
    nextNodes.forEach((node) => {
      const isExpanded = expanded.has(node.path);
      const iconKind = getTreeIconKind(node, isExpanded);
      rows.push({
        node,
        depth,
        ancestors,
        isExpanded,
        isSelected: selectedPath === node.path,
        iconKind,
      });
      if (node.type !== "directory" || !isExpanded) return;
      visit(treeCache[node.path] || [], depth + 1, [...ancestors, { path: node.path, name: node.name, depth, iconKind }]);
    });
  }
  visit(nodes, 0, []);
  return rows;
}

function buildFileTreeStickyItems(rows: FileTreeRow[], treeScrollTop: number): FileTreeStickyItem[] {
  const activeRowIndex = rows.length ? Math.min(rows.length - 1, Math.max(0, Math.floor(treeScrollTop / TREE_ROW_HEIGHT_PX))) : 0;
  return rows[activeRowIndex]?.ancestors || [];
}

function FileTreeStickyAncestors({ items, horizontalScrollLeft, onJump }: {
  items: FileTreeStickyItem[];
  horizontalScrollLeft: number;
  onJump: (path: string) => void;
}) {
  return (
    <div className="tree-sticky-layer" aria-label="Current file tree ancestors">
      <div className="tree-sticky-scrollport">
        <div className="tree-sticky-column" style={{ "--tree-scroll-left": `${horizontalScrollLeft}px` } as CSSProperties}>
          {items.map((item) => (
            <button
              key={item.path}
              type="button"
              className="tree-row tree-sticky-row directory"
              data-tree-path={item.path}
              style={treeRowStyle(item.depth)}
              aria-label={`Jump to ${item.name}`}
              title={`Jump to ${item.name}`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onJump(item.path);
              }}
            >
              <span className="tree-diff-marker" aria-hidden="true" />
              <span className="tree-chevron" aria-hidden="true">
                <ChevronDown size={11} />
              </span>
              <TreeIcon kind={item.iconKind} className="tree-icon" />
              <span className="tree-name">{item.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function treeRowStyle(depth: number): CSSProperties {
  const guideWidth = depth * 18;
  return {
    "--tree-depth": String(depth),
    "--tree-guides-width": `${guideWidth}px`,
    "--tree-indent-width": "18px",
  } as CSSProperties;
}

type TreeIconKind =
  | "agent-contract"
  | "code"
  | "config"
  | "docs-folder"
  | "file"
  | "folder"
  | "folder-open"
  | "image"
  | "json"
  | "license"
  | "markdown"
  | "package-folder"
  | "pdf"
  | "plan"
  | "readme"
  | "script-folder"
  | "source-folder"
  | "test-folder"
  | "wiki-folder";

const TREE_ICONS: Record<TreeIconKind, LucideIcon> = {
  "agent-contract": ShieldCheck,
  code: Code2,
  config: FileCog,
  "docs-folder": BookOpen,
  file: File,
  folder: Folder,
  "folder-open": FolderOpen,
  image: ImageIcon,
  json: Braces,
  license: ShieldCheck,
  markdown: FileText,
  "package-folder": Package,
  pdf: FileText,
  plan: ClipboardList,
  readme: BookOpen,
  "script-folder": Terminal,
  "source-folder": Code2,
  "test-folder": FlaskConical,
  "wiki-folder": ScrollText,
};

function TreeIcon({ kind, className }: { kind: TreeIconKind; className?: string }) {
  const Icon = TREE_ICONS[kind];
  return <Icon className={className} aria-hidden="true" focusable="false" strokeWidth={1.8} />;
}

function getTreeIconKind(node: TreeNode, isExpanded: boolean): TreeIconKind {
  if (node.type === "directory") {
    if (node.path === "docs/wiki" || node.path.startsWith("docs/wiki/")) return "wiki-folder";
    switch (node.name) {
      case "docs":
        return "docs-folder";
      case "packages":
        return "package-folder";
      case "scripts":
        return "script-folder";
      case "src":
        return "source-folder";
      case "tests":
        return "test-folder";
      default:
        return isExpanded ? "folder-open" : "folder";
    }
  }

  const lowerName = node.name.toLowerCase();
  const extension = node.extension.toLowerCase();
  if (lowerName === "readme.md") return "readme";
  if (lowerName === "agents.md") return "agent-contract";
  if (lowerName === "plans.md") return "plan";
  if (lowerName === "license") return "license";
  if ([".gif", ".jpg", ".jpeg", ".png", ".svg", ".webp"].includes(extension)) return "image";
  if (extension === ".pdf") return "pdf";
  if (extension === ".md" || extension === ".markdown") return "markdown";
  if ([".json", ".jsonc"].includes(extension)) return "json";
  if ([".yaml", ".yml", ".toml", ".env", ".gitignore"].includes(extension)) return "config";
  if ([".css", ".csv", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".rs", ".sh", ".sql", ".ts", ".tsx", ".xml"].includes(extension)) return "code";
  return "file";
}

function FileTabBar({ tabs, activeTabId, notice, onActivate, onToggleFixed, onTogglePin, onClose, onReveal, onHttpDelivery }: {
  tabs: FileTab[];
  activeTabId: string;
  notice: string;
  onActivate: (tabId: string) => void;
  onToggleFixed: (tabId: string) => void;
  onTogglePin: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onReveal: (tabId: string) => void;
  onHttpDelivery: (tabId: string) => void;
}) {
  const sequenceStartActiveByTabRef = useRef(new Map<string, boolean>());
  const lastTapRef = useRef<{ tabId: string; time: number; startedActive: boolean } | null>(null);
  const [tabMenu, setTabMenu] = useState<TabContextMenu>(null);
  useEffect(() => {
    if (!tabMenu) return undefined;
    function closeMenu() {
      setTabMenu(null);
    }
    function closeMenuOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setTabMenu(null);
    }
    window.addEventListener("click", closeMenu);
    window.addEventListener("keydown", closeMenuOnEscape);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("keydown", closeMenuOnEscape);
    };
  }, [tabMenu]);

  if (!tabs.length) return null;
  const menuTab = tabMenu ? tabs.find((tab) => tab.id === tabMenu.tabId) || null : null;

  function openTabMenu(tabId: string, event: ReactMouseEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    setTabMenu({
      tabId,
      x: Math.max(8, event.clientX),
      y: Math.max(8, event.clientY),
    });
  }

  return (
    <div className="file-tab-bar-wrap">
      <div className="file-tab-bar" role="tablist" aria-label="Open files">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          const stateLabel = tab.isPinned ? "Pinned" : tab.isPreview ? "Preview" : "Fixed";
          return (
            <div
              key={tab.id}
              className={`file-tab${active ? " active" : " inactive"}${tab.isPreview ? " preview" : " fixed"}${tab.isPinned ? " pinned" : ""}`}
              data-testid="file-tab"
              role="tab"
              tabIndex={0}
              aria-label={tab.title}
              aria-selected={active}
              title={tab.path}
              onClick={(event) => {
                const detail = event.detail || 1;
                if (detail <= 1 || !sequenceStartActiveByTabRef.current.has(tab.id)) {
                  sequenceStartActiveByTabRef.current.set(tab.id, active);
                }
                onActivate(tab.id);
                if (active && detail <= 1) onReveal(tab.id);
              }}
              onDoubleClick={() => {
                const sequenceStartedActive = sequenceStartActiveByTabRef.current.get(tab.id) ?? active;
                sequenceStartActiveByTabRef.current.delete(tab.id);
                if (sequenceStartedActive) onToggleFixed(tab.id);
              }}
              onKeyDown={(event) => {
                if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                  event.preventDefault();
                  const rect = event.currentTarget.getBoundingClientRect();
                  setTabMenu({ tabId: tab.id, x: rect.left + 12, y: rect.bottom + 4 });
                  return;
                }
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                onActivate(tab.id);
                if (active) onReveal(tab.id);
              }}
              onPointerUp={(event) => {
                if (event.pointerType === "mouse") return;
                const now = typeof performance !== "undefined" ? performance.now() : Date.now();
                const previousTap = lastTapRef.current;
                if (previousTap && previousTap.tabId === tab.id && now - previousTap.time <= 360 && previousTap.startedActive) {
                  lastTapRef.current = null;
                  onToggleFixed(tab.id);
                  return;
                }
                lastTapRef.current = { tabId: tab.id, time: now, startedActive: active };
              }}
              onContextMenu={(event) => openTabMenu(tab.id, event)}
            >
              <span className="file-tab-glyph" aria-hidden="true">{tab.isPinned ? "P" : tab.isPreview ? "~" : "="}</span>
              <span className="file-tab-title">{tab.title}</span>
              <span className="file-tab-state">{stateLabel}</span>
              <button type="button" className="file-tab-close" aria-label={`Close ${tab.title}`} onClick={(event) => {
                event.stopPropagation();
                onClose(tab.id);
              }}>
                x
              </button>
            </div>
          );
        })}
      </div>
      {menuTab && tabMenu ? (
        <div className="file-tab-menu" role="menu" style={{ left: tabMenu.x, top: tabMenu.y }} onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onToggleFixed(menuTab.id);
              setTabMenu(null);
            }}
          >
            {menuTab.isPreview ? "Fix Tab" : "Return to Preview"}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onTogglePin(menuTab.id);
              setTabMenu(null);
            }}
          >
            {menuTab.isPinned ? "Unpin" : "Pin"}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onHttpDelivery(menuTab.id);
              setTabMenu(null);
            }}
          >
            HTTP Delivery
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onClose(menuTab.id);
              setTabMenu(null);
            }}
          >
            Close
          </button>
        </div>
      ) : null}
      {notice ? <p className="file-tab-notice">{notice}</p> : null}
    </div>
  );
}

function ViewModeControl({ file, mode, onChange }: { file: FileResponse | null; mode: ViewMode; onChange: (mode: ViewMode) => void }) {
  const modes = getViewModes(file);
  if (!file || modes.length === 0) return null;
  if (modes.length === 1) {
    return <div className="mode-label" aria-label="View mode">{modes[0].label}</div>;
  }
  return (
    <div className="segmented" aria-label="View mode">
      {modes.map((item) => (
        <button key={item.mode} type="button" className={mode === item.mode ? "active" : ""} onClick={() => onChange(item.mode)}>
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function buildReaderTypographyStyle(scale: ReaderFontScale): CSSProperties {
  const normalizedScale = normalizeReaderFontScale(scale);
  return {
    "--reader-font-scale": String(normalizedScale),
    "--reader-body-font-size": scaledPx(16, normalizedScale),
    "--reader-h1-font-size": scaledPx(30, normalizedScale),
    "--reader-h2-font-size": scaledPx(23, normalizedScale),
    "--reader-h3-font-size": scaledPx(18, normalizedScale),
    "--reader-small-font-size": scaledPx(13, normalizedScale),
    "--reader-meta-font-size": scaledPx(12, normalizedScale),
    "--reader-code-font-size": scaledPx(13, normalizedScale),
    "--reader-html-root-font-size": scaledPx(HTML_VIEWER_BASE_FONT_SIZE_PX, normalizedScale),
  } as CSSProperties;
}

function scaledPx(baseSize: number, scale: ReaderFontScale): string {
  return `${Number((baseSize * normalizeReaderFontScale(scale)).toFixed(2))}px`;
}

function FileViewer({ tab, outline, readerFontScale, colorMode }: { tab: FileTab | null; outline: OutlineItem[]; readerFontScale: ReaderFontScale; colorMode: BasicSettings["colorMode"] }) {
  if (!tab) return <div className="empty-state">Choose a file from the tree to preview it.</div>;
  if (tab.loading) return <div className="empty-state">Loading {tab.title}...</div>;
  if (tab.error) return <p className="state-text error">{tab.error}</p>;
  const file = tab.file;
  if (!file) return <div className="empty-state">No file is loaded.</div>;
  if (!isDisplayableFile(file)) return <MetadataFileState file={file} />;
  if ((file.kind === "markdown" || file.kind === "html") && tab.viewMode === "source") return <CodeBlock content={file.content} label="Source" gitDiff={file.gitDiff} wrap />;
  if ((file.kind === "code" || file.kind === "text") && tab.viewMode === "raw") return <CodeBlock content={file.content} label="Raw" gitDiff={file.gitDiff} />;
  if (file.kind === "markdown") {
    return <article className="markdown-body" onClick={handleMarkdownClick} dangerouslySetInnerHTML={{ __html: withOutlineHeadingIds(file.markdown?.html || "", outline) }} />;
  }
  if (file.kind === "html") return <iframe className="html-frame" title={file.name} sandbox="" srcDoc={buildSandboxedHtmlSrcDoc(file.content, readerFontScale, colorMode)} />;
  if (file.kind === "image") return <img className="image-viewer" alt={file.name} src={imageFileUrl(file.repoId, file.path, file.assetVersion)} />;
  if (file.kind === "pdf") return <iframe className="pdf-frame" title={file.name} src={pdfFileUrl(file.repoId, file.path, file.assetVersion)} />;
  if (file.kind === "binary") return <BinaryFileState file={file} />;
  return <CodeBlock content={file.content} label="Raw" gitDiff={file.gitDiff} />;
}

export function buildSandboxedHtmlSrcDoc(content: string, readerFontScale: ReaderFontScale = 1, colorMode: BasicSettings["colorMode"] = "light"): string {
  const headInjection = buildHtmlViewerBaseStyle(readerFontScale, colorMode);
  if (/<head[\s>]/i.test(content)) {
    return content.replace(/<head([^>]*)>/i, `<head$1>${headInjection}`);
  }
  if (/<html[\s>]/i.test(content)) {
    return content.replace(/<html([^>]*)>/i, `<html$1><head>${headInjection}</head>`);
  }
  return `<!doctype html><html><head>${headInjection}</head><body>${content}</body></html>`;
}

function buildHtmlViewerBaseStyle(readerFontScale: ReaderFontScale, colorMode: BasicSettings["colorMode"]): string {
  const rootFontSize = scaledPx(HTML_VIEWER_BASE_FONT_SIZE_PX, readerFontScale);
  if (colorMode === "dark") {
    return `<style>:root { color-scheme: dark; font-size: ${rootFontSize}; color: #e6edf0; background: #10181c; } body { background: #10181c; color: #e6edf0; font-size: 1rem; } a { color: #8fd3dc; } code, pre { background: #17262c; color: #eef6f8; }</style>`;
  }
  return `<style>:root { color-scheme: light; font-size: ${rootFontSize}; color: #172026; background: #ffffff; } body { background: #ffffff; color: #172026; font-size: 1rem; }</style>`;
}

function CodeBlock({ content, label, gitDiff, wrap = false }: { content: string; label: string; gitDiff?: FileResponse["gitDiff"]; wrap?: boolean }) {
  const lines = content.length ? content.replace(/\n$/, "").split("\n") : [""];
  const changedLines = new Set(gitDiff?.changedLines || []);
  return (
    <pre className={`code-viewer${wrap ? " wrap" : ""}`} aria-label={label}>
      <code>
        {lines.map((line, index) => {
          const lineNumber = index + 1;
          const lineGitStatus = changedLines.has(lineNumber) ? gitDiff?.status : undefined;
          return (
            <span className={`code-line${lineGitStatus ? ` git-${lineGitStatus}` : ""}`} data-git-status={lineGitStatus} key={`${index}-${line.slice(0, 12)}`}>
              <span className="raw-diff-marker" aria-hidden="true" />
              <span className="code-line-number" aria-hidden="true">{lineNumber}</span>
              <span className="code-line-content">{line || " "}</span>
            </span>
          );
        })}
      </code>
    </pre>
  );
}

function BinaryFileState({ file }: { file: FileResponse }) {
  const status = file.fileInfo.gitStatus === "deleted" ? "Deleted binary file" : "Binary file";
  return (
    <div className="binary-state" data-git-status={file.gitDiff?.status || "binary"}>
      <span className={`binary-state-marker ${file.gitDiff?.status || "binary"}`} aria-hidden="true" />
      <h2>{status}</h2>
      <p>This file is not rendered as text. Use File Information for size, path, and Git state.</p>
    </div>
  );
}

function MetadataFileState({ file }: { file: FileResponse }) {
  const status = file.fileInfo.viewerStatus;
  const title =
    status === "oversized"
      ? "File is too large to display"
      : status === "unsupported"
        ? "File type is not displayed"
        : status === "binary"
          ? "Binary file"
          : "File metadata";
  return (
    <div className="binary-state metadata-state" data-viewer-status={status}>
      <span className={`binary-state-marker ${status === "oversized" ? "binary" : status}`} aria-hidden="true" />
      <h2>{title}</h2>
      <p>Reader-Wiki is showing metadata for this file. Use File Information for size, type, path, and Git state.</p>
    </div>
  );
}

function HttpDeliveryPanel({ status, stoppingItemIds, error, onStop }: {
  status: HttpDeliveryStatus;
  stoppingItemIds: Set<string>;
  error: string;
  onStop: (deliveryId: string) => void;
}) {
  return (
    <section className="http-delivery-control" aria-label="HTTP Delivery">
      <div className="http-delivery-heading">
        <span className="http-delivery-label">HTTP Delivery</span>
        <span className="http-delivery-count">{status.items.length}/{HTTP_DELIVERY_MAX_SESSIONS}</span>
      </div>
      {status.items.length ? (
        <ul className="http-delivery-item-list">
          {status.items.map((item) => (
            <li key={item.id} className="http-delivery-item-row">
              <a className="http-delivery-item-text" href={item.url} target="_blank" rel="noreferrer" title={`${item.path}\n${item.url}`}>
                {formatHttpDeliveryPath(item.path)}
              </a>
              <button
                type="button"
                className="http-delivery-stop-button"
                aria-label={`Stop HTTP Delivery for ${item.path}`}
                title="Stop HTTP Delivery"
                disabled={stoppingItemIds.has(item.id)}
                onClick={() => onStop(item.id)}
              >
                <Trash2 aria-hidden="true" focusable="false" strokeWidth={1.8} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="http-delivery-status">No active files</p>
      )}
      {error ? <p className="http-delivery-status error">{error}</p> : null}
    </section>
  );
}

function RightPanel({ mode, onModeChange, file, outline, onHeadingSelect, memoText, memoMode, onMemoTextChange, onMemoModeChange, aiSettings, aiChatSession, onAIChatSessionChange, aiModelBehavior, activeRepoId, onOpenSettings }: {
  mode: RightPanelMode;
  onModeChange: (mode: RightPanelMode) => void;
  file: FileResponse | null;
  outline: OutlineItem[];
  onHeadingSelect: (headingId: string) => void;
  memoText: string;
  memoMode: MemoMode;
  onMemoTextChange: (value: string) => void;
  onMemoModeChange: (mode: MemoMode) => void;
  aiSettings: AISettingsState;
  aiChatSession: AIChatSessionState;
  onAIChatSessionChange: (updater: (session: AIChatSessionState) => AIChatSessionState) => void;
  aiModelBehavior: ReturnType<typeof activeAIModelBehavior>;
  activeRepoId: string;
  onOpenSettings: () => void;
}) {
  return (
    <aside className="right-panel" aria-label="Reader side panel">
      <header className="right-panel-header">
        <div className="right-panel-tabs" role="tablist" aria-label="Side panel views">
          <button type="button" role="tab" aria-selected={mode === "outline"} className={mode === "outline" ? "active" : ""} onClick={() => onModeChange("outline")}>
            Outline
          </button>
          <button type="button" role="tab" aria-selected={mode === "memo"} className={mode === "memo" ? "active" : ""} onClick={() => onModeChange("memo")}>
            Memo
          </button>
          <button type="button" role="tab" aria-selected={mode === "aiChat"} className={mode === "aiChat" ? "active" : ""} onClick={() => onModeChange("aiChat")}>
            AI Chat
          </button>
        </div>
      </header>
      {mode === "outline" ? (
        <OutlinePanel file={file} outline={outline} onHeadingSelect={onHeadingSelect} />
      ) : mode === "memo" ? (
        <MemoPanel memoText={memoText} memoMode={memoMode} onMemoTextChange={onMemoTextChange} onMemoModeChange={onMemoModeChange} />
      ) : (
        <section className="side-panel-body">
          <AIChatPanel
            aiSettings={aiSettings}
            session={aiChatSession}
            onSessionChange={onAIChatSessionChange}
            modelBehavior={aiModelBehavior}
            activeRepoId={activeRepoId}
            activeFile={file}
            onOpenSettings={onOpenSettings}
            onMarkdownClick={handleMarkdownClick}
          />
        </section>
      )}
    </aside>
  );
}

function OutlinePanel({ file, outline, onHeadingSelect }: { file: FileResponse | null; outline: OutlineItem[]; onHeadingSelect: (headingId: string) => void }) {
  return (
    <section className="side-panel-body">
      <FileInformationPanel file={file} />
      <h2>Table of Contents</h2>
      {!file ? (
        <p className="state-text">No file selected.</p>
      ) : outline.length ? (
        <ol className="outline-list">
          {outline.map((item) => (
            <li key={`${item.line}-${item.text}`} style={{ paddingLeft: `${(item.level - 1) * 10}px` }}>
              <button type="button" className="outline-link" onClick={() => onHeadingSelect(item.id)}>
                <span>{item.text}</span>
                <small>Line {item.line}</small>
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="state-text">No headings found.</p>
      )}
    </section>
  );
}

function FileInformationPanel({ file }: { file: FileResponse | null }) {
  return (
    <section className="file-information" aria-label="File Information">
      <h2>File Information</h2>
      {!file ? (
        <p className="state-text">No file selected.</p>
      ) : (
        <dl className="file-info-list">
          <FileInfoRow label="File name" value={file.fileInfo.name} />
          <FileInfoRow label="Path" value={file.fileInfo.path} />
          <FileInfoRow label="Type" value={formatFileType(file)} />
          {file.fileInfo.mimeType ? <FileInfoRow label="MIME type" value={file.fileInfo.mimeType} /> : null}
          {file.docx ? <FileInfoRow label="Source" value="Markdown in .docx" /> : null}
          {file.fileInfo.viewerStatus !== "displayable" && file.fileInfo.viewerStatus !== "deleted" ? (
            <FileInfoRow label="Viewer state" value={formatStatusLabel(file.fileInfo.viewerStatus)} />
          ) : null}
          <FileInfoRow label="File size" value={formatBytes(file.fileInfo.byteLength)} />
          <FileInfoRow label="Characters" value={formatCount(file.fileInfo.characterCount)} />
          <FileInfoRow label="Lines" value={formatCount(file.fileInfo.lineCount)} />
          <FileInfoRow label="Created" value={formatDate(file.fileInfo.createdAt)} />
          <FileInfoRow label="Git" value={formatGitState(file)} />
        </dl>
      )}
    </section>
  );
}

function FileInfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function formatFileType(file: FileResponse): string {
  const state =
    file.fileInfo.viewerStatus === "deleted"
      ? "Deleted "
      : file.fileInfo.viewerStatus === "binary"
        ? "Binary "
        : file.fileInfo.viewerStatus === "oversized"
          ? "Oversized "
          : file.fileInfo.viewerStatus === "unsupported"
            ? "Unsupported "
            : "";
  return `${state}${file.fileInfo.type}`;
}

function formatGitState(file: FileResponse): string {
  const states: DiffStatus[] = [];
  if (file.fileInfo.gitStatus) states.push(file.fileInfo.gitStatus);
  if (file.gitDiff?.status === "binary" || file.fileInfo.viewerStatus === "binary") states.push("binary");
  if (!states.length) return "Clean";
  return Array.from(new Set(states)).map(formatStatusLabel).join(" / ");
}

function formatStatusLabel(status: DiffStatus | FileResponse["fileInfo"]["viewerStatus"]): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unknown";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  if (unitIndex === 0) return `${Math.round(value)} ${units[unitIndex]}`;
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unitIndex]}`;
}

function formatCount(count: number): string {
  return Number.isFinite(count) ? count.toLocaleString("en-US") : "Unknown";
}

function formatDate(value: string | null): string {
  if (!value) return "Not available";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function MemoPanel({ memoText, memoMode, onMemoTextChange, onMemoModeChange }: {
  memoText: string;
  memoMode: MemoMode;
  onMemoTextChange: (value: string) => void;
  onMemoModeChange: (mode: MemoMode) => void;
}) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const renderedMemoHtml = useMemo(() => renderMemoMarkdown(memoText), [memoText]);
  const hasMemo = memoText.trim().length > 0;
  const copyLabel = copyState === "copied" ? "Memo copied" : copyState === "error" ? "Memo copy failed" : "Copy memo";

  useEffect(() => {
    if (copyState === "idle") return;
    const timeoutId = window.setTimeout(() => setCopyState("idle"), 1800);
    return () => window.clearTimeout(timeoutId);
  }, [copyState]);

  async function handleCopyMemo() {
    try {
      await writeClipboardText(memoText);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  }

  function handleDownloadMemo() {
    downloadTextFile("reader-wiki-memo.md", memoText, "text/markdown;charset=utf-8");
  }

  return (
    <section className="memo-panel" aria-label="Memo panel">
      <header className="memo-panel-header">
        <h2>Memo</h2>
        <div className="memo-panel-actions" aria-label="Memo actions">
          <div className="memo-mode-toggle" role="group" aria-label="Memo display mode">
            <button type="button" className={memoMode === "raw" ? "active" : ""} aria-pressed={memoMode === "raw"} onClick={() => onMemoModeChange("raw")}>
              Raw
            </button>
            <button type="button" className={memoMode === "render" ? "active" : ""} aria-pressed={memoMode === "render"} onClick={() => onMemoModeChange("render")}>
              Render
            </button>
          </div>
          <button type="button" className={`memo-icon-button ${copyState}`} aria-label={copyLabel} title={copyLabel} onClick={() => void handleCopyMemo()}>
            {copyState === "copied" ? <CheckIcon /> : <CopyIcon />}
          </button>
          <button type="button" className="memo-icon-button" aria-label="Download memo" title="Download memo" onClick={handleDownloadMemo}>
            <DownloadIcon />
          </button>
          <button type="button" className="memo-icon-button danger" aria-label="Delete memo" title="Delete memo" disabled={!memoText} onClick={() => onMemoTextChange("")}>
            <TrashIcon />
          </button>
        </div>
      </header>
      <div className="memo-panel-space">
        {memoMode === "raw" ? (
          <textarea
            className="memo-textarea"
            aria-label="Session memo"
            value={memoText}
            onChange={(event) => onMemoTextChange(event.target.value)}
            placeholder="Session-only Markdown notes"
            spellCheck={false}
          />
        ) : hasMemo ? (
          <article className="memo-preview markdown-body" aria-label="Memo preview" onClick={handleMarkdownClick} dangerouslySetInnerHTML={{ __html: renderedMemoHtml }} />
        ) : (
          <p className="memo-empty">No memo yet.</p>
        )}
      </div>
    </section>
  );
}

function createPlaceholderTab(repoId: string, path: string, options: OpenFileOptions): FileTab {
  return {
    id: createTabId(repoId, path),
    path,
    title: basename(path),
    file: null,
    loading: true,
    error: "",
    viewMode: "rendered",
    isPreview: !options.keep,
    isPinned: false,
    openedAt: Date.now(),
  };
}

function createTabId(repoId: string, path: string): string {
  return `${repoId}:${path}`;
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() || path;
}

function orderTabs(tabs: FileTab[]): FileTab[] {
  return [...tabs].sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || a.openedAt - b.openedAt);
}

function normalizeViewMode(file: FileResponse, mode: ViewMode): ViewMode {
  const allowed = getViewModes(file).map((item) => item.mode);
  if (allowed.includes(mode)) return mode;
  return allowed[0] || "rendered";
}

function shouldShowRepoSyncStatus(status: RepoSyncViewStatus): boolean {
  return status.state === "syncing" || status.state === "synced" || status.state === "warning";
}

function getViewModes(file: FileResponse | null): Array<{ mode: ViewMode; label: string }> {
  if (!file) return [];
  if (!isDisplayableFile(file)) return [{ mode: "rendered", label: "Metadata" }];
  if (file.kind === "markdown" || file.kind === "html") return [{ mode: "rendered", label: "Rendered" }, { mode: "source", label: "Source" }];
  if (file.kind === "code" || file.kind === "text") return [{ mode: "raw", label: "Raw" }];
  return [{ mode: "rendered", label: "Preview" }];
}

function isCopyableFileKind(kind: FileResponse["kind"]): boolean {
  return kind === "markdown" || kind === "html" || kind === "code" || kind === "text";
}

function isDisplayableFile(file: FileResponse): boolean {
  return file.fileInfo.viewerStatus === "displayable" || file.fileInfo.viewerStatus === "deleted";
}

function isRevealableFilePath(path: string): boolean {
  return Boolean(path && !path.startsWith("/") && !path.split("/").includes(".."));
}

function fileTreeAncestorPaths(filePath: string): string[] {
  const parts = filePath.split("/").filter(Boolean);
  parts.pop();
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

function joinRepoPath(root: string, relativePath: string): string {
  if (!root) return relativePath;
  return `${root.replace(/\/+$/, "")}/${relativePath.replace(/^\/+/, "")}`;
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}

function formatHttpDeliveryPath(path: string): string {
  const name = path.split("/").filter(Boolean).pop() || path;
  return path.length > 30 ? `.../${name}` : path;
}

function findHttpDeliveryItem(status: HttpDeliveryStatus, repoId: string, path: string): HttpDeliveryItemStatus | null {
  return status.items.find((item) => item.repoId === repoId && item.path === path) || null;
}

type HttpDeliveryPendingRequest = {
  repoId: string;
  path: string;
  startUrl: string;
};

function openHttpDeliveryBlankTab(request: { repoId: string; path: string }): Window | null {
  try {
    const tab = window.open("about:blank", "_blank");
    if (!tab) return null;
    writeHttpDeliveryPendingDocument(tab, {
      repoId: request.repoId,
      path: request.path,
      startUrl: new URL("/api/http-delivery/start", window.location.href).toString(),
    });
    try {
      tab.opener = null;
    } catch {
      // Some test and browser environments expose opener as read-only.
    }
    return tab;
  } catch {
    return null;
  }
}

function writeHttpDeliveryPendingDocument(tab: Window, request: HttpDeliveryPendingRequest): void {
  try {
    const payload = safeJsonForInlineScript(request);
    tab.document.open();
    tab.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Starting HTTP Delivery</title><style>:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1f2933;background:#ffffff}body{margin:0;display:grid;min-height:100vh;place-items:center}main{max-width:420px;padding:32px;text-align:center}h1{font-size:18px;margin:0 0 8px}p{color:#5b6670;font-size:13px;margin:0}</style></head><body><main><h1>Starting HTTP Delivery</h1><p>This tab will navigate when the local item is ready.</p></main><script>const request=${payload};async function start(){try{const response=await fetch(request.startUrl,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({repoId:request.repoId,path:request.path})});if(!response.ok)throw new Error("HTTP Delivery start failed.");const status=await response.json();const item=Array.isArray(status.items)?status.items.find((item)=>item&&item.repoId===request.repoId&&item.path===request.path):null;if(!item||!item.url)throw new Error("HTTP Delivery item was not found.");window.location.replace(item.url)}catch(error){document.body.textContent=error&&error.message?error.message:"HTTP Delivery failed."}}start();</script></body></html>`);
    tab.document.close();
  } catch {
    // Some popup surfaces do not expose the new tab document. The opener still drives navigation.
  }
}

function safeJsonForInlineScript(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => {
    switch (character) {
      case "<":
        return "\\u003c";
      case ">":
        return "\\u003e";
      case "&":
        return "\\u0026";
      case "\u2028":
        return "\\u2028";
      case "\u2029":
        return "\\u2029";
      default:
        return character;
    }
  });
}

function navigateHttpDeliveryTab(tab: Window | null, url: string): void {
  if (!tab) return;
  try {
    tab.location.href = url;
  } catch {
    closePendingHttpDeliveryTab(tab);
  }
}

function closePendingHttpDeliveryTab(tab: Window | null): void {
  if (!tab) return;
  try {
    tab.close();
  } catch {
    // Closing a blocked or detached tab can fail; the app state still falls back to the panel link.
  }
}

type OutlineItem = {
  id: string;
  level: number;
  text: string;
  line: number;
};

function extractOutline(file: FileResponse | null): OutlineItem[] {
  if (!file || file.kind !== "markdown") return [];
  const source = file.markdown?.body || file.content;
  return source.split("\n").flatMap((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) return [];
    const text = stripMarkdownInline(match[2]);
    return [{ id: createHeadingId(text, index), level: match[1].length, text, line: index + 1 }];
  });
}

function stripMarkdownInline(value: string): string {
  return value.replace(/[`*_#[\]]/g, "").replace(/\((.*?)\)/g, "").trim();
}

function createHeadingId(text: string, index: number): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `heading-${index + 1}-${slug || "section"}`;
}

function withOutlineHeadingIds(html: string, outline: OutlineItem[]): string {
  if (!html || !outline.length || typeof DOMParser === "undefined") return html;
  const document = new DOMParser().parseFromString(html, "text/html");
  const headings = Array.from(document.body.querySelectorAll("h1, h2, h3, h4, h5, h6"));
  headings.forEach((heading, index) => {
    const item = outline[index];
    if (!item) return;
    heading.id = item.id;
    heading.setAttribute("data-outline-id", item.id);
  });
  return document.body.innerHTML;
}

function renderMemoMarkdown(content: string): string {
  return injectMarkdownCodeToolbarButtons(memoMarkdown.render(content));
}

function handleMarkdownClick(event: ReactMouseEvent<HTMLElement>) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const copyButton = target.closest<HTMLButtonElement>(".markdown-code-copy-button");
  if (copyButton && event.currentTarget.contains(copyButton)) {
    event.preventDefault();
    event.stopPropagation();
    void copyMarkdownCodeBlock(copyButton);
    return;
  }
  const wrapButton = target.closest<HTMLButtonElement>(".markdown-code-wrap-button");
  if (wrapButton && event.currentTarget.contains(wrapButton)) {
    event.preventDefault();
    event.stopPropagation();
    toggleMarkdownCodeBlockWrap(wrapButton);
  }
}

const MARKDOWN_CODE_COPY_LABELS: Record<CopyState, string> = {
  idle: "Copy code block",
  copied: "Code block copied",
  error: "Code block copy failed",
};
const markdownCodeCopyResetTimers = new Map<HTMLButtonElement, number>();

async function copyMarkdownCodeBlock(button: HTMLButtonElement): Promise<void> {
  const code = button.closest(".markdown-code-block")?.querySelector("pre code");
  if (!code) {
    setMarkdownCodeCopyButtonState(button, "error");
    scheduleMarkdownCodeCopyButtonReset(button);
    return;
  }

  try {
    await writeClipboardText(code.textContent || "");
    setMarkdownCodeCopyButtonState(button, "copied");
  } catch {
    setMarkdownCodeCopyButtonState(button, "error");
  }
  scheduleMarkdownCodeCopyButtonReset(button);
}

function setMarkdownCodeCopyButtonState(button: HTMLButtonElement, state: CopyState): void {
  const label = MARKDOWN_CODE_COPY_LABELS[state];
  button.dataset.copyState = state;
  button.setAttribute("aria-label", label);
  button.title = label;
}

function scheduleMarkdownCodeCopyButtonReset(button: HTMLButtonElement): void {
  const previousTimer = markdownCodeCopyResetTimers.get(button);
  if (previousTimer !== undefined) window.clearTimeout(previousTimer);
  const nextTimer = window.setTimeout(() => {
    if (button.isConnected) setMarkdownCodeCopyButtonState(button, "idle");
    markdownCodeCopyResetTimers.delete(button);
  }, 1800);
  markdownCodeCopyResetTimers.set(button, nextTimer);
}

function toggleMarkdownCodeBlockWrap(button: HTMLButtonElement): void {
  const block = button.closest<HTMLElement>(".markdown-code-block");
  if (!block) return;
  const shouldWrap = !block.classList.contains("wrapped");
  block.classList.toggle("wrapped", shouldWrap);
  button.dataset.wrapState = shouldWrap ? "on" : "off";
  button.setAttribute("aria-pressed", String(shouldWrap));
  const label = shouldWrap ? "Disable code wrap" : "Wrap code block";
  button.setAttribute("aria-label", label);
  button.title = label;
}

async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await withTimeout(navigator.clipboard.writeText(text), 900);
      return;
    } catch {
      // Fall through to the selection-based copy path.
    }
  }
  if (copyTextWithSelection(text)) return;
  throw new Error("Clipboard write failed");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = window.setTimeout(() => reject(new Error("Timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
}

function copyTextWithSelection(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.left = "-1000px";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.opacity = "0";

  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    document.body.removeChild(textarea);
  }
  return copied;
}

function downloadTextFile(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M8 8h10v12H8z" />
      <path d="M6 16H4V4h12v2" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 4v10" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 20h14" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 7h16" />
      <path d="M9 7V5h6v2" />
      <path d="m7 7 1 13h8l1-13" />
    </svg>
  );
}
