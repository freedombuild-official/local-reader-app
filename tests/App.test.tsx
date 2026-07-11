import { readFileSync } from "node:fs";
import path from "node:path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, buildSandboxedHtmlSrcDoc } from "../src/App";

const fetchMock = vi.fn<typeof fetch>();
const stylesCss = readFileSync(path.join(process.cwd(), "src/styles.css"), "utf8");
const repoRevisions = { docs: "revision-docs-v1", alt: "revision-alt-v1" } as const;

const treeNodes = [
  { name: "docs", path: "docs", type: "directory", extension: "", gitStatus: "changed" },
  { name: "very-long-directory-name-with-many-segments", path: "very-long-directory-name-with-many-segments", type: "directory", extension: "" },
  { name: "AGENTS.md", path: "AGENTS.md", type: "file", extension: ".md" },
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
      revision: repoId === "alt" ? repoRevisions.alt : repoRevisions.docs,
      sync: { state: "disabled", message: "Git remote fetch disabled.", fetched: false },
      tree: repoId === "alt" ? altTreeSnapshot : treeSnapshot,
      treeTruncated: false,
      treeWarnings: [],
    });
  };
  Object.defineProperty(window, "open", { value: windowOpenMock, configurable: true, writable: true });
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "/api/repos") {
      return json({
        repositories: [
          { id: "docs", label: "Docs", root: "/tmp/docs", defaultPath: "README.md", exists: true, revision: repoRevisions.docs },
          { id: "alt", label: "Alt", root: "/tmp/alt", defaultPath: "ALT.md", exists: true, revision: repoRevisions.alt },
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
      return json({ state: "ready", code: "success", severity: "success", message: "Connected.", nextAction: "Run AI Entry readiness to confirm Codex-backed write mode.", checkedAt: "2026-07-03T00:00:00.000Z" });
    }
    if (url === "/api/ai/entry-readiness") {
      const body = parseJsonBody(init?.body) as { entry?: string; provider?: Record<string, unknown> };
      return json(aiEntryReadiness(String(body.entry || "codexCli"), body.provider));
    }
    if (url === "/api/ai/chat" || url === "/api/ai/chat/stream") {
      const body = parseJsonBody(init?.body) as { target?: { kind?: string; entry?: string; provider?: { entry?: string } }; provider?: { entry?: string }; messages?: Array<{ content?: string }> };
      const target = body.target?.entry || body.target?.provider?.entry || body.provider?.entry || body.target?.kind || "provider";
      const hasDuplicateCheck = (body.messages || []).some((message) => (message.content || "").toLowerCase().includes("duplicate"));
      const hasUnverifiedAudit = (body.messages || []).some((message) => (message.content || "").toLowerCase().includes("unverified audit"));
      const codeBlock = "```ts\nconst ok = true;\n```";
      const content = `${target} says the active file says hello.\n\n- [x] Render task item\n\n${codeBlock}`;
      const run = {
        accessMode: "repoWrite",
        entry: target,
        substrate: target === "claudeCli" ? "claudeCli" : "codexCli",
        auditState: hasUnverifiedAudit ? "unverified" : "verified",
        changedPaths: hasUnverifiedAudit ? [] : [{ path: "README.md", status: "changed" }],
        repairs: [],
        warnings: hasUnverifiedAudit
          ? ["Repository changes are unverified because the bounded workspace audit was incomplete."]
          : hasDuplicateCheck
            ? ["Duplicate edit detected in README.md: repeated block \"## Write Result 2\"."]
            : [],
      };
      const payload = {
        message: { role: "assistant", content },
        context: { repoId: "docs", systemPromptVersion: "1.0.0", primaryItems: [{ repoId: "docs", role: "primary", source: "manual", path: "README.md", name: "README.md", kind: "file", fileKind: "markdown", viewerStatus: "displayable", lineCount: 12, byteLength: 120, contentIncluded: true, content: "# Hello" }], ruleItems: [] },
        status: { state: "ready", message: "Response received.", checkedAt: "2026-07-03T00:00:00.000Z" },
        run,
      };
      if (url === "/api/ai/chat/stream") {
        return streamJsonLines([
          { type: "meta", runId: "test-run-id", context: payload.context },
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
      if (repoId === "alt") return json({ revision: repoRevisions.alt, nodes: path ? [] : altTreeNodes });
      return json({ revision: repoRevisions.docs, nodes: path === "docs" ? docsTreeNodes : treeNodes });
    }
    if (url.startsWith("/api/file")) {
      const query = new URL(`http://local${url}`).searchParams;
      const repoId = query.get("repo") || "docs";
      const path = query.get("path") || "README.md";
      return json({ ...fileForPath(path, repoId), revision: repoId === "alt" ? repoRevisions.alt : repoRevisions.docs });
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
  it("has no serious or critical axe violations on the main viewer", async () => {
    const { container } = render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    await expectNoSeriousAxeViolations(container);

    fireEvent.click(openSettingsButton());
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
    await expectNoSeriousAxeViolations(container);
    fireEvent.click(screen.getByRole("tab", { name: "AI Chat" }));
    expect(await screen.findByRole("heading", { name: "AI Chat Settings" })).toBeTruthy();
    await expectNoSeriousAxeViolations(container);

    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    expect(await screen.findByText("AI Entry is required.")).toBeTruthy();
    await expectNoSeriousAxeViolations(container);
  });

  it("loads repositories, tree, default markdown, and the outline panel", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Reader-Wiki" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "README.md" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    expect(document.querySelector(".viewer-header h2")?.textContent).toBe("README.md");
    expect(document.querySelector(".viewer-path-text")?.textContent).toBe("README.md");
    const toolbarActions = document.querySelector(".viewer-toolbar-actions") as HTMLElement;
    expect(toolbarActions).toBeTruthy();
    expect(Array.from(toolbarActions.children).map((child) => child.getAttribute("aria-label") || child.textContent)).toEqual([
      "Copy file content",
      "Start HTTP Delivery",
      "View mode",
    ]);
    expect(document.querySelector(".viewer-copy-actions")).toBeNull();
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
    expect(cssRule(".viewer-body")).toContain("overflow-x: hidden;");
    expect(cssRule(".viewer-body")).toContain("overflow-y: auto;");
    expect(cssRule(".viewer-path-line")).toContain("min-width: 0;");
    expect(cssRule(".viewer-path-text")).toContain("text-overflow: ellipsis;");
    expect(cssRule(".viewer-path-text")).toContain("white-space: nowrap;");
    expect(cssRule(".viewer-toolbar-actions")).toContain("flex: 0 0 auto;");
    expect(cssRule(".viewer-toolbar-actions")).toContain("display: inline-flex;");
    expect(cssRule(".side-panel-body")).toContain("padding: var(--rw-side-panel-padding);");
    expect(stylesCss).toContain(".ai-context-chip-list,\n.ai-attachment-list,\n.ai-rule-chip-list {");
    expect(stylesCss).toContain("flex-wrap: nowrap;");
    expect(stylesCss).toContain("overflow-x: auto;");
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
    expect(cssRule(".repo-action-zone")).toContain("position: relative;");
    expect(cssRule(".repo-picker-row")).toContain("display: flex;");
    expect(cssRule(".repo-picker-row .repo-picker")).toContain("min-width: 0;");
    expect(cssRule(".repo-action-button")).toContain("flex: 0 0 auto;");
    expect(cssRule(".http-delivery-popover")).toContain("position: absolute;");
    expect(cssRule(".repo-action-badge")).toContain("position: absolute;");
    expect(document.querySelector(".sidebar-tree-action")).toBeNull();
    expect(Array.from(repoPickerRow.children).map((child) => child.getAttribute("aria-label") || child.id)).toEqual([
      "repo-picker",
      "Reload repository",
      "HTTP Delivery",
      "Collapse all folders",
    ]);
    expect(repoPickerRow.querySelector('[aria-label="Reload repository"]')).toBeTruthy();
    expect(repoPickerRow.querySelector('[aria-label="HTTP Delivery"]')).toBeTruthy();
    expect(repoPickerRow.querySelector('[aria-label="Collapse all folders"]')).toBeTruthy();
    expect(document.querySelector(".viewer-copy-actions")).toBeNull();
    expect(document.querySelector(".viewer-toolbar-actions")?.querySelector('[aria-label="Reload repository"]')).toBeNull();
    expect(document.querySelector(".viewer-toolbar-actions")?.querySelector('[aria-label="HTTP Delivery"]')).toBeNull();
    expect(document.querySelector(".viewer-toolbar-actions")?.querySelector('[aria-label="Collapse all folders"]')).toBeNull();

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
        revision: repoId === "alt" ? repoRevisions.alt : repoRevisions.docs,
        sync: { state: "synced", message: "Git remote metadata fetched.", fetched: true },
        tree: {
          "": [
            ...treeNodes,
            { name: "fresh.md", path: "fresh.md", type: "file", extension: ".md" },
          ],
          docs: docsTreeNodes,
        },
        treeTruncated: false,
        treeWarnings: [],
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
        revision: repoRevisions.alt,
        sync: { state: "synced", message: "Alt metadata fetched.", fetched: true },
        tree: altTreeSnapshot,
        treeTruncated: false,
        treeWarnings: [],
      });
    };

    fireEvent.click(screen.getByRole("button", { name: "Reload repository" }));
    await waitFor(() => expect(resolveReload).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "alt" } });
    expect(await screen.findByRole("heading", { name: "Alt" })).toBeTruthy();

    await act(async () => {
      resolveReload?.(json({
        repoId: "docs",
        revision: repoRevisions.docs,
        sync: { state: "synced", message: "Docs metadata fetched late.", fetched: true },
        tree: {
          "": [
            ...treeNodes,
            { name: "fresh.md", path: "fresh.md", type: "file", extension: ".md" },
          ],
          docs: docsTreeNodes,
        },
        treeTruncated: false,
        treeWarnings: [],
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
        revision: repoRevisions.alt,
        sync: { state: "skipped", message: "Git sync skipped: no remote is configured.", fetched: false },
        tree: altTreeSnapshot,
        treeTruncated: false,
        treeWarnings: [],
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
      revision: repoRevisions.docs,
      sync: { state: "synced", message: "Git remote metadata fetched.", fetched: true },
      tree: treeSnapshot,
      treeTruncated: false,
      treeWarnings: [],
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

  it("exposes directory and Git state and supports keyboard path-menu navigation with focus restore", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();

    const docsRow = screen.getByRole("button", { name: "docs" });
    expect(docsRow.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(docsRow);
    expect(await screen.findByRole("button", { name: "inside.md" })).toBeTruthy();
    expect(docsRow.getAttribute("aria-expanded")).toBe("true");

    const readmeRow = screen.getByRole("button", { name: "README.md" });
    const gitDescriptionId = readmeRow.getAttribute("aria-describedby");
    expect(gitDescriptionId).toBeTruthy();
    expect(document.getElementById(gitDescriptionId || "")?.textContent).toContain("Git status: changed");

    readmeRow.focus();
    fireEvent.contextMenu(readmeRow, { clientX: 32, clientY: 36 });
    const menu = screen.getByRole("menu", { name: "README.md path actions" });
    const copyAbsolute = within(menu).getByRole("menuitem", { name: "Copy Absolute Path" });
    const copyRelative = within(menu).getByRole("menuitem", { name: "Copy Relative Path" });
    const openInNewTab = within(menu).getByRole("menuitem", { name: "Open in New Tab" });
    expect(document.activeElement).toBe(copyAbsolute);

    fireEvent.keyDown(copyAbsolute, { key: "ArrowDown" });
    expect(document.activeElement).toBe(copyRelative);
    fireEvent.keyDown(copyRelative, { key: "End" });
    expect(document.activeElement).toBe(openInNewTab);
    fireEvent.keyDown(openInNewTab, { key: "Home" });
    expect(document.activeElement).toBe(copyAbsolute);
    fireEvent.keyDown(copyAbsolute, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu", { name: "README.md path actions" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(readmeRow));
  });

  it("uses roving file tabs with tabpanel relations and keyboard tab-menu focus management", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.doubleClick(screen.getByRole("tab", { name: "README.md" }));
    fireEvent.click(screen.getByRole("button", { name: "guide.md" }));
    expect(await screen.findByRole("heading", { name: "Guide" })).toBeTruthy();

    const readmeTab = screen.getByRole("tab", { name: "README.md" });
    const guideTab = screen.getByRole("tab", { name: "guide.md" });
    expect(readmeTab.tabIndex).toBe(-1);
    expect(guideTab.tabIndex).toBe(0);
    expect(guideTab.getAttribute("aria-controls")).toBe("reader-file-tabpanel");
    const filePanel = screen.getByRole("tabpanel", { name: "guide.md" });
    expect(filePanel.getAttribute("aria-labelledby")).toBe(guideTab.id);

    guideTab.focus();
    fireEvent.keyDown(guideTab, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(readmeTab);
    expect(readmeTab.getAttribute("aria-selected")).toBe("true");
    expect(readmeTab.tabIndex).toBe(0);
    expect(guideTab.tabIndex).toBe(-1);
    fireEvent.keyDown(readmeTab, { key: "End" });
    expect(document.activeElement).toBe(guideTab);
    expect(guideTab.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(guideTab, { key: "ContextMenu" });
    const tabMenu = screen.getByRole("menu", { name: "guide.md tab actions" });
    const firstAction = within(tabMenu).getByRole("menuitem", { name: "Fix Tab" });
    const pinAction = within(tabMenu).getByRole("menuitem", { name: "Pin" });
    expect(document.activeElement).toBe(firstAction);
    fireEvent.keyDown(firstAction, { key: "ArrowDown" });
    expect(document.activeElement).toBe(pinAction);
    fireEvent.keyDown(pinAction, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu", { name: "guide.md tab actions" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(guideTab));
    fireEvent.keyDown(guideTab, { key: "Delete" });
    await waitFor(() => expect(screen.queryByRole("tab", { name: "guide.md" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(readmeTab));
  });

  it("connects side-panel tabs and panels with roving Arrow/Home/End keyboard behavior", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();

    const outlineTab = screen.getByRole("tab", { name: "Outline" });
    const memoTab = screen.getByRole("tab", { name: "Memo" });
    const aiChatTab = screen.getByRole("tab", { name: "AI Chat" });
    expect(outlineTab.tabIndex).toBe(0);
    expect(memoTab.tabIndex).toBe(-1);
    expect(aiChatTab.tabIndex).toBe(-1);
    expect(screen.getByRole("tabpanel", { name: "Outline" }).getAttribute("aria-labelledby")).toBe(outlineTab.id);

    outlineTab.focus();
    fireEvent.keyDown(outlineTab, { key: "End" });
    expect(document.activeElement).toBe(aiChatTab);
    expect(aiChatTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: "AI Chat" }).getAttribute("aria-labelledby")).toBe(aiChatTab.id);
    fireEvent.keyDown(aiChatTab, { key: "Home" });
    expect(document.activeElement).toBe(outlineTab);
    expect(outlineTab.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(outlineTab, { key: "ArrowRight" });
    expect(document.activeElement).toBe(memoTab);
    expect(memoTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: "Memo" }).getAttribute("aria-labelledby")).toBe(memoTab.id);
    expect(cssRule(".memo-textarea:focus-visible")).toContain("outline: 2px solid #287888;");
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
    fireEvent.click(fileTab("guide.md").querySelector(".file-tab-close") as HTMLElement);
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
    expect(screen.queryByText("AI Entry の認証が必要です")).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Relative Path" }));
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith("docs"));

    fireEvent.contextMenu(screen.getByRole("button", { name: "README.md" }), { clientX: 32, clientY: 36 });
    expect(screen.getByRole("menuitem", { name: "Open in New Tab" })).toBeTruthy();
    expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Copy Absolute Path",
      "Copy Relative Path",
      "Open in New Tab",
      "Send a path to AI Chat",
    ]);
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

  it("opens file tree Open in New Tab as an additional preview tab", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    expect(fileTabTitles()).toEqual(["README.md"]);

    fireEvent.contextMenu(screen.getByRole("button", { name: "guide.md" }), { clientX: 32, clientY: 36 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in New Tab" }));
    expect(await screen.findByRole("heading", { name: "Guide" })).toBeTruthy();
    expect(fileTabTitles()).toEqual(["README.md", "guide.md"]);
    expect(fileTab("guide.md").className).toContain("preview");
    expect(fileTab("guide.md").textContent).toContain("Preview");
    expect(fileTab("guide.md").className).not.toContain("fixed");

    fireEvent.click(screen.getByRole("button", { name: "api.ts" }));
    expect(await screen.findByLabelText("Raw")).toBeTruthy();
    expect(fileTabTitles()).toEqual(["guide.md", "api.ts"]);
    expect(fileTab("api.ts").className).toContain("preview");
  });

  it("starts, reuses, and stops HTTP Delivery from the viewer and tab menu", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    const deliveryControlButton = screen.getByRole("button", { name: "HTTP Delivery" });
    expect(document.querySelector(".http-delivery-count")).toBeNull();
    expect(screen.queryByText("No active files")).toBeNull();
    expect(deliveryControlButton.querySelector(".repo-action-badge")).toBeNull();

    fireEvent.click(deliveryControlButton);
    let deliveryDialog = screen.getByRole("dialog", { name: "HTTP Delivery sessions" });
    expect(within(deliveryDialog).getByText("No active files")).toBeTruthy();
    expect(deliveryDialog.querySelector(".http-delivery-count")?.textContent).toBe("0/5");

    fireEvent.click(document.body);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "HTTP Delivery sessions" })).toBeNull());

    fireEvent.click(deliveryControlButton);
    expect(screen.getByRole("dialog", { name: "HTTP Delivery sessions" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "HTTP Delivery sessions" })).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Start HTTP Delivery" }));
    await waitFor(() => expect(deliveryControlButton.querySelector(".repo-action-badge")?.textContent).toBe("1"));
    expect(windowOpenMock).toHaveBeenCalledWith("about:blank", "_blank");
    await waitFor(() => expect(openedHttpDeliveryTabs[0]?.location.href).toBe("/delivery/item-1/README.md"));

    fireEvent.click(deliveryControlButton);
    deliveryDialog = screen.getByRole("dialog", { name: "HTTP Delivery sessions" });
    expect(deliveryDialog.querySelector(".http-delivery-count")?.textContent).toBe("1/5");
    expect(within(deliveryDialog).getByRole("link", { name: "README.md" }).getAttribute("href")).toBe("/delivery/item-1/README.md");

    fireEvent.contextMenu(screen.getByRole("tab", { name: "README.md" }), { clientX: 80, clientY: 40 });
    const menuItems = within(screen.getByRole("menu")).getAllByRole("menuitem").map((item) => item.textContent);
    expect(menuItems).toEqual(["Fix Tab", "Pin", "HTTP Delivery", "Close"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "HTTP Delivery" }));
    await waitFor(() => expect(httpDeliverySessions).toHaveLength(1));
    expect(windowOpenMock).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(openedHttpDeliveryTabs[1]?.location.href).toBe("/delivery/item-1/README.md"));

    if (!screen.queryByRole("dialog", { name: "HTTP Delivery sessions" })) fireEvent.click(deliveryControlButton);
    deliveryDialog = screen.getByRole("dialog", { name: "HTTP Delivery sessions" });
    fireEvent.click(within(deliveryDialog).getByRole("button", { name: "Stop HTTP Delivery for README.md" }));
    await waitFor(() => expect(deliveryDialog.querySelector(".http-delivery-count")?.textContent).toBe("0/5"));
    expect(within(deliveryDialog).getByText("No active files")).toBeTruthy();
    expect(deliveryControlButton.querySelector(".repo-action-badge")).toBeNull();
  });

  it("falls back to the item link when HTTP Delivery popup opening is blocked", async () => {
    windowOpenMock.mockReturnValueOnce(null);

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Start HTTP Delivery" }));
    const deliveryControlButton = screen.getByRole("button", { name: "HTTP Delivery" });
    await waitFor(() => expect(deliveryControlButton.querySelector(".repo-action-badge")?.textContent).toBe("1"));
    expect(windowOpenMock).toHaveBeenCalledTimes(1);
    expect(openedHttpDeliveryTabs).toHaveLength(0);
    fireEvent.click(deliveryControlButton);
    const deliveryDialog = screen.getByRole("dialog", { name: "HTTP Delivery sessions" });
    expect(within(deliveryDialog).getByRole("link", { name: "README.md" }).getAttribute("href")).toBe("/delivery/item-1/README.md");
    expect(document.querySelector(".http-delivery-status.error")).toBeNull();
  });

  it("renders image and PDF previews while unsupported files show metadata", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "image.png" }));
    await waitFor(() => expect(document.querySelector(".image-viewer")?.getAttribute("src")).toContain("/api/image"));
    expect(cssRule(".image-viewer")).toContain("box-sizing: border-box;");
    expect(cssRule(".image-viewer")).toContain("max-width: 100%;");
    expect(cssRule(".image-viewer")).toContain("height: auto;");
    expect(cssRule(".markdown-body img")).toContain("max-width: 100%;");
    expect(cssRule(".markdown-body img")).toContain("height: auto;");
    expect(cssRule(".markdown-table-scroll")).toContain("overflow-x: auto;");
    expect(cssRule(".code-viewer")).toContain("overflow: auto;");
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
    const memoContent = [
      "---",
      "title: Scratch source",
      "status: draft",
      "---",
      "# Scratch",
      "",
      "- [x] Review this section",
      "",
      "Long link: https://example.com/really/long/path/that/should/not/move/the/memo/preview/horizontally",
      "",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "```js",
      "console.log('a very long memo code line that should wrap inside the preview instead of forcing horizontal movement');",
      "```",
    ].join("\n");
    fireEvent.change(memo, { target: { value: memoContent } });
    expect(memo.value).toBe(memoContent);

    fireEvent.click(screen.getByRole("button", { name: "Render" }));
    expect(screen.getByRole("heading", { name: "Scratch" })).toBeTruthy();
    expect(screen.getByText("Review this section")).toBeTruthy();
    const memoPreview = screen.getByLabelText("Memo preview");
    expect(within(memoPreview).queryByText("title: Scratch source")).toBeNull();
    expect(within(memoPreview).queryByText("status: draft")).toBeNull();
    expect(within(memoPreview).getByRole("checkbox", { name: "completed task" })).toBeTruthy();
    expect(memoPreview.querySelector(".markdown-table-scroll")).toBeTruthy();
    expect(cssRule(".memo-preview")).toContain("overflow-x: hidden;");
    expect(cssRule(".memo-preview .markdown-table-scroll")).toContain("overflow-x: hidden;");
    expect(cssRule(".memo-preview pre")).toContain("white-space: pre-wrap;");
    expect(cssRule(".memo-preview pre code")).toContain("min-width: 0;");
    expect(within(memoPreview).getByRole("button", { name: "Copy code block" })).toBeTruthy();
    expect(within(memoPreview).getByRole("button", { name: "Wrap code block" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    expect((screen.getByLabelText("Session memo") as HTMLTextAreaElement).value).toBe(memoContent);
    fireEvent.click(screen.getByRole("button", { name: "Render" }));

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
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();

    const docsRow = screen.getByRole("button", { name: /Docs docs Root \/tmp\/docs Ready/ });
    expect(docsRow.getAttribute("aria-expanded")).toBe("true");
    const docsEditor = screen.getByLabelText("Docs repository entry");
    expect(within(docsEditor).getByRole("heading", { name: "Repository entry" })).toBeTruthy();

    const repositoryIdInput = within(docsEditor).getByLabelText("Repository ID") as HTMLInputElement;
    repositoryIdInput.focus();
    fireEvent.change(repositoryIdInput, { target: { value: "docs-updated" } });
    expect(document.activeElement).toBe(repositoryIdInput);
    expect(repositoryIdInput.value).toBe("docs-updated");
    fireEvent.change(repositoryIdInput, { target: { value: "docs" } });

    const advancedOptions = within(docsEditor).getByLabelText("Advanced repository options") as HTMLDetailsElement;
    expect(advancedOptions.open).toBe(false);
    fireEvent.click(within(advancedOptions).getByText("Advanced repository options"));
    expect(advancedOptions.open).toBe(true);
    expect((within(advancedOptions).getByLabelText("Default path") as HTMLInputElement).value).toBe("README.md");
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

    fireEvent.click(screen.getByRole("button", { name: "Add repository" }));
    expect(docsRow.getAttribute("aria-expanded")).toBe("false");
    const newEditor = screen.getByLabelText("New repository repository entry");
    expect((within(newEditor).getByLabelText("Repository ID") as HTMLInputElement).value).toBe("new-repo");
    expect((within(newEditor).getByLabelText("Root absolute path") as HTMLInputElement).value).toBe("");
    fireEvent.click(within(newEditor).getByRole("button", { name: "Remove from list" }));
    expect(screen.queryByLabelText("New repository repository entry")).toBeNull();
  });

  it("adds AI Chat as a repo-scoped write panel and can answer after provider readiness is confirmed", async () => {
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
    expect(screen.getByText("CLI Current repo write")).toBeTruthy();
    expect(screen.getByText("Context-only or Current repo write")).toBeTruthy();
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
    expect(fetchCallsTo("/api/ai/entry-readiness")).toHaveLength(1);
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
    expect(within(aiApiDetails).getByText("Endpoint / model check")).toBeTruthy();
    expect(within(aiApiDetails).getByText("Context-only execution")).toBeTruthy();
    expect((await waitForScopedButton(nextAiApiAuth, "Check readiness") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(within(nextAiApiAuth).getByLabelText("API key"), { target: { value: "local-test-key" } });
    expect(document.body.textContent || "").not.toContain("local-test-key");
    expect(within(nextAiApiAuth).getByText("********")).toBeTruthy();
    expect((within(nextAiApiAuth).getByRole("button", { name: "Clear key" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(within(nextAiApiAuth).getByRole("button", { name: "Clear key" }));
    expect((await waitForScopedButton(nextAiApiAuth, "Check readiness") as HTMLButtonElement).disabled).toBe(true);

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
    fireEvent.click(await waitForScopedButton(testedAiApiAuth, "Check readiness"));
    expect((await screen.findAllByText("Connected")).length).toBeGreaterThan(0);
    expect(within(testedAiApiAuth).getByRole("button", { name: "Check again" })).toBeTruthy();
    expect((screen.getByLabelText("AI API readiness details") as HTMLDetailsElement).open).toBe(false);
    expect(fetchCallsTo("/api/ai/test-connection")).toHaveLength(0);
    expect(fetchCallsTo("/api/ai/entry-readiness").length).toBeGreaterThanOrEqual(2);

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
    fireEvent.click(await waitForScopedButton(retestedAiApiAuth, "Check readiness"));
    expect(await screen.findByText("Check again")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    fireEvent.change(screen.getByLabelText("AI Chat message"), { target: { value: "Check duplicate edit." } });
    expect((screen.getByRole("button", { name: "Send AI Chat message" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Send AI Chat message" }));
    expect(await screen.findByText("aiApi says the active file says hello.")).toBeTruthy();
    expect(await screen.findByText("Warnings:")).toBeTruthy();
    await waitFor(() => expect(document.body.textContent || "").toContain("Duplicate edit detected in README.md"));

    fireEvent.change(screen.getByLabelText("AI Chat message"), { target: { value: "Check unverified audit." } });
    fireEvent.click(screen.getByRole("button", { name: "Send AI Chat message" }));
    expect(await screen.findByText("Repository changes unverified.")).toBeTruthy();
    expect(screen.queryByText("No repository changes.")).toBeNull();

    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "alt" } });
    expect(await screen.findByRole("heading", { name: "Alt" })).toBeTruthy();
    expect(screen.getByText("AI Entry is not ready.")).toBeTruthy();
    expect(screen.queryByLabelText("AI Chat message")).toBeNull();
    expect(screen.queryByText("aiApi says the active file says hello.")).toBeNull();
  });

  it("sends an explicit tree path to AI Chat without auto-including the active file", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(openSettingsButton());
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    const aiApiEntry = screen.getByLabelText("AI API entry");
    fireEvent.click(within(aiApiEntry).getByRole("button", { name: "Set active" }));
    const aiApiAuth = screen.getByLabelText("AI API connection");
    fireEvent.change(within(aiApiAuth).getByLabelText("API key"), { target: { value: "local-test-key" } });
    fireEvent.change(within(aiApiAuth).getByLabelText("Provider"), { target: { value: "openaiCompatible" } });
    fireEvent.change(within(aiApiAuth).getByLabelText("Model"), { target: { value: "model-a" } });
    fireEvent.change(within(aiApiAuth).getByLabelText("Base URL"), { target: { value: "http://127.0.0.1:7777/v1" } });
    fireEvent.click(await waitForScopedButton(aiApiAuth, "Check readiness"));
    expect((await screen.findAllByText("Connected")).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.contextMenu(await screen.findByRole("button", { name: "guide.md" }), { clientX: 120, clientY: 120 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Send a path to AI Chat" }));
    const selectedPaths = await screen.findByLabelText("AI Chat selected paths");
    const rules = await screen.findByLabelText("AI Chat rules");
    expect(within(selectedPaths).getByText("guide.md")).toBeTruthy();
    expect(within(rules).getByText("AGENTS.md")).toBeTruthy();

    const fileInput = document.querySelector(".ai-chat-composer input[type='file']") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(fileInput, {
        target: {
          files: [
            new File(["Attached A"], "note-a.md", { type: "text/markdown" }),
            new File(["Attached B"], "note-b.md", { type: "text/markdown" }),
          ],
        },
      });
    });
    const attachments = await screen.findByLabelText("AI Chat attachments");
    expect(Boolean(selectedPaths.compareDocumentPosition(attachments) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(within(attachments).getByText("note-a.md")).toBeTruthy();
    expect(within(attachments).getByText("note-b.md")).toBeTruthy();
    fireEvent.click(within(attachments).getByRole("button", { name: "Remove note-b.md" }));
    expect(within(attachments).queryByText("note-b.md")).toBeNull();

    fireEvent.change(screen.getByLabelText("AI Chat message"), { target: { value: "Summarize selected path." } });
    fireEvent.click(screen.getByRole("button", { name: "Send AI Chat message" }));
    await waitFor(() => expect(fetchCallsTo("/api/ai/chat/stream").length).toBeGreaterThan(0));
    const streamBody = parseJsonBody(fetchCallsTo("/api/ai/chat/stream").at(-1)?.[1]?.body);
    expect(streamBody).toMatchObject({
      context: {
        repoId: "docs",
        primaryPaths: [expect.objectContaining({ path: "guide.md", kind: "file", source: "tree-menu" })],
        rulePaths: [expect.objectContaining({ path: "AGENTS.md", source: "auto-root-rule" })],
      },
      attachments: [expect.objectContaining({ name: "note-a.md", contentIncluded: true, content: "Attached A" })],
    });
    expect(JSON.stringify(streamBody)).not.toContain('"path":"README.md"');
    expect(JSON.stringify(streamBody)).not.toContain("note-b.md");
    await waitFor(() => expect(screen.queryByLabelText("AI Chat selected paths")).toBeNull());
    expect(screen.queryByLabelText("AI Chat attachments")).toBeNull();
    expect(within(screen.getByLabelText("AI Chat rules")).getByText("AGENTS.md")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("AI Chat message"), { target: { value: "Follow-up without selected path." } });
    fireEvent.click(screen.getByRole("button", { name: "Send AI Chat message" }));
    await waitFor(() => expect(fetchCallsTo("/api/ai/chat/stream").length).toBeGreaterThan(1));
    const followUpBody = parseJsonBody(fetchCallsTo("/api/ai/chat/stream").at(-1)?.[1]?.body);
    expect(followUpBody).toMatchObject({
      context: {
        repoId: "docs",
        primaryPaths: [],
        rulePaths: [expect.objectContaining({ path: "AGENTS.md", source: "auto-root-rule" })],
      },
      attachments: [],
    });
    expect(JSON.stringify(followUpBody)).not.toContain("guide.md");
  });

  it("does not restore one-shot selected paths when retrying after a stream error", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(openSettingsButton());
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    const aiApiEntry = screen.getByLabelText("AI API entry");
    fireEvent.click(within(aiApiEntry).getByRole("button", { name: "Set active" }));
    const aiApiAuth = screen.getByLabelText("AI API connection");
    fireEvent.change(within(aiApiAuth).getByLabelText("API key"), { target: { value: "local-test-key" } });
    fireEvent.change(within(aiApiAuth).getByLabelText("Provider"), { target: { value: "openaiCompatible" } });
    fireEvent.change(within(aiApiAuth).getByLabelText("Model"), { target: { value: "model-a" } });
    fireEvent.change(within(aiApiAuth).getByLabelText("Base URL"), { target: { value: "http://127.0.0.1:7777/v1" } });
    fireEvent.click(await waitForScopedButton(aiApiAuth, "Check readiness"));
    expect((await screen.findAllByText("Connected")).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.contextMenu(await screen.findByRole("button", { name: "guide.md" }), { clientX: 120, clientY: 120 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Send a path to AI Chat" }));
    expect(await screen.findByLabelText("AI Chat selected paths")).toBeTruthy();

    const originalFetch = fetchMock.getMockImplementation();
    let failNextStream = true;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/api/ai/chat/stream" && failNextStream) {
        failNextStream = false;
        return streamJsonLines([{ type: "error", error: "planned stream failure" }]);
      }
      return originalFetch ? originalFetch(input, init) : json({ error: "missing fetch" }, 500);
    });

    fireEvent.change(screen.getByLabelText("AI Chat message"), { target: { value: "Summarize selected path." } });
    fireEvent.click(screen.getByRole("button", { name: "Send AI Chat message" }));
    await waitFor(() => expect(screen.getByText("planned stream failure")).toBeTruthy());
    expect(screen.getByText("Request failed before a run summary was available.")).toBeTruthy();
    expect(screen.queryByText("Streaming...")).toBeNull();
    await waitFor(() => expect(screen.queryByLabelText("AI Chat selected paths")).toBeNull());
    const failedBody = parseJsonBody(fetchCallsTo("/api/ai/chat/stream").at(-1)?.[1]?.body);
    expect(failedBody).toMatchObject({
      context: {
        primaryPaths: [expect.objectContaining({ path: "guide.md", source: "tree-menu" })],
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Retry AI Chat request" }));
    await waitFor(() => expect(fetchCallsTo("/api/ai/chat/stream").length).toBeGreaterThan(1));
    const retryBody = parseJsonBody(fetchCallsTo("/api/ai/chat/stream").at(-1)?.[1]?.body);
    expect(retryBody).toMatchObject({
      context: {
        primaryPaths: [],
        rulePaths: [expect.objectContaining({ path: "AGENTS.md", source: "auto-root-rule" })],
      },
    });
    expect(JSON.stringify(retryBody)).not.toContain("guide.md");
  });

  it("does not restore one-shot selected paths after cancelling a stream", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(openSettingsButton());
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    const aiApiEntry = screen.getByLabelText("AI API entry");
    fireEvent.click(within(aiApiEntry).getByRole("button", { name: "Set active" }));
    const aiApiAuth = screen.getByLabelText("AI API connection");
    fireEvent.change(within(aiApiAuth).getByLabelText("API key"), { target: { value: "local-test-key" } });
    fireEvent.change(within(aiApiAuth).getByLabelText("Provider"), { target: { value: "openaiCompatible" } });
    fireEvent.change(within(aiApiAuth).getByLabelText("Model"), { target: { value: "model-a" } });
    fireEvent.change(within(aiApiAuth).getByLabelText("Base URL"), { target: { value: "http://127.0.0.1:7777/v1" } });
    fireEvent.click(await waitForScopedButton(aiApiAuth, "Check readiness"));
    expect((await screen.findAllByText("Connected")).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.contextMenu(await screen.findByRole("button", { name: "guide.md" }), { clientX: 120, clientY: 120 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Send a path to AI Chat" }));
    expect(await screen.findByLabelText("AI Chat selected paths")).toBeTruthy();

    const originalFetch = fetchMock.getMockImplementation();
    let holdNextStream = true;
    let finishCanceledStream = () => {};
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/api/ai/chat/stream" && holdNextStream) {
        holdNextStream = false;
        const held = serverCancelableStreamResponse();
        finishCanceledStream = held.finish;
        return held.response;
      }
      if (String(input) === "/api/ai/cancel") {
        finishCanceledStream();
        return json({ runId: "cancel-test-run", state: "canceling" }, 202);
      }
      return originalFetch ? originalFetch(input, init) : json({ error: "missing fetch" }, 500);
    });

    fireEvent.change(screen.getByLabelText("AI Chat message"), { target: { value: "Summarize selected path." } });
    fireEvent.click(screen.getByRole("button", { name: "Send AI Chat message" }));
    await waitFor(() => expect(fetchCallsTo("/api/ai/chat/stream").length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.queryByLabelText("AI Chat selected paths")).toBeNull());
    const abortedBody = parseJsonBody(fetchCallsTo("/api/ai/chat/stream").at(-1)?.[1]?.body);
    expect(abortedBody).toMatchObject({
      context: {
        primaryPaths: [expect.objectContaining({ path: "guide.md", source: "tree-menu" })],
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel AI Chat request" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send AI Chat message" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("AI Chat message"), { target: { value: "Follow-up after cancel." } });
    fireEvent.click(screen.getByRole("button", { name: "Send AI Chat message" }));
    await waitFor(() => expect(fetchCallsTo("/api/ai/chat/stream").length).toBeGreaterThan(1));
    const followUpBody = parseJsonBody(fetchCallsTo("/api/ai/chat/stream").at(-1)?.[1]?.body);
    expect(followUpBody).toMatchObject({
      context: {
        primaryPaths: [],
        rulePaths: [expect.objectContaining({ path: "AGENTS.md", source: "auto-root-rule" })],
      },
    });
    expect(JSON.stringify(followUpBody)).not.toContain("guide.md");
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
    const aiChatPanel = document.querySelector(".ai-chat-panel") as HTMLElement;
    expect(aiChatPanel).toBeTruthy();
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
    expect(clipboardWrite).toHaveBeenCalledWith("codexCli says the active file says hello.\n\n- [x] Render task item\n\n```ts\nconst ok = true;\n```\n\nChanged paths:\n- changed: README.md");
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
    fireEvent.click(await waitForScopedButton(aiApiAuth, "Check readiness"));
    await waitFor(() => expect(resolveConnection).not.toBeNull());
    fireEvent.change(within(aiApiAuth).getByLabelText("Model"), { target: { value: "model-b" } });

    const claudeEntry = screen.getByLabelText("Claude Code CLI entry");
    fireEvent.click(within(claudeEntry).getByRole("button", { name: "Set active" }));
    expect(screen.getByLabelText("Claude Code CLI readiness")).toBeTruthy();
    expect(screen.queryByLabelText("AI API connection")).toBeNull();

    await act(async () => {
      resolveConnection?.(json(aiEntryReadiness("aiApi", { entry: "aiApi", provider: "openaiCompatible", credential: "local-test-key", model: "model-a", baseUrl: "http://127.0.0.1:7777/v1", apiFormat: "openaiCompatible" })));
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
    expect(within(codexDetailsBefore).getByLabelText("Readiness checklist").textContent).toContain("Current repo write wrapper");
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

async function waitForScopedButton(container: HTMLElement, name: string): Promise<HTMLElement> {
  let button: HTMLElement | null = null;
  await waitFor(() => {
    button = within(container).getByRole("button", { name });
    expect(button).toBeTruthy();
  });
  if (!button) throw new Error(`Button not found: ${name}`);
  return button;
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
    '<p><img src="/wide.png" alt="Wide asset"></p>',
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
    configRevision: "config-revision-v1",
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

function aiEntryReadiness(entry: string, provider?: Record<string, unknown>) {
  if (entry === "aiApi" || entry === "localAi") {
    const label = entry === "aiApi" ? "AI API" : "Local AI";
    const model = String(provider?.model || "");
    const baseUrl = String(provider?.baseUrl || "");
    const credential = String(provider?.credential || "");
    const configured = entry === "aiApi" ? Boolean(model && baseUrl && credential) : Boolean(model && baseUrl);
    return {
      entry,
      ready: configured,
      status: {
        state: configured ? "ready" : "notConfigured",
        code: configured ? "success" : "not_configured",
        severity: configured ? "success" : "warning",
        message: configured ? `${label} Codex-backed repo-scoped write is ready.` : "Connection settings are incomplete.",
        nextAction: configured ? "Use this entry for repo-scoped AI Chat or check again." : "Complete the entry settings, then run readiness again.",
        checkedAt: "2026-07-03T00:00:00.000Z",
      },
      settings: {
        entry,
        ...(provider || {}),
      },
      checks: [
        { id: "provider", label: entry === "aiApi" ? "Provider settings" : "Local settings", status: configured ? "ready" : "error", message: configured ? "Ready" : "Settings are incomplete." },
        { id: "binary", label: "Codex CLI binary", status: "ready", message: "Ready" },
        { id: "wrapper", label: "Codex repo-scoped write wrapper", status: "ready", message: "Ready" },
        { id: "workspace", label: "Workspace", status: "ready", message: "Ready" },
        { id: "auth-isolation", label: "Isolated auth", status: configured ? "ready" : "error", message: configured ? "Ready" : "Pending settings." },
      ],
    };
  }
  const codex = entry === "codexCli";
  return {
    entry,
    ready: true,
    status: {
      state: "ready",
      code: "success",
      severity: "success",
      message: codex ? ["Co", "dex CLI repo-scoped write wrapper is ready."].join("") : "Claude Code CLI repo-scoped write wrapper is ready.",
      nextAction: "Use this entry for repo-scoped AI Chat or check again.",
      checkedAt: "2026-07-03T00:00:00.000Z",
    },
    settings: {
      entry,
      binaryName: codex ? "codex" : "claude",
      version: codex ? "codex-cli 0.142.5" : "2.1.199",
      authState: "configured",
      readOnlyWrapperState: "ready",
      executionMode: "repoWrite",
      lastCheckedAt: "2026-07-03T00:00:00.000Z",
      readinessMessage: codex ? ["Co", "dex CLI repo-scoped write wrapper is ready."].join("") : "Claude Code CLI repo-scoped write wrapper is ready.",
    },
    checks: [
      { id: "binary", label: "Binary", status: "ready", message: "Ready" },
      { id: "auth", label: "Existing CLI auth", status: "ready", message: "Ready" },
      { id: "wrapper", label: "Repo-scoped write wrapper", status: "ready", message: "Ready" },
      { id: "workspace", label: "Workspace", status: "ready", message: "Ready" },
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

function abortableStreamResponse(signal?: AbortSignal | null): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        const abort = () => controller.error(new DOMException("The operation was aborted.", "AbortError"));
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener("abort", abort, { once: true });
      },
    }),
    { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
  );
}

function serverCancelableStreamResponse(): { response: Response; finish: () => void } {
  const encoder = new TextEncoder();
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(encoder.encode(`${JSON.stringify({
          type: "meta",
          runId: "cancel-test-run",
          context: { repoId: "docs", revision: repoRevisions.docs, systemPromptVersion: "1.0.0", primaryItems: [], ruleItems: [] },
        })}\n`));
      },
    }),
    { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
  );
  return {
    response,
    finish: () => {
      streamController?.enqueue(encoder.encode(`${JSON.stringify({
        type: "error",
        error: "AI Chat request canceled.",
        details: {
          run: {
            accessMode: "repoWrite",
            entry: "aiApi",
            substrate: "codexCli",
            auditState: "verified",
            changedPaths: [],
            repairs: [],
            warnings: ["Postflight audit completed after cancellation."],
          },
        },
      })}\n`));
      streamController?.close();
    },
  };
}

async function expectNoSeriousAxeViolations(container: HTMLElement): Promise<void> {
  const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
  expect(results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);
}
