import { readFileSync } from "node:fs";
import path from "node:path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, buildSandboxedHtmlSrcDoc } from "../src/App";

const fetchMock = vi.fn<typeof fetch>();
const stylesCss = readFileSync(path.join(process.cwd(), "src/styles.css"), "utf8");

const treeNodes = [
  { name: "docs", path: "docs", type: "directory", extension: "", gitStatus: "changed" },
  { name: "very-long-directory-name-with-many-segments", path: "very-long-directory-name-with-many-segments", type: "directory", extension: "" },
  { name: "README.md", path: "README.md", type: "file", extension: ".md", gitStatus: "changed" },
  { name: "image.png", path: "image.png", type: "file", extension: ".png" },
  { name: "paper.pdf", path: "paper.pdf", type: "file", extension: ".pdf" },
  { name: "archive.zip", path: "archive.zip", type: "file", extension: ".zip" },
  { name: "guide.md", path: "guide.md", type: "file", extension: ".md" },
  { name: "api.ts", path: "api.ts", type: "file", extension: ".ts" },
  { name: "notes.txt", path: "notes.txt", type: "file", extension: ".txt" },
  { name: "page.html", path: "page.html", type: "file", extension: ".html" },
  { name: "extra.md", path: "extra.md", type: "file", extension: ".md" },
];
const docsTreeNodes = [
  { name: "inside.md", path: "docs/inside.md", type: "file", extension: ".md", gitStatus: "new" },
];
const treeSnapshot = {
  "": treeNodes,
  docs: docsTreeNodes,
  "very-long-directory-name-with-many-segments": [],
};
const altTreeNodes = [
  { name: "ALT.md", path: "ALT.md", type: "file", extension: ".md" },
];
const altTreeSnapshot = {
  "": altTreeNodes,
};
let httpDeliverySessions: Array<{ id: string; repoId: string; path: string; url: string; startedAt: string }> = [];
let windowOpenMock: ReturnType<typeof vi.fn>;
let openedHttpDeliveryTabs: MockOpenedTab[] = [];
let repoOpenHandler: (body: Record<string, unknown>) => Promise<Response> | Response;

type MockOpenedTab = {
  location: { href: string };
  close: ReturnType<typeof vi.fn>;
  closed: boolean;
  opener: unknown;
};

function cssRule(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = stylesCss.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  return match ? match[1] : "";
}

function fetchCallsTo(pathname: string) {
  return fetchMock.mock.calls.filter(([input]) => String(input) === pathname);
}

function fileFetchCallsFor(pathname: string) {
  return fetchMock.mock.calls.filter(([input]) => {
    const value = String(input);
    if (!value.startsWith("/api/file")) return false;
    return new URL(`http://reader-wiki.local${value}`).searchParams.get("path") === pathname;
  });
}

function installLocalStorageMock(): void {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
    } satisfies Pick<Storage, "getItem" | "setItem" | "removeItem" | "clear">,
  });
}

beforeEach(() => {
  installLocalStorageMock();
  httpDeliverySessions = [];
  openedHttpDeliveryTabs = [];
  windowOpenMock = vi.fn(() => createMockOpenedTab() as unknown as Window);
  repoOpenHandler = (body) => {
    const repoId = String(body.repoId || "docs");
    return json({
      repoId,
      sync: { state: "disabled", message: "Git remote fetch disabled.", fetched: false },
      tree: repoId === "alt" ? altTreeSnapshot : treeSnapshot,
    });
  };
  Object.defineProperty(window, "open", { value: windowOpenMock, configurable: true, writable: true });
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "/api/repos") {
      return json({
        repositories: [
          { id: "docs", label: "Docs", root: "/tmp/docs", defaultPath: "README.md", exists: true },
          { id: "alt", label: "Alt", root: "/tmp/alt", defaultPath: "ALT.md", exists: true },
        ],
      });
    }
    if (url === "/api/repository-config") {
      return json(repositoryConfigState());
    }
    if (url === "/api/repository-config/validate") {
      return json(repositoryValidation());
    }
    if (url === "/api/repository-config/preview") {
      return json({ yaml: "repositories:\n  - id: docs\n    label: Docs\n    root: /tmp/docs\n", validation: repositoryValidation() });
    }
    if (url === "/api/repository-config/save") {
      return json(repositoryConfigState());
    }
    if (url === "/api/ai/test-connection") {
      return json({ state: "ready", code: "success", severity: "success", message: "Connected.", nextAction: "This entry is ready for read-only AI Chat.", checkedAt: "2026-07-03T00:00:00.000Z" });
    }
    if (url === "/api/ai/entry-readiness") {
      const body = parseJsonBody(init?.body) as { entry?: string };
      return json(cliReadiness(String(body.entry || "codexCli")));
    }
    if (url === "/api/ai/chat" || url === "/api/ai/chat/stream") {
      const body = parseJsonBody(init?.body) as { target?: { kind?: string; entry?: string; provider?: { entry?: string } }; provider?: { entry?: string } };
      const target = body.target?.kind === "cli" ? body.target.entry : body.target?.provider?.entry || body.provider?.entry || "provider";
      const codeBlock = "```ts\nconst ok = true;\n```";
      const content = `${target} says the active file says hello.\n\n- [x] Render task item\n\n${codeBlock}`;
      const payload = {
        message: { role: "assistant", content },
        context: { repoId: "docs", path: "README.md", fileName: "README.md", fileKind: "markdown", viewerStatus: "displayable", lineCount: 12, byteLength: 120, contentIncluded: true, content: "# Hello" },
        status: { state: "ready", message: "Response received.", checkedAt: "2026-07-03T00:00:00.000Z" },
      };
      if (url === "/api/ai/chat/stream") {
        return streamJsonLines([
          { type: "meta", context: payload.context },
          { type: "delta", content: `${target} says ` },
          { type: "delta", content: "the active file says hello." },
          { type: "delta", content: `\n\n- [x] Render task item\n\n${codeBlock}` },
          { type: "done", ...payload },
        ]);
      }
      return json(payload);
    }
    if (url === "/api/repo-open") {
      return repoOpenHandler(parseJsonBody(init?.body));
    }
    if (url.startsWith("/api/tree")) {
      const query = new URL(`http://local${url}`).searchParams;
      const repoId = query.get("repo") || "docs";
      const path = query.get("path") || "";
      if (repoId === "alt") return json({ nodes: path ? [] : altTreeNodes });
      return json({ nodes: path === "docs" ? docsTreeNodes : treeNodes });
    }
    if (url.startsWith("/api/file")) {
      const query = new URL(`http://local${url}`).searchParams;
      const repoId = query.get("repo") || "docs";
      const path = query.get("path") || "README.md";
      return json(fileForPath(path, repoId));
    }
    if (url === "/api/http-delivery/status") {
      return json({ state: httpDeliverySessions.length ? "running" : "idle", items: httpDeliverySessions });
    }
    if (url === "/api/http-delivery/start") {
      const body = parseJsonBody(init?.body);
      const path = String(body.path || "");
      const existing = httpDeliverySessions.find((item) => item.repoId === body.repoId && item.path === path);
      if (!existing && httpDeliverySessions.length >= 5) return json({ error: "HTTP Delivery supports up to 5 active files." }, 409);
      if (!existing) {
        const id = `item-${httpDeliverySessions.length + 1}`;
        httpDeliverySessions.push({ id, repoId: String(body.repoId || "docs"), path, url: `/delivery/${id}/${path.split("/").pop() || path}`, startedAt: "2026-06-30T00:00:00.000Z" });
      }
      return json({ state: httpDeliverySessions.length ? "running" : "idle", items: httpDeliverySessions });
    }
    if (url === "/api/http-delivery/stop") {
      const body = parseJsonBody(init?.body);
      httpDeliverySessions = httpDeliverySessions.filter((item) => item.id !== body.deliveryId);
      return json({ state: httpDeliverySessions.length ? "running" : "idle", items: httpDeliverySessions });
    }
    return json({ error: "not found" }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("App", () => {
  it("loads repositories, tree, default markdown, and the outline panel", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Reader-Wiki" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "README.md" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    expect(document.querySelector(".viewer-header h2")?.textContent).toBe("README.md");
    expect(document.querySelector(".viewer-kicker")).toBeNull();
    expect(document.querySelector(".selected-path")).toBeNull();
    expect(screen.getByRole("tab", { name: "Outline" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { name: "File Information" })).toBeTruthy();
    expect(screen.getByText("File name")).toBeTruthy();
    expect(screen.getAllByText("README.md").length).toBeGreaterThan(0);
    expect(screen.getByText("File size")).toBeTruthy();
    expect(screen.getByText("Characters")).toBeTruthy();
    expect(screen.getByText("Lines")).toBeTruthy();
    expect(screen.getByText("Created")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Table of Contents" })).toBeTruthy();
    expect(screen.queryByText("Git remote fetch disabled.")).toBeNull();
    expect(document.querySelector(".repo-sync-status")).toBeNull();
    expect(screen.getAllByText("Intro").length).toBeGreaterThanOrEqual(2);
    const removedTextBadgeSelector = "." + ["git", "status"].join("-");
    expect(document.querySelector(removedTextBadgeSelector)).toBeNull();
    expect(document.querySelector(".tree-diff-marker[data-git-status='changed']")).toBeTruthy();
    expect(document.querySelector(".tree-icon")).toBeTruthy();
    expect(document.querySelector(".tree-section")).toBeTruthy();
    expect(document.querySelector(".viewer-body")).toBeTruthy();
    expect(document.querySelector(".side-panel-body")).toBeTruthy();
    expect(document.querySelector(".markdown-table-scroll")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/repo-open", expect.objectContaining({ method: "POST" }));
  });

  it("switches markdown Source view and code Raw view", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    const sourceViewer = await screen.findByLabelText("Source");
    expect(sourceViewer.textContent).toContain("# Hello");
    expect(sourceViewer.className).toContain("wrap");
    expect(document.querySelector(".code-line[data-git-status='changed']")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "api.ts" }));
    const rawViewer = await screen.findByLabelText("Raw");
    expect(rawViewer.textContent).toContain("export function read");
    expect(rawViewer.className).not.toContain("wrap");
    expect(screen.getByLabelText("View mode").textContent).toContain("Raw");
  });

  it("uses a light gray code viewer surface while keeping diff marker colors semantic", () => {
    const codeViewerRule = cssRule(".code-viewer");
    expect(codeViewerRule).toContain("background: #fbfcfd;");
    expect(codeViewerRule).toContain("color: #172026;");
    expect(codeViewerRule).toContain("border: 1px solid #d7dce0;");
    expect(codeViewerRule).not.toContain("#0f181d");
    expect(codeViewerRule).not.toContain("#243941");
    expect(cssRule(".code-line:hover")).toContain("background: #f2f6f8;");
    expect(cssRule(".code-line-number")).toContain("border-right: 1px solid #d7dce0;");
    expect(cssRule(".code-line.git-changed .raw-diff-marker")).toContain("background: var(--git-changed);");
  });

  it("defines dark theme overrides for the app and settings surfaces", () => {
    expect(stylesCss).toContain('.app-shell[data-color-mode="dark"]');
    expect(stylesCss).toContain('.settings-shell[data-color-mode="dark"]');
    expect(stylesCss).toContain("color-scheme: dark;");
    expect(stylesCss).toContain("--rw-dark-app: #10181c;");
    expect(stylesCss).toContain('--rw-dark-code: #0f171b;');
    expect(stylesCss).toContain('.app-shell[data-color-mode="dark"] .code-viewer');
    expect(stylesCss).toContain('.app-shell[data-color-mode="dark"] .ai-message-role-chip');
  });

  it("keeps AI Chat Markdown layout narrow while allowing only table and code block scrolling", () => {
    expect(cssRule(".right-panel.ai-chat-right-panel")).toContain("height: 72vh;");
    expect(cssRule(".right-panel.ai-chat-right-panel")).toContain("min-height: 520px;");
    expect(cssRule(".side-panel-body.ai-chat-side-panel")).toContain("height: 100%;");
    expect(cssRule(".side-panel-body.ai-chat-side-panel")).toContain("overflow: hidden;");
    expect(cssRule(".ai-chat-panel")).toContain("overflow: hidden;");
    expect(cssRule(".ai-chat-panel")).toContain("height: 100%;");
    expect(cssRule(".ai-chat-panel.ready")).toContain("grid-template-rows: minmax(0, 1fr) auto auto;");
    expect(cssRule(".ai-chat-messages")).toContain("overflow-x: hidden;");
    expect(cssRule(".ai-chat-messages")).toContain("overflow-y: auto;");
    expect(cssRule(".ai-message")).toContain("border: 0;");
    expect(cssRule(".ai-message")).toContain("background: transparent;");
    expect(cssRule(".ai-message-role-chip")).toContain("border-radius: 999px;");
    expect(cssRule(".ai-message-role-chip")).toContain("font-size: 11px;");
    expect(cssRule(".ai-message-body")).toContain("overflow-x: hidden;");
    expect(cssRule(".ai-message-footer")).toContain("justify-content: flex-start;");
    expect(stylesCss).toContain(".ai-message.user .ai-message-footer { justify-content: flex-end; }");
    expect(stylesCss).toContain(".markdown-body .markdown-code-block.wrapped pre,");
    expect(stylesCss).toContain("min-width: 0;");
    expect(cssRule(".ai-message-body h1")).toContain("font-size: 20px;");
    expect(cssRule(".ai-message-body .markdown-code-action-button")).toContain("display: inline-grid;");
    expect(cssRule(".ai-message-body .markdown-code-action-button")).toContain("place-items: center;");
    expect(cssRule(".ai-message-body .markdown-code-action-button")).toContain("width: 28px;");
    expect(cssRule(".ai-message-body .markdown-code-action-button")).toContain("overflow: hidden;");
    expect(cssRule(".ai-message-body .markdown-code-icon")).toContain("justify-content: center;");
    expect(cssRule(".ai-message-body .markdown-code-icon svg")).toContain("width: 14px;");
    expect(cssRule(".ai-message-body .markdown-code-icon svg")).toContain("overflow: hidden;");
    expect(stylesCss).toContain('.ai-message-body .markdown-code-copy-button[data-copy-state="idle"] .markdown-code-icon-check,');
    expect(stylesCss).toContain('.ai-message-body .markdown-code-copy-button[data-copy-state="error"] .markdown-code-icon-check {\n  display: none;\n}');
    expect(stylesCss).toContain('.ai-message-body .markdown-code-copy-button[data-copy-state="copied"] .markdown-code-icon-check {\n  display: inline-flex;\n}');
    expect(cssRule(".ai-chat-composer")).toContain("position: sticky;");
    expect(cssRule(".ai-chat-composer")).toContain("bottom: 0;");
    expect(stylesCss).toContain(".ai-chat-composer textarea {\n  grid-column: 1;\n  resize: vertical;\n  min-height: 114px;");
  });

  it("defines Reader layout density through app-shell custom properties", () => {
    const appShellRule = cssRule(".app-shell");
    expect(appShellRule).toContain("--rw-left-panel-min: 260px;");
    expect(appShellRule).toContain("--rw-right-panel-max: 310px;");
    expect(appShellRule).toContain("grid-template-columns: minmax(var(--rw-left-panel-min), var(--rw-left-panel-max)) minmax(0, 1fr) minmax(var(--rw-right-panel-min), var(--rw-right-panel-max));");

    const compactRule = cssRule(".app-shell.layout-compact");
    expect(compactRule).toContain("--rw-left-panel-min: 300px;");
    expect(compactRule).toContain("--rw-left-panel-max: 380px;");
    expect(compactRule).toContain("--rw-right-panel-min: 285px;");
    expect(compactRule).toContain("--rw-side-panel-padding: 12px;");

    const focusedRule = cssRule(".app-shell.layout-focused");
    expect(focusedRule).toContain("--rw-left-panel-max: 270px;");
    expect(focusedRule).toContain("--rw-right-panel-max: 250px;");
    expect(focusedRule).toContain("--rw-viewer-padding-x: 34px;");

    expect(cssRule(".sidebar")).toContain("padding: var(--rw-sidebar-padding-y) var(--rw-sidebar-padding-x);");
    expect(cssRule(".tree-row")).toContain("min-height: var(--rw-tree-row-min-height);");
    expect(cssRule(".viewer-body")).toContain("padding: var(--rw-viewer-padding-top) var(--rw-viewer-padding-x) var(--rw-viewer-padding-bottom);");
    expect(cssRule(".side-panel-body")).toContain("padding: var(--rw-side-panel-padding);");
    expect(stylesCss).toContain(".app-shell,\n  .app-shell.layout-compact,\n  .app-shell.layout-focused {\n    --rw-sidebar-padding-y: var(--rw-mobile-sidebar-padding-y);");
  });

  it("keeps Settings rail and main as independent scroll containers", () => {
    expect(cssRule(".settings-shell")).toContain("height: 100vh;");
    expect(cssRule(".settings-shell")).toContain("overflow: hidden;");
    expect(cssRule(".settings-rail")).toContain("overflow: auto;");
    expect(cssRule(".settings-main")).toContain("overflow-y: auto;");
    expect(cssRule(".yaml-preview")).toContain("overflow: auto;");
    expect(cssRule(".readiness-details")).toContain("border-top: 1px solid #e0e7ea;");
    expect(cssRule(".entry-card")).toContain("align-content: start;");
    expect(cssRule(".policy-grid")).toContain("repeat(3, minmax(0, 1fr))");
    expect(cssRule(".endpoint-settings-panel")).toContain("grid-column: 1 / -1;");
    expect(cssRule(".settings-details")).toContain("border: 1px solid #d8e1e4;");
  });

  it("reloads the active repository tree and all open file tabs without resetting side state", async () => {
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    const repoPickerRow = document.querySelector(".repo-picker-row") as HTMLElement;
    expect(repoPickerRow).toBeTruthy();
    expect(cssRule(".repo-picker-row")).toContain("display: flex;");
    expect(cssRule(".repo-picker-row .repo-picker")).toContain("min-width: 0;");
    expect(cssRule(".repo-action-button")).toContain("flex: 0 0 auto;");
    expect(document.querySelector(".sidebar-tree-action")).toBeNull();
    expect(Array.from(repoPickerRow.children).map((child) => child.getAttribute("aria-label") || child.id)).toEqual([
      "repo-picker",
      "Reload repository",
      "Collapse all folders",
    ]);
    expect(repoPickerRow.querySelector('[aria-label="Reload repository"]')).toBeTruthy();
    expect(repoPickerRow.querySelector('[aria-label="Collapse all folders"]')).toBeTruthy();
    expect(document.querySelector(".viewer-copy-actions")?.querySelector('[aria-label="Reload repository"]')).toBeNull();
    expect(document.querySelector(".viewer-copy-actions")?.querySelector('[aria-label="Collapse all folders"]')).toBeNull();

    fireEvent.doubleClick(screen.getByRole("tab", { name: "README.md" }));
    fireEvent.click(screen.getByRole("button", { name: "guide.md" }));
    expect(await screen.findByRole("heading", { name: "Guide" })).toBeTruthy();
    expect(fileTabTitles()).toEqual(["README.md", "guide.md"]);

    fireEvent.click(screen.getByRole("tab", { name: "Memo" }));
    fireEvent.change(screen.getByLabelText("Session memo"), { target: { value: "reload memo" } });

    fireEvent.click(openSettingsButton());
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "AI Chat" }));
    const codexCliEntry = screen.getByLabelText(["Co", "dex CLI entry"].join(""));
    fireEvent.click(within(codexCliEntry).getByRole("button", { name: "Set active" }));
    const codexCliReadiness = screen.getByLabelText(["Co", "dex CLI readiness"].join(""));
    await waitFor(() => expect(within(codexCliReadiness).getByRole("button", { name: "Check again" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.click(screen.getByRole("tab", { name: "AI Chat" }));
    const chatInput = await screen.findByLabelText("AI Chat message");
    fireEvent.change(chatInput, { target: { value: "reload draft" } });

    const readmeFetchesBeforeReload = fileFetchCallsFor("README.md").length;
    const guideFetchesBeforeReload = fileFetchCallsFor("guide.md").length;
    const repoOpenCallsBeforeReload = fetchCallsTo("/api/repo-open").length;
    repoOpenHandler = (body) => {
      const repoId = String(body.repoId || "docs");
      return json({
        repoId,
        sync: { state: "synced", message: "Git remote metadata fetched.", fetched: true },
        tree: {
          "": [
            ...treeNodes,
            { name: "fresh.md", path: "fresh.md", type: "file", extension: ".md" },
          ],
          docs: docsTreeNodes,
        },
      });
    };

    fireEvent.click(screen.getByRole("button", { name: "Reload repository" }));

    expect(await screen.findByRole("button", { name: "fresh.md" })).toBeTruthy();
    expect(fetchCallsTo("/api/repo-open").length).toBe(repoOpenCallsBeforeReload + 1);
    await waitFor(() => expect(fileFetchCallsFor("README.md").length).toBeGreaterThan(readmeFetchesBeforeReload));
    await waitFor(() => expect(fileFetchCallsFor("guide.md").length).toBeGreaterThan(guideFetchesBeforeReload));
    expect(fileTabTitles()).toEqual(["README.md", "guide.md"]);
    expect(screen.getByRole("tab", { name: "AI Chat" }).getAttribute("aria-selected")).toBe("true");
    expect((screen.getByLabelText("AI Chat message") as HTMLTextAreaElement).value).toBe("reload draft");

    fireEvent.click(screen.getByRole("tab", { name: "Memo" }));
    expect((screen.getByLabelText("Session memo") as HTMLTextAreaElement).value).toBe("reload memo");
  });

  it("drops stale repository reload tree responses after switching repositories", async () => {
    let resolveReload: ((response: Response) => void) | undefined;
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    repoOpenHandler = (body) => {
      const repoId = String(body.repoId || "docs");
      if (repoId === "docs") {
        return new Promise<Response>((resolve) => {
          resolveReload = resolve;
        });
      }
      return json({
        repoId,
        sync: { state: "synced", message: "Alt metadata fetched.", fetched: true },
        tree: altTreeSnapshot,
      });
    };

    fireEvent.click(screen.getByRole("button", { name: "Reload repository" }));
    await waitFor(() => expect(resolveReload).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "alt" } });
    expect(await screen.findByRole("heading", { name: "Alt" })).toBeTruthy();

    await act(async () => {
      resolveReload?.(json({
        repoId: "docs",
        sync: { state: "synced", message: "Docs metadata fetched late.", fetched: true },
        tree: {
          "": [
            ...treeNodes,
            { name: "fresh.md", path: "fresh.md", type: "file", extension: ".md" },
          ],
          docs: docsTreeNodes,
        },
      }));
    });

    expect(screen.getByRole("button", { name: "ALT.md" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "fresh.md" })).toBeNull();
    expect(screen.queryByRole("button", { name: "README.md" })).toBeNull();
  });

  it("drops stale tree preload responses when switching repositories", async () => {
    let resolveDocsOpen: ((response: Response) => void) | null = null;
    repoOpenHandler = (body) => {
      const repoId = String(body.repoId || "docs");
      if (repoId === "docs") {
        return new Promise<Response>((resolve) => {
          resolveDocsOpen = resolve;
        });
      }
      return json({
        repoId: "alt",
        sync: { state: "skipped", message: "Git sync skipped: no remote is configured.", fetched: false },
        tree: altTreeSnapshot,
      });
    };

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Reader-Wiki" })).toBeTruthy();
    expect(await screen.findByRole("option", { name: "Alt" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "alt" } });
    expect(await screen.findByRole("heading", { name: "Alt" })).toBeTruthy();
    expect(resolveDocsOpen).toBeTruthy();
    (resolveDocsOpen as unknown as (response: Response) => void)(json({
      repoId: "docs",
      sync: { state: "synced", message: "Git remote metadata fetched.", fetched: true },
      tree: treeSnapshot,
    }));

    await waitFor(() => expect(screen.getByRole("button", { name: "ALT.md" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "README.md" })).toBeNull();
    expect(screen.queryByText("Git sync skipped: no remote is configured.")).toBeNull();
    expect(document.querySelector(".repo-sync-status")).toBeNull();
  });

  it("renders tree hierarchy icons and collapses expanded folders without closing the active file", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "docs" }));
    expect(await screen.findByRole("button", { name: "inside.md" })).toBeTruthy();
    expect(document.querySelector(".tree-row[data-icon-kind='docs-folder'] .tree-icon")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Collapse all folders" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "inside.md" })).toBeNull());
    expect(screen.getByRole("heading", { name: "Hello" })).toBeTruthy();
  });

  it("fixes with active double click and pins only through the file tab context menu", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    expect(document.querySelector(".file-tab-controls")).toBeNull();
    expect(screen.queryByRole("button", { name: "Fix" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pin" })).toBeNull();

    fireEvent.doubleClick(screen.getByRole("tab", { name: "README.md" }));
    fireEvent.click(screen.getByRole("button", { name: "guide.md" }));
    expect(await screen.findByRole("heading", { name: "Guide" })).toBeTruthy();
    expect(fileTabTitles()).toEqual(["README.md", "guide.md"]);

    fireEvent.contextMenu(screen.getByRole("tab", { name: "guide.md" }), { clientX: 80, clientY: 40 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin" }));
    expect(fileTab("guide.md").className).toContain("pinned");

    fireEvent.click(screen.getByRole("tab", { name: /README.md/ }));
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Unpin" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /guide.md/ }));
    fireEvent.contextMenu(screen.getByRole("tab", { name: "guide.md" }), { clientX: 80, clientY: 40 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Unpin" }));
    expect(fileTab("guide.md").className).not.toContain("pinned");
    fireEvent.click(screen.getByRole("button", { name: "Close guide.md" }));
    await waitFor(() => expect(fileTabTitles()).toEqual(["README.md"]));
  });

  it("toggles fixed state only when a double click starts on the active file tab", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();

    fireEvent.doubleClick(screen.getByRole("tab", { name: "README.md" }));
    expect(fileTab("README.md").className).toContain("fixed");
    expect(fileTab("README.md").textContent).toContain("Fixed");

    fireEvent.click(screen.getByRole("button", { name: "guide.md" }));
    expect(await screen.findByRole("heading", { name: "Guide" })).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "README.md" }), { detail: 1 });
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "README.md" }), { detail: 2 });
    fireEvent.doubleClick(screen.getByRole("tab", { name: "README.md" }));
    expect(fileTab("README.md").className).toContain("fixed");

    fireEvent.doubleClick(screen.getByRole("tab", { name: "README.md" }));
    expect(fileTab("README.md").className).toContain("preview");
    expect(fileTab("README.md").textContent).toContain("Preview");
  });

  it("keeps at most five tabs per repository", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.doubleClick(screen.getByRole("tab", { name: "README.md" }));

    for (const path of ["guide.md", "api.ts", "notes.txt", "page.html"]) {
      fireEvent.click(screen.getByRole("button", { name: path }));
      await screen.findByRole("tab", { name: new RegExp(path) });
      fireEvent.doubleClick(screen.getByRole("tab", { name: path }));
    }

    expect(fileTabTitles()).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "extra.md" }));
    expect(await screen.findByText(/Maximum of five file tabs/)).toBeTruthy();
    expect(fileTabTitles()).toHaveLength(5);
  });

  it("scrolls from Table of Contents to the rendered heading", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value: scrollIntoView, configurable: true });

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    const tocButton = screen.getByRole("button", { name: "Intro Line 3" });
    expect(tocButton.className).toContain("outline-link");
    fireEvent.click(tocButton);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("copies full file content from the viewer body action", async () => {
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: clipboardWrite }, configurable: true });

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy file content" }));
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith(expect.stringContaining("# Hello")));
    expect(screen.getByRole("button", { name: "File content copied" })).toBeTruthy();
  });

  it("reveals the active file tab in the file tree", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value: scrollIntoView, configurable: true });

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "docs" }));
    fireEvent.click(await screen.findByRole("button", { name: "inside.md" }));
    expect(await screen.findByRole("heading", { name: "Inside" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Collapse all folders" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "inside.md" })).toBeNull());
    fireEvent.click(screen.getByRole("tab", { name: "inside.md" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "inside.md" })).toBeTruthy());
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("provides tree path actions, horizontal scroll hooks, and sticky ancestor jump", async () => {
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: clipboardWrite }, configurable: true });
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value: scrollIntoView, configurable: true });

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();

    fireEvent.contextMenu(screen.getByRole("button", { name: "docs" }), { clientX: 24, clientY: 28 });
    expect(screen.getByRole("menuitem", { name: "Copy Absolute Path" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Copy Relative Path" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Open in New Tab" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Relative Path" }));
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith("docs"));

    fireEvent.contextMenu(screen.getByRole("button", { name: "README.md" }), { clientX: 32, clientY: 36 });
    expect(screen.getByRole("menuitem", { name: "Open in New Tab" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Absolute Path" }));
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith("/tmp/docs/README.md"));

    fireEvent.click(screen.getByRole("button", { name: "docs" }));
    expect(await screen.findByRole("button", { name: "inside.md" })).toBeTruthy();
    const treeSection = document.querySelector(".tree-section") as HTMLElement;
    Object.defineProperty(treeSection, "scrollTop", { value: 31, configurable: true });
    fireEvent.scroll(treeSection);
    expect(screen.getByRole("button", { name: "Jump to docs" })).toBeTruthy();

    const horizontalScrollport = document.querySelector(".tree-list-scrollport") as HTMLElement;
    Object.defineProperty(horizontalScrollport, "scrollLeft", { value: 48, configurable: true });
    fireEvent.scroll(horizontalScrollport);
    expect(document.querySelector(".tree-sticky-column")?.getAttribute("style")).toContain("--tree-scroll-left: 48px");

    fireEvent.click(screen.getByRole("button", { name: "Jump to docs" }));
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("starts, reuses, and stops HTTP Delivery from the viewer and tab menu", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    expect(document.querySelector(".http-delivery-count")?.textContent).toBe("0/5");
    expect(screen.getByText("No active files")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Start HTTP Delivery" }));
    await waitFor(() => expect(document.querySelector(".http-delivery-count")?.textContent).toBe("1/5"));
    expect(windowOpenMock).toHaveBeenCalledWith("about:blank", "_blank");
    await waitFor(() => expect(openedHttpDeliveryTabs[0]?.location.href).toBe("/delivery/item-1/README.md"));
    expect(screen.getByRole("link", { name: "README.md" }).getAttribute("href")).toBe("/delivery/item-1/README.md");

    fireEvent.contextMenu(screen.getByRole("tab", { name: "README.md" }), { clientX: 80, clientY: 40 });
    const menuItems = within(screen.getByRole("menu")).getAllByRole("menuitem").map((item) => item.textContent);
    expect(menuItems).toEqual(["Fix Tab", "Pin", "HTTP Delivery", "Close"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "HTTP Delivery" }));
    await waitFor(() => expect(httpDeliverySessions).toHaveLength(1));
    expect(windowOpenMock).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(openedHttpDeliveryTabs[1]?.location.href).toBe("/delivery/item-1/README.md"));

    fireEvent.click(screen.getByRole("button", { name: "Stop HTTP Delivery for README.md" }));
    await waitFor(() => expect(document.querySelector(".http-delivery-count")?.textContent).toBe("0/5"));
    expect(screen.getByText("No active files")).toBeTruthy();
  });

  it("falls back to the item link when HTTP Delivery popup opening is blocked", async () => {
    windowOpenMock.mockReturnValueOnce(null);

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Start HTTP Delivery" }));
    await waitFor(() => expect(document.querySelector(".http-delivery-count")?.textContent).toBe("1/5"));
    expect(windowOpenMock).toHaveBeenCalledTimes(1);
    expect(openedHttpDeliveryTabs).toHaveLength(0);
    expect(screen.getByRole("link", { name: "README.md" }).getAttribute("href")).toBe("/delivery/item-1/README.md");
    expect(document.querySelector(".http-delivery-status.error")).toBeNull();
  });

  it("renders image and PDF previews while unsupported files show metadata", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "image.png" }));
    await waitFor(() => expect(document.querySelector(".image-viewer")?.getAttribute("src")).toContain("/api/image"));
    expect(screen.queryByRole("heading", { name: "Binary file" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "paper.pdf" }));
    await waitFor(() => expect(document.querySelector(".pdf-frame")?.getAttribute("src")).toContain("/api/pdf"));
    expect(screen.queryByRole("heading", { name: "Binary file" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "archive.zip" }));
    expect(await screen.findByRole("heading", { name: "File type is not displayed" })).toBeTruthy();
    expect(screen.getByText("Viewer state")).toBeTruthy();
    expect(screen.getAllByText("Unsupported").length).toBeGreaterThan(0);
  });

  it("copies and wraps rendered markdown code blocks", async () => {
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: clipboardWrite }, configurable: true });

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy code block" }));
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith("pnpm test"));

    const wrapButton = screen.getByRole("button", { name: "Wrap code block" });
    fireEvent.click(wrapButton);
    expect(wrapButton.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".markdown-code-block")?.classList.contains("wrapped")).toBe(true);
  });

  it("provides item memo render, icon actions, copy, download, and delete while keeping AI Chat separate", async () => {
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: clipboardWrite }, configurable: true });
    const createObjectURL = vi.fn(() => "blob:reader-wiki-memo");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, configurable: true });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "AI Chat" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Memo" }));
    const memo = screen.getByLabelText("Session memo") as HTMLTextAreaElement;
    const memoContent = "# Scratch\n\n- [x] Review this section\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```js\nconsole.log(1)\n```";
    fireEvent.change(memo, { target: { value: memoContent } });
    expect(memo.value).toBe(memoContent);

    fireEvent.click(screen.getByRole("button", { name: "Render" }));
    expect(screen.getByRole("heading", { name: "Scratch" })).toBeTruthy();
    expect(screen.getByText("Review this section")).toBeTruthy();
    const memoPreview = screen.getByLabelText("Memo preview");
    expect(within(memoPreview).getByRole("checkbox", { name: "completed task" })).toBeTruthy();
    expect(memoPreview.querySelector(".markdown-table-scroll")).toBeTruthy();
    expect(within(memoPreview).getByRole("button", { name: "Copy code block" })).toBeTruthy();
    expect(within(memoPreview).getByRole("button", { name: "Wrap code block" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Copy memo" }));
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith(memoContent));

    fireEvent.click(screen.getByRole("button", { name: "Download memo" }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(anchorClick).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Delete memo" }));
    expect(screen.getByText("No memo yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    expect((screen.getByLabelText("Session memo") as HTMLTextAreaElement).value).toBe("");
    expect(Array.from(document.querySelectorAll(".memo-icon-button")).every((button) => button.textContent === "")).toBe(true);
  });

  it("opens Settings from the dedicated sidebar zone and returns without losing viewer state", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Memo" }));
    fireEvent.change(screen.getByLabelText("Session memo"), { target: { value: "keep this memo" } });

    fireEvent.click(openSettingsButton());
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Basic" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Repositories" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "AI Chat" })).toBeTruthy();
    expect(document.querySelector(".settings-shell")).toBeTruthy();
    expect(document.querySelector(".settings-shell")?.getAttribute("data-color-mode")).toBe("light");
    expect(document.querySelector(".settings-rail")).toBeTruthy();
    expect(document.querySelector(".settings-main")).toBeTruthy();
    expect(document.querySelector(".sidebar-settings-zone")).toBeNull();
    expect(screen.queryByRole("button", { name: "System" })).toBeNull();
    expect(screen.queryByText("Future")).toBeNull();
    expect((screen.getByRole("button", { name: "Light" }) as HTMLButtonElement).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByRole("button", { name: "Dark" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getAllByText("Saved in this browser.").length).toBeGreaterThan(0);
    expect(screen.queryByText("Display")).toBeNull();
    expect(screen.queryByText("Wiki display options")).toBeNull();
    expect(screen.queryByText("Show page outline")).toBeNull();
    expect(screen.queryByText("Show source metadata")).toBeNull();
    expect(screen.queryByText("Displays heading navigation in the right panel when the active file has markdown headings.")).toBeNull();

    expect((screen.getByRole("button", { name: "×1" }) as HTMLButtonElement).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "×1.5" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "×2" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Comfortable" }) as HTMLButtonElement).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Compact" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Focused" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Dark" }));
    expect((screen.getByRole("button", { name: "Dark" }) as HTMLButtonElement).getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".settings-shell")?.getAttribute("data-color-mode")).toBe("dark");

    fireEvent.click(screen.getByRole("button", { name: "×2" }));
    fireEvent.click(screen.getByRole("button", { name: "Compact" }));
    expect((screen.getByRole("button", { name: "Compact" }) as HTMLButtonElement).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    expect(document.querySelector(".app-shell")?.getAttribute("data-color-mode")).toBe("dark");
    expect(document.querySelector(".app-shell")?.className).toContain("color-dark");
    expect(document.querySelector(".app-shell")?.className).toContain("layout-compact");
    expect(document.querySelector(".app-shell")?.className).not.toContain("font-");
    const storedCompactSettings = JSON.parse(window.localStorage.getItem("readerWiki.basicSettings.v1") || "{}") as Record<string, unknown>;
    expect(storedCompactSettings.layout).toBe("compact");
    expect(storedCompactSettings.readerFontScale).toBe(2);
    expect(storedCompactSettings.colorMode).toBe("dark");
    const viewerBody = document.querySelector(".viewer-body") as HTMLElement | null;
    expect(viewerBody?.style.getPropertyValue("--reader-font-scale")).toBe("2");
    expect(viewerBody?.style.getPropertyValue("--reader-body-font-size")).toBe("32px");
    expect(viewerBody?.style.getPropertyValue("--reader-h1-font-size")).toBe("60px");
    expect(viewerBody?.style.getPropertyValue("--reader-code-font-size")).toBe("26px");
    expect((document.querySelector(".sidebar") as HTMLElement | null)?.getAttribute("style") || "").not.toContain("--reader-");
    expect((document.querySelector(".right-panel") as HTMLElement | null)?.getAttribute("style") || "").not.toContain("--reader-");

    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(await screen.findByLabelText("Source")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "api.ts" }));
    expect(await screen.findByLabelText("Raw")).toBeTruthy();
    expect(cssRule(".code-viewer")).toContain("font-size: var(--reader-code-font-size, 13px);");

    fireEvent.click(openSettingsButton());
    expect((screen.getByRole("button", { name: "×2" }) as HTMLButtonElement).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByRole("button", { name: "Dark" }) as HTMLButtonElement).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByRole("button", { name: "Compact" }) as HTMLButtonElement).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Focused" }));
    expect((screen.getByRole("button", { name: "Focused" }) as HTMLButtonElement).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Light" }));
    expect(document.querySelector(".settings-shell")?.getAttribute("data-color-mode")).toBe("light");
    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    expect(await screen.findByLabelText("Raw")).toBeTruthy();
    expect(document.querySelector(".app-shell")?.getAttribute("data-color-mode")).toBe("light");
    expect(document.querySelector(".app-shell")?.className).toContain("layout-focused");
    expect(document.querySelector(".app-shell")?.className).not.toContain("font-");
    const storedFocusedSettings = JSON.parse(window.localStorage.getItem("readerWiki.basicSettings.v1") || "{}") as Record<string, unknown>;
    expect(storedFocusedSettings.layout).toBe("focused");
    fireEvent.click(screen.getByRole("tab", { name: "Memo" }));
    expect((screen.getByLabelText("Session memo") as HTMLTextAreaElement).value).toBe("keep this memo");
  });

  it("injects reader font scale and color mode into sandboxed HTML file view documents", () => {
    expect(buildSandboxedHtmlSrcDoc("<html><head><title>Doc</title></head><body>Hi</body></html>", 1.5)).toContain(
      ":root { color-scheme: light; font-size: 24px;",
    );
    expect(buildSandboxedHtmlSrcDoc("<h1>Hi</h1>", 2, "dark")).toContain(
      '<head><style>:root { color-scheme: dark; font-size: 32px; color: #e6edf0; background: #10181c; } body { background: #10181c; color: #e6edf0; font-size: 1rem; }',
    );
  });

  it("shows real repository config state, validates, previews YAML, and saves from Settings", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(openSettingsButton());
    fireEvent.click(await screen.findByRole("tab", { name: "Repositories" }));

    expect(screen.getByText("Docs")).toBeTruthy();
    expect(screen.getByText("/tmp/docs")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Repository config" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Repository entry checks" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Config checks" })).toBeNull();

    const rowDetails = screen.getByLabelText("Docs details") as HTMLDetailsElement;
    expect(rowDetails.open).toBe(false);
    fireEvent.click(within(rowDetails).getByText("Details"));
    expect(rowDetails.open).toBe(true);
    expect(screen.getByText("README.md")).toBeTruthy();

    const advancedOptions = screen.getByLabelText("Advanced repository options") as HTMLDetailsElement;
    expect(advancedOptions.open).toBe(false);
    fireEvent.click(within(advancedOptions).getByText("Advanced repository options"));
    expect(advancedOptions.open).toBe(true);
    expect(screen.getByText(".git")).toBeTruthy();
    expect(screen.getByText("node_modules")).toBeTruthy();

    const configDetails = screen.getByLabelText("Config details") as HTMLDetailsElement;
    expect(configDetails.open).toBe(false);
    fireEvent.click(within(configDetails).getByText("Config details"));
    expect(configDetails.open).toBe(true);
    expect(screen.getByText("/tmp/reader-wiki/repositories.yaml")).toBeTruthy();
    expect(screen.getByText("Default repositories.yaml")).toBeTruthy();

    const validationDetails = screen.getByLabelText("Validation details") as HTMLDetailsElement;
    expect(validationDetails.open).toBe(false);
    fireEvent.click(within(validationDetails).getByText("Validation details"));
    expect(validationDetails.open).toBe(true);
    fireEvent.click(within(validationDetails).getByRole("button", { name: "Validate config" }));
    expect(await screen.findByText("docs root is absolute path")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Preview YAML" })[0]);
    const yamlDetails = await screen.findByLabelText("YAML preview") as HTMLDetailsElement;
    expect(yamlDetails.open).toBe(true);
    expect(await screen.findByLabelText("Generated YAML preview")).toBeTruthy();
    expect((await screen.findAllByText("Repository config is valid.")).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "Docs updated" } });
    expect(screen.getAllByText("Unsaved").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Save config" }));
    expect((await screen.findAllByText("Repository config saved.")).length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledWith("/api/repository-config/save", expect.objectContaining({ method: "POST" }));
  });

  it("adds AI Chat as a read-only right panel and can answer after provider settings are configured", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "AI Chat" }));
    expect(screen.getByText("AI Entry is required.")).toBeTruthy();
    expect(screen.queryByText("Read-only context")).toBeNull();
    expect(screen.queryByText("Ask about the active file. Reader-Wiki sends read-only context only.")).toBeNull();
    expect(screen.queryByLabelText("AI Chat message")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send AI Chat message" })).toBeNull();
    fireEvent.click(openSettingsButton());
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "AI Chat" }));
    expect(screen.queryByRole("heading", { name: "AI Chat behavior" })).toBeNull();
    expect(screen.queryByLabelText("Right panel preview")).toBeNull();
    expect(screen.queryByText("Only one AI Entry can be active at a time")).toBeNull();
    expect(screen.queryByText("Outline / Memo / AI Chat")).toBeNull();
    expect(screen.queryByText("Explain the active file.")).toBeNull();
    expect(screen.queryByText("Select an AI Entry before sending.")).toBeNull();
    const aiEntryHeading = screen.getByRole("heading", { name: "AI Entry" });
    const accessHeading = screen.getByRole("heading", { name: "Access policy" });
    expect(aiEntryHeading.compareDocumentPosition(accessHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Connection / Credentials" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Readiness diagnostics" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Test connection" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Check readiness" })).toBeNull();
    expect(screen.queryByText("Authenticate")).toBeNull();
    expect(screen.getAllByText("No active AI Entry").length).toBeGreaterThan(0);

    const aiApiEntry = screen.getByLabelText("AI API entry");
    const localAiEntry = screen.getByLabelText("Local AI entry");
    const codexCliEntry = screen.getByLabelText(["Co", "dex CLI entry"].join(""));
    const claudeCodeEntry = screen.getByLabelText("Claude Code CLI entry");
    expect(codexCliEntry).toBeTruthy();
    expect(claudeCodeEntry).toBeTruthy();
    expect(within(codexCliEntry).getAllByText(["Co", "dex CLI"].join(""))).toHaveLength(1);
    expect(within(claudeCodeEntry).getAllByText("Claude Code CLI")).toHaveLength(1);
    expect(within(aiApiEntry).getAllByText("AI API")).toHaveLength(1);
    expect(within(localAiEntry).getAllByText("Local AI")).toHaveLength(1);
    expect(within(codexCliEntry).getAllByText("Not checked").length).toBeGreaterThan(0);
    expect(within(claudeCodeEntry).getAllByText("Not checked").length).toBeGreaterThan(0);
    expect(within(aiApiEntry).getAllByText("Needs setup").length).toBeGreaterThan(0);
    expect(within(localAiEntry).getAllByText("Needs setup").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Set active" })).toHaveLength(4);
    expect(screen.queryByLabelText("AI API connection")).toBeNull();
    expect(screen.queryByLabelText("Local AI connection")).toBeNull();
    expect(fetchCallsTo("/api/ai/test-connection")).toHaveLength(0);
    expect(fetchCallsTo("/api/ai/entry-readiness")).toHaveLength(0);

    const nextAiApiEntry = aiApiEntry;
    fireEvent.click(within(nextAiApiEntry).getByRole("button", { name: "Set active" }));
    expect(within(nextAiApiEntry).getByRole("button", { name: "Clear active entry" })).toBeTruthy();
    expect((document.querySelector(".active-entry-summary") as HTMLElement).textContent).toContain("This entry is selected for AI Chat.");
    expect(within(nextAiApiEntry).queryByText("Enter the API credential for this provider.")).toBeNull();
    expect(fetchCallsTo("/api/ai/test-connection")).toHaveLength(0);
    expect(fetchCallsTo("/api/ai/entry-readiness")).toHaveLength(0);
    const connectionHeading = screen.getByRole("heading", { name: "Connection / Credentials" });
    expect(aiEntryHeading.compareDocumentPosition(connectionHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(connectionHeading.compareDocumentPosition(accessHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const nextAiApiAuth = screen.getByLabelText("AI API connection");
    expect(screen.queryByText("Adapter")).toBeNull();
    expect(screen.queryByText("File operations")).toBeNull();
    expect(screen.queryByText("Model candidates")).toBeNull();
    expect(screen.queryByText("Test active entry")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Readiness diagnostics" })).toBeNull();
    const aiApiDetails = screen.getByLabelText("AI API readiness details") as HTMLDetailsElement;
    expect(aiApiDetails.open).toBe(false);
    expect(within(aiApiDetails).getByLabelText("Readiness checklist").textContent).toContain("Next action");
    expect((within(nextAiApiAuth).getByRole("button", { name: "Test connection" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(within(nextAiApiAuth).getByLabelText("API key"), { target: { value: "local-test-key" } });
    expect(document.body.textContent || "").not.toContain("local-test-key");
    expect(within(nextAiApiAuth).getByText("********")).toBeTruthy();
    expect((within(nextAiApiAuth).getByRole("button", { name: "Clear key" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(within(nextAiApiAuth).getByRole("button", { name: "Clear key" }));
    expect((within(nextAiApiAuth).getByRole("button", { name: "Test connection" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(within(nextAiApiAuth).getByLabelText("API key"), { target: { value: "local-test-key" } });
    fireEvent.change(within(nextAiApiAuth).getByLabelText("Provider"), { target: { value: "openaiCompatible" } });
    expect(within(nextAiApiAuth).getByText("Endpoint settings")).toBeTruthy();
    expect(within(nextAiApiAuth).getByLabelText("Base URL")).toBeTruthy();
    expect(within(nextAiApiAuth).queryByText("Model candidates")).toBeNull();
    fireEvent.change(within(nextAiApiAuth).getByLabelText("Model"), { target: { value: "model-a" } });
    fireEvent.change(within(nextAiApiAuth).getByLabelText("Base URL"), { target: { value: "http://127.0.0.1:7777/v1" } });
    expect(fetchCallsTo("/api/ai/test-connection")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    expect(screen.getByText("AI Entry is not ready.")).toBeTruthy();
    expect(screen.queryByLabelText("AI Chat message")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send AI Chat message" })).toBeNull();
    fireEvent.click(openSettingsButton());
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    const testedAiApiAuth = screen.getByLabelText("AI API connection");
    fireEvent.click(within(testedAiApiAuth).getByRole("button", { name: "Test connection" }));
    expect((await screen.findAllByText("Connected.")).length).toBeGreaterThan(0);
    expect(within(testedAiApiAuth).getByRole("button", { name: "Test again" })).toBeTruthy();
    expect((screen.getByLabelText("AI API readiness details") as HTMLDetailsElement).open).toBe(false);
    expect(fetchCallsTo("/api/ai/test-connection")).toHaveLength(1);

    expect(document.querySelectorAll(".toggle-card input")).toHaveLength(0);
    expect(screen.queryByText("Delete warning preview")).toBeNull();
    expect(screen.getByLabelText("Repository Access list").textContent).toContain("Docs");
    expect(screen.queryByLabelText("Configured entries list")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    fireEvent.change(screen.getByLabelText("AI Chat message"), { target: { value: "What does this file say?" } });
    expect((screen.getByRole("button", { name: "Send AI Chat message" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(openSettingsButton());
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    const changedAiApiAuth = screen.getByLabelText("AI API connection");
    fireEvent.change(within(changedAiApiAuth).getByLabelText("Model"), { target: { value: "model-b" } });
    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    expect(screen.getByText("AI Entry is not ready.")).toBeTruthy();
    expect(screen.queryByLabelText("AI Chat message")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send AI Chat message" })).toBeNull();
    fireEvent.click(openSettingsButton());
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    const retestedAiApiAuth = screen.getByLabelText("AI API connection");
    fireEvent.click(within(retestedAiApiAuth).getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Test again")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    fireEvent.change(screen.getByLabelText("AI Chat message"), { target: { value: "What does this file say?" } });
    expect((screen.getByRole("button", { name: "Send AI Chat message" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Send AI Chat message" }));
    expect(await screen.findByText("aiApi says the active file says hello.")).toBeTruthy();
  });

  it("keeps AI Chat session across side panel modes and supports streaming composer actions", async () => {
    const clipboardWrite = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const scrollIntoView = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value: scrollIntoView, configurable: true });

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(openSettingsButton());
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "AI Chat" }));
    const codexEntry = screen.getByLabelText(["Co", "dex CLI entry"].join(""));
    fireEvent.click(within(codexEntry).getByRole("button", { name: "Set active" }));
    const codexAuth = screen.getByLabelText(["Co", "dex CLI readiness"].join(""));
    expect(fetchCallsTo("/api/ai/entry-readiness")).toHaveLength(1);
    await waitFor(() => expect(within(codexAuth).getByRole("button", { name: "Check again" })).toBeTruthy());
    expect(within(codexAuth).getByText("Ready to use for AI Chat.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    const messageInput = screen.getByLabelText("AI Chat message") as HTMLTextAreaElement;
    const aiChatPanel = screen.getByLabelText("AI Chat");
    expect(aiChatPanel.querySelector(".ai-chat-status")).toBeNull();
    expect(within(aiChatPanel).queryByText("Codex CLI")).toBeNull();
    expect(within(aiChatPanel).queryByText("codex / medium")).toBeNull();
    const actionRailLabels = Array.from(aiChatPanel.querySelectorAll(".ai-chat-action-rail button")).map((button) => button.getAttribute("aria-label"));
    expect(actionRailLabels).toEqual(["Upload file", "Voice input", "Send AI Chat message"]);
    fireEvent.change(messageInput, { target: { value: "Draft" } });
    fireEvent.click(screen.getByRole("tab", { name: "Memo" }));
    fireEvent.click(screen.getByRole("tab", { name: "AI Chat" }));
    expect((screen.getByLabelText("AI Chat message") as HTMLTextAreaElement).value).toBe("Draft");

    const newlineInput = screen.getByLabelText("AI Chat message") as HTMLTextAreaElement;
    newlineInput.setSelectionRange(newlineInput.value.length, newlineInput.value.length);
    fireEvent.keyDown(newlineInput, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect((screen.getByLabelText("AI Chat message") as HTMLTextAreaElement).value).toBe("Draft\n"));

    const fileInput = document.querySelector(".ai-chat-composer input[type='file']") as HTMLInputElement;
    const file = new File(["Attached note"], "note.md", { type: "text/markdown" });
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [file] } });
    });
    expect(await screen.findByText("note.md")).toBeTruthy();

    const transcript = screen.getByLabelText("AI Chat transcript") as HTMLDivElement;
    Object.defineProperty(transcript, "scrollHeight", { value: 1200, configurable: true });
    Object.defineProperty(transcript, "clientHeight", { value: 300, configurable: true });
    Object.defineProperty(transcript, "scrollTop", { value: 0, configurable: true });
    fireEvent.scroll(transcript);
    scrollIntoView.mockClear();

    fireEvent.change(screen.getByLabelText("AI Chat message"), { target: { value: "Summarize with attachment." } });
    fireEvent.keyDown(screen.getByLabelText("AI Chat message"), { key: "Enter" });
    expect(await screen.findByText("codexCli says the active file says hello.")).toBeTruthy();
    expect(scrollIntoView).not.toHaveBeenCalled();

    Object.defineProperty(transcript, "scrollTop", { value: 900, configurable: true });
    fireEvent.scroll(transcript);
    fireEvent.change(screen.getByLabelText("AI Chat message"), { target: { value: "Follow up at the bottom." } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Send AI Chat message" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.keyDown(screen.getByLabelText("AI Chat message"), { key: "Enter" });
    await waitFor(() => expect(fetchCallsTo("/api/ai/chat/stream").length).toBeGreaterThan(1));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());

    const streamCalls = fetchCallsTo("/api/ai/chat/stream");
    expect(streamCalls.length).toBeGreaterThan(0);
    const streamBody = parseJsonBody(streamCalls[0]?.[1]?.body);
    expect(streamBody).toMatchObject({
      attachments: [expect.objectContaining({ name: "note.md", contentIncluded: true, content: "Attached note" })],
      modelBehavior: { kind: "intelligence", level: "medium" },
    });

    fireEvent.click(screen.getByRole("tab", { name: "Outline" }));
    fireEvent.click(screen.getByRole("tab", { name: "AI Chat" }));
    expect(screen.getAllByText("codexCli says the active file says hello.").length).toBeGreaterThan(0);
    const userMessage = document.querySelector(".ai-message.user") as HTMLElement;
    const aiMessage = document.querySelector(".ai-message.assistant") as HTMLElement;
    expect(within(userMessage).getByText("You").className).toContain("ai-message-role-chip");
    expect(within(aiMessage).getByText("AI").className).toContain("ai-message-role-chip");
    expect(userMessage.querySelector(".ai-message-footer .ai-message-copy")).toBeTruthy();
    expect(userMessage.querySelector(".ai-message-header .ai-message-copy")).toBeNull();
    expect(aiMessage.querySelector(".ai-message-footer .ai-message-copy")).toBeTruthy();
    expect(aiMessage.querySelector(".ai-message-header .ai-message-copy")).toBeNull();
    expect(aiMessage.querySelector(".task-list-checkbox")).toBeTruthy();
    const aiCodeCopyButton = within(aiMessage).getByRole("button", { name: "Copy code block" }) as HTMLButtonElement;
    const aiCodeWrapButton = within(aiMessage).getByRole("button", { name: "Wrap code block" }) as HTMLButtonElement;
    expect(aiCodeCopyButton.dataset.copyState).toBe("idle");
    expect(aiCodeCopyButton.querySelector(".markdown-code-icon-copy")).toBeTruthy();
    expect(aiCodeCopyButton.querySelector(".markdown-code-icon-check")).toBeTruthy();
    expect(aiCodeWrapButton.dataset.wrapState).toBe("off");
    fireEvent.click(aiCodeCopyButton);
    await waitFor(() => expect(aiCodeCopyButton.dataset.copyState).toBe("copied"));
    expect(clipboardWrite).toHaveBeenCalledWith(expect.stringContaining("const ok = true;"));
    fireEvent.click(within(aiMessage).getByRole("button", { name: "Copy AI message" }));
    expect(clipboardWrite).toHaveBeenCalledWith("codexCli says the active file says hello.\n\n- [x] Render task item\n\n```ts\nconst ok = true;\n```");
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 1900));
    });
    expect(aiCodeCopyButton.dataset.copyState).toBe("idle");
  });

  it("keeps in-flight provider readiness bound to the tested entry and settings snapshot", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(openSettingsButton());
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "AI Chat" }));

    const aiApiEntry = screen.getByLabelText("AI API entry");
    fireEvent.click(within(aiApiEntry).getByRole("button", { name: "Set active" }));
    const aiApiAuth = screen.getByLabelText("AI API connection");
    fireEvent.change(within(aiApiAuth).getByLabelText("API key"), { target: { value: "local-test-key" } });
    fireEvent.change(within(aiApiAuth).getByLabelText("Provider"), { target: { value: "openaiCompatible" } });
    fireEvent.change(within(aiApiAuth).getByLabelText("Model"), { target: { value: "model-a" } });
    fireEvent.change(within(aiApiAuth).getByLabelText("Base URL"), { target: { value: "http://127.0.0.1:7777/v1" } });

    let resolveConnection: ((response: Response) => void) | null = null;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      resolveConnection = resolve;
    }));
    fireEvent.click(within(aiApiAuth).getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(resolveConnection).not.toBeNull());
    fireEvent.change(within(aiApiAuth).getByLabelText("Model"), { target: { value: "model-b" } });

    const claudeEntry = screen.getByLabelText("Claude Code CLI entry");
    fireEvent.click(within(claudeEntry).getByRole("button", { name: "Set active" }));
    expect(screen.getByLabelText("Claude Code CLI readiness")).toBeTruthy();
    expect(screen.queryByLabelText("AI API connection")).toBeNull();

    await act(async () => {
      resolveConnection?.(json({ state: "ready", code: "success", severity: "success", message: "Connected.", nextAction: "This entry is ready for read-only AI Chat.", checkedAt: "2026-07-03T00:00:00.000Z" }));
    });

    expect(screen.getByLabelText("Claude Code CLI readiness")).toBeTruthy();
    expect(screen.queryByLabelText("AI API connection")).toBeNull();
    expect(within(screen.getByLabelText("AI API entry")).queryByText("Connected")).toBeNull();
    expect(within(screen.getByLabelText("AI API entry")).getAllByText("Needs test").length).toBeGreaterThan(0);
  });

  it("enables CLI AI Chat after entry readiness succeeds", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(openSettingsButton());
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "AI Chat" }));

    const codexEntryLabel = ["Co", "dex CLI entry"].join("");
    const codexAuthLabel = ["Co", "dex CLI readiness"].join("");
    const codexEntry = screen.getByLabelText(codexEntryLabel);
    fireEvent.click(within(codexEntry).getByRole("button", { name: "Set active" }));
    const codexAuth = screen.getByLabelText(codexAuthLabel);
    expect(fetchCallsTo("/api/ai/entry-readiness")).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "CLI Readiness" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Connection / Credentials" })).toBeNull();
    expect(within(codexAuth).getAllByText("Not checked").length).toBeGreaterThan(0);
    expect(within(codexAuth).getByText("Check the installed CLI and existing sign-in state.")).toBeTruthy();
    const codexDetailsBefore = screen.getByLabelText(["Co", "dex CLI readiness details"].join("")) as HTMLDetailsElement;
    expect(codexDetailsBefore.open).toBe(false);
    expect(within(codexDetailsBefore).getByLabelText("Readiness checklist").textContent).toContain("Binary");
    expect(within(codexDetailsBefore).getByLabelText("Readiness checklist").textContent).toContain("Version");
    expect(within(codexDetailsBefore).getByLabelText("Readiness checklist").textContent).toContain("Existing sign-in");
    expect(within(codexDetailsBefore).getByLabelText("Readiness checklist").textContent).toContain("Read-only wrapper");
    expect(within(codexDetailsBefore).getByLabelText("Readiness checklist").textContent).toContain("Execution mode");
    expect(within(codexDetailsBefore).getByLabelText("Readiness checklist").textContent).toContain("Last check");
    await waitFor(() => expect(within(codexAuth).getByRole("button", { name: "Check again" })).toBeTruthy());
    expect(within(codexAuth).getAllByText("Success").length).toBeGreaterThan(0);
    expect(within(codexAuth).getByText("Ready to use for AI Chat.")).toBeTruthy();
    expect(within(codexAuth).getByRole("button", { name: "Check again" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    fireEvent.change(screen.getByLabelText("AI Chat message"), { target: { value: "Summarize through CLI." } });
    expect((screen.getByRole("button", { name: "Send AI Chat message" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Send AI Chat message" }));
    expect(await screen.findByText("codexCli says the active file says hello.")).toBeTruthy();

    fireEvent.click(openSettingsButton());
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    const claudeEntry = screen.getByLabelText("Claude Code CLI entry");
    fireEvent.click(within(claudeEntry).getByRole("button", { name: "Set active" }));
    let claudeAuth = screen.getByLabelText("Claude Code CLI readiness");
    expect(screen.queryByText("Authenticate")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Readiness diagnostics" })).toBeNull();
    expect(screen.getByRole("heading", { name: "CLI Readiness" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Connection / Credentials" })).toBeNull();
    expect(screen.queryByText("Test active entry")).toBeNull();
    expect((screen.getByLabelText("Claude Code CLI readiness details") as HTMLDetailsElement).open).toBe(false);
    expect(fetchCallsTo("/api/ai/entry-readiness")).toHaveLength(2);
    await waitFor(() => expect(within(claudeAuth).getByRole("button", { name: "Check again" })).toBeTruthy());
    expect(within(claudeAuth).getByText("Ready to use for AI Chat.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    fireEvent.change(screen.getByLabelText("AI Chat message"), { target: { value: "Summarize through other CLI." } });
    expect((screen.getByRole("button", { name: "Send AI Chat message" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Send AI Chat message" }));
    expect(await screen.findByText("claudeCli says the active file says hello.")).toBeTruthy();
  });

});

function createMockOpenedTab(): MockOpenedTab {
  const tab: MockOpenedTab = {
    location: { href: "about:blank" },
    close: vi.fn(),
    closed: false,
    opener: {},
  };
  tab.close.mockImplementation(() => {
    tab.closed = true;
  });
  openedHttpDeliveryTabs.push(tab);
  return tab;
}

function openSettingsButton(): HTMLElement {
  const buttons = screen.getAllByRole("button", { name: "Open Settings" });
  return buttons[buttons.length - 1] as HTMLElement;
}

function fileTabTitles(): string[] {
  return Array.from(document.querySelectorAll(".file-tab-title")).map((node) => node.textContent || "");
}

function fileTab(title: string): HTMLElement {
  const titleNode = Array.from(document.querySelectorAll(".file-tab-title")).find((node) => node.textContent === title);
  const tab = titleNode?.closest(".file-tab") as HTMLElement | null;
  expect(tab).toBeTruthy();
  return tab as HTMLElement;
}

function fileForPath(path: string, repoId = "docs") {
  if (path === "ALT.md") {
    const content = "# Alt\n\nAlternate repository\n";
    return {
      repoId,
      path,
      name: "ALT.md",
      extension: ".md",
      kind: "markdown",
      content,
      lineCount: content.split("\n").length,
      fileInfo: fileInfo(path, "Markdown", content),
      markdown: {
        frontmatter: "",
        body: content,
        html: renderedMarkdownHtml("Alt"),
      },
    };
  }
  if (path === "image.png") {
    return {
      repoId,
      path,
      name: "image.png",
      extension: ".png",
      kind: "image",
      assetVersion: "10",
      fileInfo: metadataInfo(path, "Image", 10, "displayable", "image/png"),
    };
  }
  if (path === "paper.pdf") {
    return {
      repoId,
      path,
      name: "paper.pdf",
      extension: ".pdf",
      kind: "pdf",
      assetVersion: "20",
      fileInfo: metadataInfo(path, "PDF", 20, "displayable", "application/pdf"),
    };
  }
  if (path === "archive.zip") {
    return {
      repoId,
      path,
      name: "archive.zip",
      extension: ".zip",
      kind: "unsupported",
      content: "",
      lineCount: 0,
      fileInfo: metadataInfo(path, "Unsupported", 4, "unsupported", "application/zip"),
    };
  }
  if (path === "api.ts") {
    const content = "export function read() {\\n  return true;\\n}\\n";
    return { repoId, path, name: "api.ts", extension: ".ts", kind: "code", content, lineCount: 3, fileInfo: fileInfo(path, "Code", content) };
  }
  if (path === "notes.txt") {
    const content = "plain notes\\n";
    return { repoId, path, name: "notes.txt", extension: ".txt", kind: "text", content, lineCount: 1, fileInfo: fileInfo(path, "Text", content) };
  }
  if (path === "page.html") {
    const content = "<!doctype html><h1>HTML Page</h1>";
    return { repoId, path, name: "page.html", extension: ".html", kind: "html", content, lineCount: 1, fileInfo: fileInfo(path, "HTML", content) };
  }
  const title = path === "guide.md" ? "Guide" : path === "extra.md" ? "Extra" : path === "docs/inside.md" ? "Inside" : "Hello";
  const body = [`# ${title}`, "", "## Intro", "", "| Name | Value |", "| --- | --- |", "| Test | 1 |", "", "```bash", "pnpm test", "```", ""].join("\n");
  const isReadme = path === "README.md";
  return {
    repoId,
    path,
    name: path.split("/").pop() || path,
    extension: ".md",
    kind: "markdown",
    content: body,
    lineCount: body.split("\\n").length,
    fileInfo: fileInfo(path, "Markdown", body, isReadme ? "changed" : undefined),
    ...(isReadme ? { gitDiff: { status: "changed", changedLines: [1] } } : {}),
    markdown: {
      frontmatter: "",
      body,
      html: renderedMarkdownHtml(title),
    },
  };
}

function renderedMarkdownHtml(title: string): string {
  return [
    `<h1>${title}</h1>`,
    "<h2>Intro</h2>",
    '<div class="markdown-table-scroll" data-reader-wiki-table-scroll="true"><table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>Test</td><td>1</td></tr></tbody></table></div>',
    '<div class="markdown-code-block" data-reader-wiki-code-block="true">',
    '<div class="markdown-code-block-toolbar">',
    '<button type="button" class="markdown-code-action-button markdown-code-copy-button" data-copy-state="idle" aria-label="Copy code block" title="Copy code block"></button>',
    '<button type="button" class="markdown-code-action-button markdown-code-wrap-button" data-wrap-state="off" aria-label="Wrap code block" title="Wrap code block" aria-pressed="false"></button>',
    "</div>",
    "<pre><code>pnpm test</code></pre>",
    "</div>",
  ].join("");
}

function repositoryConfigState() {
  return {
    configPath: "/tmp/reader-wiki/repositories.yaml",
    sourceMode: "default",
    exists: true,
    readable: true,
    writable: true,
    entries: [
      { id: "docs", label: "Docs", root: "/tmp/docs", defaultPath: "README.md", excludes: [".git", "node_modules"], fetchRemote: false },
    ],
    validation: repositoryValidation(),
    yaml: "repositories:\n  - id: docs\n    label: Docs\n    root: /tmp/docs\n",
  };
}

function repositoryValidation() {
  return {
    valid: true,
    checks: [
      { id: "entry:0:id", label: "Docs has an ID", status: "ready", message: "Ready" },
      { id: "entry:0:label", label: "docs has a label", status: "ready", message: "Ready" },
      { id: "entry:0:rootAbsolute", label: "docs root is absolute path", status: "ready", message: "Ready" },
      { id: "entry:0:rootExists", label: "docs root exists", status: "ready", message: "Ready" },
      { id: "entry:0:defaultRelative", label: "docs defaultPath is relative", status: "ready", message: "Ready" },
      { id: "entry:0:defaultInside", label: "docs defaultPath stays inside root", status: "ready", message: "Ready" },
      { id: "entry:0:excludesRelative", label: "docs excludes are repository-relative", status: "ready", message: "Ready" },
      { id: "id:docs:unique", label: "docs ID is unique", status: "ready", message: "Ready" },
      { id: "config:writable", label: "Config file is writable", status: "ready", message: "Ready" },
      { id: "yaml:generated", label: "YAML can be generated", status: "ready", message: "Ready" },
    ],
  };
}

function cliReadiness(entry: string) {
  const codex = entry === "codexCli";
  return {
    entry,
    ready: true,
    status: {
      state: "ready",
      message: codex ? ["Co", "dex CLI read-only wrapper is ready."].join("") : "Claude Code CLI read-only wrapper is ready.",
      checkedAt: "2026-07-03T00:00:00.000Z",
    },
    settings: {
      entry,
      binaryName: codex ? "codex" : "claude",
      version: codex ? "codex-cli 0.142.5" : "2.1.199",
      authState: "configured",
      readOnlyWrapperState: "ready",
      executionMode: "readOnly",
      lastCheckedAt: "2026-07-03T00:00:00.000Z",
      readinessMessage: codex ? ["Co", "dex CLI read-only wrapper is ready."].join("") : "Claude Code CLI read-only wrapper is ready.",
    },
    checks: [
      { id: "binary", label: "Binary", status: "ready", message: "Ready" },
      { id: "auth", label: "Existing CLI auth", status: "ready", message: "Ready" },
      { id: "wrapper", label: "Read-only wrapper", status: "ready", message: "Ready" },
    ],
  };
}

function fileInfo(path: string, type: string, content: string, gitStatus?: "new" | "changed" | "deleted") {
  return {
    name: path.split("/").pop() || path,
    path,
    type,
    byteLength: content.length,
    characterCount: content.length,
    lineCount: content.split("\\n").length,
    createdAt: "2026-06-30T00:00:00.000Z",
    ...(gitStatus ? { gitStatus } : {}),
    viewerStatus: "displayable",
  };
}

function metadataInfo(path: string, type: string, byteLength: number, viewerStatus: "displayable" | "unsupported", mimeType: string) {
  return {
    name: path.split("/").pop() || path,
    path,
    type,
    mimeType,
    byteLength,
    characterCount: 0,
    lineCount: 0,
    createdAt: "2026-06-30T00:00:00.000Z",
    viewerStatus,
  };
}

function parseJsonBody(body: BodyInit | null | undefined): Record<string, unknown> {
  if (typeof body !== "string") return {};
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function streamJsonLines(events: unknown[]): Response {
  return new Response(events.map((event) => JSON.stringify(event)).join("\n") + "\n", {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" },
  });
}
