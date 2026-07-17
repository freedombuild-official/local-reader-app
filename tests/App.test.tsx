import { readFileSync } from "node:fs";
import path from "node:path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, buildSandboxedHtmlSrcDoc } from "../src/App";
import type { AICliEntryKind, AICliSetupSnapshot } from "../src/types";

const fetchMock = vi.fn<typeof fetch>();
const stylesCss = readFileSync(path.join(process.cwd(), "src/styles.css"), "utf8").replace(/\r\n/g, "\n");
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
let cliSetups: Record<AICliEntryKind, AICliSetupSnapshot> = createCliSetupCollection();

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
  cliSetups = createCliSetupCollection();
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
      return json({ state: "ready", code: "success", severity: "success", message: "Connected.", nextAction: "Run AI Entry readiness to confirm the selected access policy.", checkedAt: "2026-07-03T00:00:00.000Z" });
    }
    if (url === "/api/ai/cli-setup") {
      return json({ setups: cliSetups });
    }
    if (url === "/api/ai/cli-setup/inspect") {
      const body = parseJsonBody(init?.body) as { entry?: "codexCli" | "claudeCli" };
      return json(cliSetups[body.entry || "codexCli"]);
    }
    if (url === "/api/ai/cli-setup/auth/start") {
      const body = parseJsonBody(init?.body) as { entry?: "codexCli" | "claudeCli" };
      const entry = body.entry || "codexCli";
      cliSetups[entry] = {
        ...cliSetups[entry],
        setupGeneration: cliSetups[entry].setupGeneration + 1,
        phase: "authenticating",
        authentication: { state: "waiting", verificationUrl: "https://example.test/device", userCode: "TEST-CODE", message: "Complete sign-in in the browser." },
      };
      return json(cliSetups[entry]);
    }
    if (url === "/api/ai/cli-setup/auth/cancel") {
      const body = parseJsonBody(init?.body) as { entry?: "codexCli" | "claudeCli" };
      const entry = body.entry || "codexCli";
      cliSetups[entry] = { ...cliSetups[entry], setupGeneration: cliSetups[entry].setupGeneration + 1, phase: "loginRequired", authentication: { state: "idle", message: "Sign-in canceled." } };
      return json(cliSetups[entry]);
    }
    if (url === "/api/ai/cli-setup/update/prepare") {
      const body = parseJsonBody(init?.body) as { entry?: "codexCli" | "claudeCli" };
      const entry = body.entry || "codexCli";
      const kind = cliSetups[entry].compatibility === "updateRequired" ? "compatibility" as const : "latest" as const;
      cliSetups[entry] = {
        ...cliSetups[entry],
        setupGeneration: cliSetups[entry].setupGeneration + 1,
        update: {
          state: "confirmationRequired",
          kind,
          nonce: "update-nonce",
          expiresAt: "2026-07-16T12:00:00.000Z",
          message: kind === "compatibility" ? "Confirm the compatibility update." : "Confirm the managed CLI updater.",
        },
      };
      return json(cliSetups[entry]);
    }
    if (url === "/api/ai/cli-setup/update/confirm") {
      const body = parseJsonBody(init?.body) as { entry?: "codexCli" | "claudeCli" };
      const entry = body.entry || "codexCli";
      cliSetups[entry] = {
        ...cliSetups[entry],
        setupGeneration: cliSetups[entry].setupGeneration + 1,
        compatibility: "compatible",
        update: {
          state: "succeeded",
          kind: cliSetups[entry].update.kind,
          message: cliSetups[entry].update.kind === "latest" ? "Managed CLI updater completed." : "Compatibility update installed.",
        },
      };
      return json(cliSetups[entry]);
    }
    if (url === "/api/ai/entry-readiness") {
      const body = parseJsonBody(init?.body) as { entry?: string; provider?: Record<string, unknown> };
      return json(aiEntryReadiness(String(body.entry || "codexCli"), body.provider));
    }
    if (url === "/api/ai/chat" || url === "/api/ai/chat/stream") {
      const body = parseJsonBody(init?.body) as {
        target?: { kind?: string; entry?: string; provider?: { entry?: string; executionMode?: string } };
        provider?: { entry?: string };
        messages?: Array<{ content?: string }>;
        context?: { repoId?: string; expectedRevision?: string; primaryPaths?: Array<{ path?: string }> };
      };
      const target = body.target?.entry || body.target?.provider?.entry || body.provider?.entry || body.target?.kind || "provider";
      const providerRepoWriteMode = body.target?.provider?.executionMode === "repoWrite";
      const providerTarget = target === "aiApi" || target === "localAi";
      const hasDuplicateCheck = (body.messages || []).some((message) => (message.content || "").toLowerCase().includes("duplicate"));
      const hasUnverifiedAudit = (body.messages || []).some((message) => (message.content || "").toLowerCase().includes("unverified audit"));
      const hasRepoWriteIntent = (body.messages || []).some((message) => /update|edit|write|rollback/i.test(message.content || ""));
      const repoWriteResult = (providerRepoWriteMode || !providerTarget) && hasRepoWriteIntent;
      const codeBlock = "```ts\nconst ok = true;\n```";
      const content = `${target} says the active file says hello.\n\n- [x] Render task item\n\n${codeBlock}`;
      const run = {
        accessMode: providerRepoWriteMode || !providerTarget ? "repoWrite" : "readOnly",
        entry: target,
        substrate: providerRepoWriteMode ? "serverEditProtocol" : providerTarget ? "directProvider" : target === "claudeCli" ? "claudeCli" : "codexCli",
        auditState: hasUnverifiedAudit ? "unverified" : "verified",
        changedPaths: hasUnverifiedAudit ? [] : repoWriteResult
          ? [{ path: "guide.md", status: "changed" }, { path: "docs/generated.md", status: "new" }]
          : [],
        repairs: [],
        warnings: hasUnverifiedAudit
          ? ["Repository changes are unverified because the bounded workspace audit was incomplete."]
          : hasDuplicateCheck
            ? ["Duplicate edit detected in README.md: repeated block \"## Write Result 2\"."]
            : providerTarget && !providerRepoWriteMode
              ? ["Context-only execution: Local Reader App did not grant repository write tools."]
              : [],
      };
      const payload = {
        message: { role: "assistant", content: repoWriteResult ? "Repo-wide Current repo run completed." : content },
        context: { repoId: "docs", systemPromptVersion: "1.0.0", primaryItems: [{ repoId: "docs", role: "primary", source: "manual", path: "README.md", name: "README.md", kind: "file", fileKind: "markdown", viewerStatus: "displayable", lineCount: 12, byteLength: 120, contentIncluded: true, content: "# Hello" }], ruleItems: [] },
        status: { state: "ready", message: "Response received.", checkedAt: "2026-07-03T00:00:00.000Z" },
        run,
      };
      if (url === "/api/ai/chat/stream") {
        return streamJsonLines([
          { type: "meta", runId: repoWriteResult ? "test-repo-write-run-id" : "test-run-id", context: payload.context },
          { type: "delta", content: repoWriteResult ? payload.message.content : `${target} says ` },
          ...(!repoWriteResult ? [
            { type: "delta", content: "the active file says hello." },
            { type: "delta", content: `\n\n- [x] Render task item\n\n${codeBlock}` },
          ] : []),
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
    expect(await screen.findByRole("heading", { name: "Local Reader App" })).toBeTruthy();
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
    await activateReadyCliEntry();
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
    expect(await screen.findByRole("heading", { name: "Local Reader App" })).toBeTruthy();
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
    expect(screen.queryByText("AI Entry authentication is required")).toBeNull();
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

  it("clears the active repository and CLI readiness after the last repository is removed", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(openSettingsButton());
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    await activateReadyCliEntry();
    fireEvent.click(screen.getByRole("tab", { name: "Repositories" }));

    const originalFetch = fetchMock.getMockImplementation();
    let savedEmpty = false;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/repository-config/save") {
        savedEmpty = true;
        return json({ ...repositoryConfigState(), entries: [], yaml: "repositories: []\n" });
      }
      if (url === "/api/repos" && savedEmpty) return json({ repositories: [] });
      return originalFetch ? originalFetch(input, init) : json({ error: "missing fetch" }, 500);
    });

    const docsEditor = screen.getByLabelText("Docs repository entry");
    fireEvent.click(within(docsEditor).getByRole("button", { name: "Remove from list" }));
    fireEvent.click(screen.getByRole("button", { name: "Save config" }));
    await waitFor(() => expect(savedEmpty).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));

    expect(await screen.findByText("AI Entry is not ready.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send AI Chat message" })).toBeNull();
  });

  it("keeps four AI Entries, retains CLI chat across repositories, and resets only from New Chat", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "AI Chat" }));
    expect(screen.getByText("AI Entry is required.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New chat" })).toBeTruthy();
    expect(cssRule(".ai-chat-session-header")).toContain("min-height: 38px;");
    expect(cssRule(".ai-chat-session-header")).toContain("max-height: 44px;");
    expect(cssRule(".ai-chat-session-header")).toContain("justify-content: flex-start;");

    fireEvent.click(openSettingsButton());
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "AI Chat" }));
    const aiApiEntry = screen.getByLabelText("AI API entry");
    const localAiEntry = screen.getByLabelText("Local AI entry");
    const codexCliEntry = screen.getByLabelText(["Co", "dex CLI entry"].join(""));
    const claudeCodeEntry = screen.getByLabelText("Claude Code CLI entry");
    expect(aiApiEntry).toBeTruthy();
    expect(localAiEntry).toBeTruthy();
    expect(codexCliEntry).toBeTruthy();
    expect(claudeCodeEntry).toBeTruthy();
    const comingSoonButtons = screen.getAllByRole("button", { name: "Coming soon" }) as HTMLButtonElement[];
    expect(comingSoonButtons).toHaveLength(2);
    expect(comingSoonButtons.every((button) => button.disabled)).toBe(true);
    expect(within(aiApiEntry).getByRole("button", { name: "Coming soon" })).toBeTruthy();
    expect(within(localAiEntry).getByRole("button", { name: "Coming soon" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Set active" })).toHaveLength(2);
    fireEvent.click(within(aiApiEntry).getByRole("button", { name: "Coming soon" }));
    expect(fetchCallsTo("/api/ai/entry-readiness")).toHaveLength(0);
    expect(screen.queryByLabelText("AI API connection")).toBeNull();

    await activateReadyCliEntry();
    expect(fetchCallsTo("/api/ai/entry-readiness")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    fireEvent.change(screen.getByLabelText("AI Chat message"), { target: { value: "What does this file say?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send AI Chat message" }));
    expect(await screen.findByText("codexCli says the active file says hello.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("AI Chat message"), { target: { value: "repo switch draft" } });
    const readinessCallsBeforeSwitch = fetchCallsTo("/api/ai/entry-readiness").length;
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "alt" } });
    expect(await screen.findByRole("heading", { name: "Alt" })).toBeTruthy();
    expect(screen.getByText("codexCli says the active file says hello.")).toBeTruthy();
    expect(screen.getByText("AI Entry is not ready.")).toBeTruthy();
    expect(screen.queryByLabelText("AI Chat message")).toBeNull();
    expect(fetchCallsTo("/api/ai/entry-readiness")).toHaveLength(readinessCallsBeforeSwitch);

    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "docs" } });
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    expect(screen.getByText("AI Entry is not ready.")).toBeTruthy();
    fireEvent.click(openSettingsButton());
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    await activateReadyCliEntry();
    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    expect((screen.getByLabelText("AI Chat message") as HTMLTextAreaElement).value).toBe("repo switch draft");
    fireEvent.contextMenu(await screen.findByRole("button", { name: "guide.md" }), { clientX: 120, clientY: 120 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Send a path to AI Chat" }));
    const fileInput = document.querySelector(".ai-chat-composer input[type='file']") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [new File(["Attached"], "note.md", { type: "text/markdown" })] } });
    });
    expect(await screen.findByLabelText("AI Chat selected paths")).toBeTruthy();
    expect(await screen.findByLabelText("AI Chat attachments")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(screen.getByLabelText("AI Chat transcript").textContent).toBe("");
    expect((screen.getByLabelText("AI Chat message") as HTMLTextAreaElement).value).toBe("");
    expect(screen.queryByLabelText("AI Chat selected paths")).toBeNull();
    expect(screen.queryByLabelText("AI Chat attachments")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry AI Chat request" })).toBeNull();
    expect(screen.getByLabelText("AI Chat message")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Outline" }));
    expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Memo" }));
    expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
  });

  it("sends an explicit tree path to AI Chat without auto-including the active file", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(openSettingsButton());
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    await activateReadyCliEntry();

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

  it("allows CLI Current repo writes with no path and with directory or multiple-path context", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(openSettingsButton());
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    await activateReadyCliEntry();
    expect(parseJsonBody(fetchCallsTo("/api/ai/entry-readiness").at(-1)?.[1]?.body)).toMatchObject({ entry: "codexCli" });

    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.click(await screen.findByRole("button", { name: "guide.md" }));
    expect(await screen.findByRole("heading", { name: "Guide" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    expect(screen.queryByText(/Sending an explicit edit request authorizes one guarded run/)).toBeNull();
    expect(screen.queryByText("AI Entry is not ready.")).toBeNull();
    expect(screen.queryByText("AI Entry is required.")).toBeNull();
    const originalFetch = fetchMock.getMockImplementation();
    const refreshedRevision = "revision-docs-v2";
    let providerWriteRequested = false;
    let delayNextRefresh = true;
    let failNextRefresh = false;
    let returnRollbackIncomplete = false;
    let resolveDelayedRefresh: ((response: Response) => void) | null = null;
    const refreshedRepoOpenResponse = () => json({
      repoId: "docs",
      revision: refreshedRevision,
      sync: { state: "disabled", message: "Git remote fetch disabled.", fetched: false },
      tree: treeSnapshot,
      treeTruncated: false,
      treeWarnings: [],
    });
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/ai/chat/stream") {
        providerWriteRequested = true;
        if (returnRollbackIncomplete) {
          returnRollbackIncomplete = false;
          return streamJsonLines([
            { type: "meta", runId: "rollback-incomplete-run", context: { repoId: "docs", revision: refreshedRevision, primaryItems: [], ruleItems: [], systemPromptVersion: "2.3.0" } },
            { type: "error", error: "__RAW_ROLLBACK_SENTINEL__ guarded apply stack", details: { code: "guarded_rollback_incomplete", rollbackState: "unverified" } },
          ]);
        }
        return originalFetch ? originalFetch(input, init) : json({ error: "missing fetch" }, 500);
      }
      if (providerWriteRequested && url === "/api/repos") {
        return json({
          repositories: [
            { id: "docs", label: "Docs", root: "/tmp/docs", defaultPath: "README.md", exists: true, revision: refreshedRevision },
            { id: "alt", label: "Alt", root: "/tmp/alt", defaultPath: "ALT.md", exists: true, revision: repoRevisions.alt },
          ],
        });
      }
      if (providerWriteRequested && url === "/api/repo-open") {
        if (failNextRefresh) {
          failNextRefresh = false;
          throw new Error("__RAW_REFRESH_SENTINEL__ repository refresh stack");
        }
        if (delayNextRefresh) {
          delayNextRefresh = false;
          return new Promise<Response>((resolve) => {
            resolveDelayedRefresh = resolve;
          });
        }
        return refreshedRepoOpenResponse();
      }
      if (providerWriteRequested && url.startsWith("/api/file")) {
        const query = new URL(`http://local${url}`).searchParams;
        if (query.get("path") === "guide.md") {
          const refreshedGuide = fileForPath("guide.md");
          return json({
            ...refreshedGuide,
            revision: refreshedRevision,
            content: "# Guide\n\nAI-refreshed guide content.\n",
            markdown: {
              frontmatter: "",
              body: "# Guide\n\nAI-refreshed guide content.\n",
              html: "<h1>Guide</h1><p>AI-refreshed guide content.</p>",
            },
          });
        }
      }
      return originalFetch ? originalFetch(input, init) : json({ error: "missing fetch" }, 500);
    });
    const messageInput = await screen.findByLabelText("AI Chat message");
    fireEvent.change(messageInput, { target: { value: "Update the Current repo without selected context." } });
    expect((screen.getByRole("button", { name: "Send AI Chat message" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Send AI Chat message" }));
    expect(await screen.findByText("Repo-wide Current repo run completed.")).toBeTruthy();
    const noPathBody = parseJsonBody(fetchCallsTo("/api/ai/chat/stream").at(-1)?.[1]?.body);
    expect(noPathBody).toMatchObject({ target: { kind: "codexCli", entry: "codexCli" }, context: { primaryPaths: [] } });
    await waitFor(() => {
      const transcript = screen.getByLabelText("AI Chat transcript").textContent || "";
      expect(transcript).toContain("Repo-wide Current repo run completed.");
      expect(transcript).not.toContain("Changed paths:");
      expect(transcript).not.toContain("changed: guide.md");
      expect(transcript).not.toContain("new: docs/generated.md");
      expect(transcript).not.toContain("Warnings:");
    });
    const refreshingButton = await screen.findByRole("button", { name: "Refreshing repository" });
    expect((refreshingButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Send AI Chat message" })).toBeNull();
    await act(async () => {
      resolveDelayedRefresh?.(refreshedRepoOpenResponse());
    });
    expect(await screen.findByText("AI-refreshed guide content.")).toBeTruthy();
    expect(parseJsonBody(fetchCallsTo("/api/repo-open").at(-1)?.[1]?.body)).toMatchObject({ repoId: "docs", expectedRevision: refreshedRevision });
    expect(screen.getByText("AI Entry is not ready.")).toBeTruthy();
    fireEvent.click(openSettingsButton());
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    await activateReadyCliEntry();
    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    expect((screen.getByLabelText("AI Chat message") as HTMLTextAreaElement).disabled).toBe(false);

    fireEvent.contextMenu(await screen.findByRole("button", { name: "docs" }), { clientX: 120, clientY: 120 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Send a path to AI Chat" }));
    fireEvent.contextMenu(await screen.findByRole("button", { name: "guide.md" }), { clientX: 120, clientY: 120 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Send a path to AI Chat" }));
    expect(within(screen.getByLabelText("AI Chat selected paths")).getByText("docs")).toBeTruthy();
    expect(within(screen.getByLabelText("AI Chat selected paths")).getByText("guide.md")).toBeTruthy();
    failNextRefresh = true;
    fireEvent.change(screen.getByLabelText("AI Chat message"), { target: { value: "Use both context hints and update the repo." } });
    expect((screen.getByRole("button", { name: "Send AI Chat message" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Send AI Chat message" }));
    await waitFor(() => expect(fetchCallsTo("/api/ai/chat/stream")).toHaveLength(2));
    const multiPathBody = parseJsonBody(fetchCallsTo("/api/ai/chat/stream").at(-1)?.[1]?.body);
    expect(multiPathBody).toMatchObject({ context: { primaryPaths: expect.arrayContaining([
      expect.objectContaining({ path: "docs", kind: "directory" }),
      expect.objectContaining({ path: "guide.md", kind: "file" }),
    ]) } });
    expect((await screen.findAllByText("The request finished, but Local Reader App could not refresh the Current repo. Retry the repository refresh.")).length).toBeGreaterThan(0);
    expect((document.querySelector(".ai-chat-panel") as HTMLElement).textContent || "").not.toContain("__RAW_REFRESH_SENTINEL__");
    expect(screen.queryByRole("button", { name: "Retry AI Chat request" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry repository refresh" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry repository refresh" })).toBeNull());
    expect(screen.getByRole("button", { name: "Send AI Chat message" })).toBeTruthy();

    const repoListFetchesBeforeRollbackError = fetchCallsTo("/api/repos").length;
    returnRollbackIncomplete = true;
    fireEvent.change(screen.getByLabelText("AI Chat message"), { target: { value: "Exercise rollback-incomplete refresh handling." } });
    fireEvent.click(screen.getByRole("button", { name: "Send AI Chat message" }));
    const rollbackMessage = "The edit could not be completed, and Local Reader App could not confirm that every partial change was restored. Review the Current repo before continuing.";
    expect((await screen.findAllByText(rollbackMessage)).length).toBeGreaterThan(0);
    expect(document.body.textContent || "").not.toContain("__RAW_ROLLBACK_SENTINEL__");
    await waitFor(() => expect(fetchCallsTo("/api/repos").length).toBeGreaterThan(repoListFetchesBeforeRollbackError));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send AI Chat message" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Retry AI Chat request" })).toBeNull();
  });

  it("keeps verified and unverified run metadata out of the transcript while still refreshing the repository", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(openSettingsButton());
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    await activateReadyCliEntry();
    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));

    const repoOpensBeforeVerifiedRun = fetchCallsTo("/api/repo-open").length;
    fireEvent.change(screen.getByLabelText("AI Chat message"), { target: { value: "Update the Current repo." } });
    fireEvent.click(screen.getByRole("button", { name: "Send AI Chat message" }));
    expect(await screen.findByText("Repo-wide Current repo run completed.")).toBeTruthy();
    await waitFor(() => expect(fetchCallsTo("/api/repo-open").length).toBeGreaterThan(repoOpensBeforeVerifiedRun));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send AI Chat message" })).toBeTruthy());
    let latestAssistant = Array.from(document.querySelectorAll(".ai-message.assistant")).at(-1) as HTMLElement;
    expect(latestAssistant.textContent).toContain("Repo-wide Current repo run completed.");
    expect(latestAssistant.textContent).not.toContain("Changed paths:");
    expect(latestAssistant.textContent).not.toContain("changed: guide.md");
    expect(latestAssistant.textContent).not.toContain("Warnings:");

    const repoOpensBeforeUnverifiedRun = fetchCallsTo("/api/repo-open").length;
    fireEvent.change(screen.getByLabelText("AI Chat message"), { target: { value: "Update with an unverified audit." } });
    fireEvent.click(screen.getByRole("button", { name: "Send AI Chat message" }));
    await waitFor(() => expect(screen.getAllByText("Repo-wide Current repo run completed.")).toHaveLength(2));
    await waitFor(() => expect(fetchCallsTo("/api/repo-open").length).toBeGreaterThan(repoOpensBeforeUnverifiedRun));
    latestAssistant = Array.from(document.querySelectorAll(".ai-message.assistant")).at(-1) as HTMLElement;
    expect(latestAssistant.textContent).toContain("Repo-wide Current repo run completed.");
    expect(latestAssistant.textContent).not.toContain("Repository changes unverified.");
    expect(latestAssistant.textContent).not.toContain("Warnings:");
    expect(document.body.textContent || "").not.toContain("Repository changes are unverified because the bounded workspace audit was incomplete.");
  });

  it("aborts and ignores a delayed repo-wide response after the Current repo changes", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(openSettingsButton());
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    await activateReadyCliEntry();

    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.contextMenu(await screen.findByRole("button", { name: "guide.md" }), { clientX: 120, clientY: 120 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Send a path to AI Chat" }));

    const originalFetch = fetchMock.getMockImplementation();
    let delayedController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let requestSignal: AbortSignal | undefined;
    const encoder = new TextEncoder();
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/api/ai/chat/stream") {
        requestSignal = init?.signal || undefined;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            delayedController = controller;
            controller.enqueue(encoder.encode(`${JSON.stringify({ type: "meta", runId: "delayed-run", context: { repoId: "docs", revision: repoRevisions.docs, primaryItems: [], ruleItems: [], systemPromptVersion: "2.3.0" } })}\n`));
          },
        }), { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
      }
      return originalFetch ? originalFetch(input, init) : json({ error: "missing fetch" }, 500);
    });

    fireEvent.change(screen.getByLabelText("AI Chat message"), { target: { value: "Start a delayed repo-wide run." } });
    fireEvent.click(screen.getByRole("button", { name: "Send AI Chat message" }));
    await waitFor(() => expect(delayedController).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "alt" } });
    expect(await screen.findByRole("heading", { name: "Alt" })).toBeTruthy();
    await waitFor(() => expect(requestSignal?.aborted).toBe(true));

    await act(async () => {
      delayedController?.enqueue(encoder.encode(`${JSON.stringify({
        type: "done",
        message: { role: "assistant", content: "Old repository response." },
        context: { repoId: "docs", revision: repoRevisions.docs, primaryItems: [], ruleItems: [], systemPromptVersion: "2.3.0" },
        status: { state: "ready", message: "Ready", checkedAt: "2026-07-11T00:00:00.000Z" },
        run: { accessMode: "repoWrite", entry: "codexCli", substrate: "codexCli", auditState: "verified", changedPaths: [], repairs: [], warnings: [] },
      })}\n`));
      delayedController?.close();
    });
    expect(screen.queryByText("Old repository response.")).toBeNull();
  });

  it("aborts an in-flight CLI run when its setup generation is invalidated", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(openSettingsButton());
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    await activateReadyCliEntry();
    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));

    const originalFetch = fetchMock.getMockImplementation();
    let delayedController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let requestSignal: AbortSignal | undefined;
    const encoder = new TextEncoder();
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/api/ai/chat/stream") {
        requestSignal = init?.signal || undefined;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            delayedController = controller;
            controller.enqueue(encoder.encode(`${JSON.stringify({ type: "meta", runId: "setup-invalidated-run", context: { repoId: "docs", revision: repoRevisions.docs, primaryItems: [], ruleItems: [], systemPromptVersion: "2.3.0" } })}\n`));
          },
        }), { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
      }
      return originalFetch ? originalFetch(input, init) : json({ error: "missing fetch" }, 500);
    });

    fireEvent.change(screen.getByLabelText("AI Chat message"), { target: { value: "Start a run before setup invalidation." } });
    fireEvent.click(screen.getByRole("button", { name: "Send AI Chat message" }));
    await waitFor(() => expect(delayedController).toBeTruthy());
    cliSetups.codexCli = {
      ...cliSetups.codexCli,
      setupGeneration: cliSetups.codexCli.setupGeneration + 1,
      phase: "loginRequired",
      authentication: { state: "idle" },
      catalog: undefined,
      failureReason: "authenticationChanged",
    };
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 1_100));
    });

    await waitFor(() => expect(requestSignal?.aborted).toBe(true));
    await waitFor(() => expect(fetchCallsTo("/api/ai/cancel")).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getAllByText("AI Chat request canceled because the AI Entry setup changed.").length).toBeGreaterThan(0),
    );
    expect(screen.queryByText("Old setup response.")).toBeNull();
    await act(async () => {
      try {
        delayedController?.enqueue(encoder.encode(`${JSON.stringify({
          type: "done",
          message: { role: "assistant", content: "Old setup response." },
          context: { repoId: "docs", revision: repoRevisions.docs, primaryItems: [], ruleItems: [], systemPromptVersion: "2.3.0" },
          status: { state: "ready", message: "Ready", checkedAt: "2026-07-16T00:00:00.000Z" },
          run: { accessMode: "repoWrite", entry: "codexCli", substrate: "codexCli", auditState: "verified", changedPaths: [], repairs: [], warnings: [] },
        })}\n`));
        delayedController?.close();
      } catch {
        // The aborted reader may already have canceled the mocked stream.
      }
    });
    expect(screen.queryByText("Old setup response.")).toBeNull();
  });

  it("keeps an in-flight repo-wide request alive when another file opens in the same repo", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(openSettingsButton());
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    await activateReadyCliEntry();

    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.contextMenu(await screen.findByRole("button", { name: "guide.md" }), { clientX: 120, clientY: 120 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Send a path to AI Chat" }));

    const originalFetch = fetchMock.getMockImplementation();
    let delayedController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let requestSignal: AbortSignal | undefined;
    const encoder = new TextEncoder();
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/api/ai/chat/stream") {
        requestSignal = init?.signal || undefined;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            delayedController = controller;
            controller.enqueue(encoder.encode(`${JSON.stringify({ type: "meta", runId: "same-repo-run", context: { repoId: "docs", revision: repoRevisions.docs, primaryItems: [], ruleItems: [], systemPromptVersion: "2.3.0" } })}\n`));
          },
        }), { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
      }
      return originalFetch ? originalFetch(input, init) : json({ error: "missing fetch" }, 500);
    });

    fireEvent.change(screen.getByLabelText("AI Chat message"), { target: { value: "Run a delayed repo-wide request while I inspect another file." } });
    fireEvent.click(screen.getByRole("button", { name: "Send AI Chat message" }));
    await waitFor(() => expect(delayedController).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "api.ts" }));
    expect(await screen.findByLabelText("Raw")).toBeTruthy();
    expect(requestSignal?.aborted).toBe(false);

    await act(async () => {
      delayedController?.enqueue(encoder.encode(`${JSON.stringify({
        type: "done",
        message: { role: "assistant", content: "Same repository response." },
        context: { repoId: "docs", revision: repoRevisions.docs, primaryItems: [], ruleItems: [], systemPromptVersion: "2.3.0" },
        status: { state: "ready", message: "Ready", checkedAt: "2026-07-11T00:00:00.000Z" },
        run: { accessMode: "repoWrite", entry: "codexCli", substrate: "codexCli", auditState: "verified", changedPaths: [], repairs: [], warnings: [] },
      })}\n`));
      delayedController?.close();
    });

    expect(await screen.findByText("Same repository response.")).toBeTruthy();
    expect(requestSignal?.aborted).toBe(false);
    expect(fetchCallsTo("/api/ai/cancel")).toHaveLength(0);
  });

  it("aborts an in-flight request and preserves CLI readiness when New Chat resets the session", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(openSettingsButton());
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    await activateReadyCliEntry();
    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));

    const originalFetch = fetchMock.getMockImplementation();
    let delayedController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let requestSignal: AbortSignal | undefined;
    const encoder = new TextEncoder();
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/api/ai/chat/stream") {
        requestSignal = init?.signal || undefined;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            delayedController = controller;
            controller.enqueue(encoder.encode(`${JSON.stringify({ type: "meta", runId: "new-chat-run", context: { repoId: "docs", revision: repoRevisions.docs, primaryItems: [], ruleItems: [], systemPromptVersion: "2.3.0" } })}\n`));
          },
        }), { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
      }
      return originalFetch ? originalFetch(input, init) : json({ error: "missing fetch" }, 500);
    });

    fireEvent.change(screen.getByLabelText("AI Chat message"), { target: { value: "Start a delayed run before New Chat." } });
    fireEvent.click(screen.getByRole("button", { name: "Send AI Chat message" }));
    await waitFor(() => expect(delayedController).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(requestSignal?.aborted).toBe(true));
    expect(screen.queryByRole("button", { name: "Cancel AI Chat request" })).toBeNull();
    expect((screen.getByLabelText("AI Chat message") as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByLabelText("AI Chat transcript").textContent).toBe("");
    expect(screen.getByRole("button", { name: "Send AI Chat message" })).toBeTruthy();

    await act(async () => {
      delayedController?.enqueue(encoder.encode(`${JSON.stringify({
        type: "done",
        message: { role: "assistant", content: "Old session response." },
        context: { repoId: "docs", revision: repoRevisions.docs, primaryItems: [], ruleItems: [], systemPromptVersion: "2.3.0" },
        status: { state: "ready", message: "Ready", checkedAt: "2026-07-11T00:00:00.000Z" },
        run: { accessMode: "repoWrite", entry: "codexCli", substrate: "codexCli", auditState: "verified", changedPaths: [], repairs: [], warnings: [] },
      })}\n`));
      delayedController?.close();
    });
    expect(screen.queryByText("Old session response.")).toBeNull();
    expect(screen.getByLabelText("AI Chat message")).toBeTruthy();
  });

  it("does not restore one-shot selected paths when retrying after a stream error", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(openSettingsButton());
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    await activateReadyCliEntry();

    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.contextMenu(await screen.findByRole("button", { name: "guide.md" }), { clientX: 120, clientY: 120 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Send a path to AI Chat" }));
    expect(await screen.findByLabelText("AI Chat selected paths")).toBeTruthy();

    const originalFetch = fetchMock.getMockImplementation();
    let failNextStream = true;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/api/ai/chat/stream" && failNextStream) {
        failNextStream = false;
        return streamJsonLines([{ type: "error", error: "__RAW_STREAM_SENTINEL__ process stack" }]);
      }
      return originalFetch ? originalFetch(input, init) : json({ error: "missing fetch" }, 500);
    });

    fireEvent.change(screen.getByLabelText("AI Chat message"), { target: { value: "Summarize selected path." } });
    fireEvent.click(screen.getByRole("button", { name: "Send AI Chat message" }));
    const naturalFailure = "AI Chat could not complete the request. Check the active AI Entry and try again.";
    await waitFor(() => expect(screen.getAllByText(naturalFailure)).toHaveLength(2));
    expect(document.body.textContent || "").not.toContain("__RAW_STREAM_SENTINEL__");
    expect(screen.queryByText("Request failed before a run summary was available.")).toBeNull();
    expect(screen.queryByText("Streaming...")).toBeNull();
    await waitFor(() => expect(screen.queryByLabelText("AI Chat selected paths")).toBeNull());
    const failedBody = parseJsonBody(fetchCallsTo("/api/ai/chat/stream").at(-1)?.[1]?.body);
    expect(failedBody).toMatchObject({
      context: {
        primaryPaths: [expect.objectContaining({ path: "guide.md", source: "tree-menu" })],
      },
    });

    expect(screen.queryByRole("button", { name: "Retry AI Chat request" })).toBeNull();
    fireEvent.change(screen.getByLabelText("AI Chat message"), { target: { value: "Retry without selected path." } });
    fireEvent.click(screen.getByRole("button", { name: "Send AI Chat message" }));
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

  it("invalidates stale UI readiness when the server cannot renew it before a stream starts", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(openSettingsButton());
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    await activateReadyCliEntry();

    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    const originalFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/api/ai/chat/stream") {
        return json({
          error: "__RAW_READINESS_SENTINEL__ credential probe stack",
          details: { code: "readiness_renewal_failed", entry: "codexCli" },
        }, 409);
      }
      return originalFetch ? originalFetch(input, init) : json({ error: "missing fetch" }, 500);
    });

    fireEvent.change(await screen.findByLabelText("AI Chat message"), { target: { value: "Send after the old readiness lease." } });
    fireEvent.click(screen.getByRole("button", { name: "Send AI Chat message" }));
    expect(await screen.findByText("AI Entry is not ready.")).toBeTruthy();
    expect(screen.getByLabelText("AI Chat transcript").textContent).toContain("AI Chat authorization expired. Check the active AI Entry in Settings before trying again.");
    expect(document.body.textContent || "").not.toContain("__RAW_READINESS_SENTINEL__");
    expect(screen.queryByRole("button", { name: "Send AI Chat message" })).toBeNull();
  });

  it("invalidates stale UI readiness for a pre-stream CLI catalog mismatch", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(openSettingsButton());
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    await activateReadyCliEntry();

    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    const originalFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/api/ai/chat/stream") {
        return json({
          error: "__RAW_SELECTION_SENTINEL__ stale catalog",
          details: { code: "invalidSelection" },
        }, 400);
      }
      return originalFetch ? originalFetch(input, init) : json({ error: "missing fetch" }, 500);
    });

    fireEvent.change(await screen.findByLabelText("AI Chat message"), { target: { value: "Send with a stale catalog." } });
    fireEvent.click(screen.getByRole("button", { name: "Send AI Chat message" }));

    expect(await screen.findByText("AI Entry is not ready.")).toBeTruthy();
    expect(document.body.textContent || "").not.toContain("__RAW_SELECTION_SENTINEL__");
    expect(screen.queryByRole("button", { name: "Send AI Chat message" })).toBeNull();
  });

  it("invalidates CLI readiness when a chat reports expired authentication", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(openSettingsButton());
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    await activateReadyCliEntry();

    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    const originalFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/api/ai/chat/stream") {
        return json({
          error: "__RAW_AUTH_SENTINEL__ not logged in",
          details: { code: "authenticationInvalidated" },
        }, 502);
      }
      return originalFetch ? originalFetch(input, init) : json({ error: "missing fetch" }, 500);
    });

    fireEvent.change(await screen.findByLabelText("AI Chat message"), { target: { value: "Send after authentication expires." } });
    fireEvent.click(screen.getByRole("button", { name: "Send AI Chat message" }));

    expect(await screen.findByText("AI Entry is not ready.")).toBeTruthy();
    expect(document.body.textContent || "").not.toContain("__RAW_AUTH_SENTINEL__");
    expect(screen.queryByRole("button", { name: "Send AI Chat message" })).toBeNull();
  });

  it("invalidates stale UI readiness when a streamed error marks a CLI catalog mismatch", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(openSettingsButton());
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    await activateReadyCliEntry();

    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    const originalFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/api/ai/chat/stream") {
        return streamJsonLines([{
          type: "error",
          error: "__RAW_STREAM_SELECTION_SENTINEL__ stale catalog",
          details: { code: "invalidSelection" },
        }]);
      }
      return originalFetch ? originalFetch(input, init) : json({ error: "missing fetch" }, 500);
    });

    fireEvent.change(await screen.findByLabelText("AI Chat message"), { target: { value: "Stream with a stale catalog." } });
    fireEvent.click(screen.getByRole("button", { name: "Send AI Chat message" }));

    expect(await screen.findByText("AI Entry is not ready.")).toBeTruthy();
    expect(document.body.textContent || "").not.toContain("__RAW_STREAM_SELECTION_SENTINEL__");
    expect(screen.queryByRole("button", { name: "Send AI Chat message" })).toBeNull();

    fireEvent.click(openSettingsButton());
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    const readiness = screen.getByLabelText(["Co", "dex CLI readiness"].join(""));
    fireEvent.click(within(readiness).getByRole("button", { name: /Check/ }));
    await waitFor(() => expect(within(readiness).getAllByText("Success").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    fireEvent.change(screen.getByLabelText("AI Chat message"), { target: { value: "Retry after readiness recovery." } });
    expect(screen.getByRole("button", { name: "Send AI Chat message" })).toBeTruthy();
  });

  it("shows mandatory restart guidance for a pre-stream unverified CLI process tree", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(openSettingsButton());
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    await activateReadyCliEntry();

    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    const originalFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/api/ai/chat/stream") {
        return json({
          error: "__RAW_PROCESS_TREE_SENTINEL__ internal cleanup output",
          details: {
            processTreeUnverified: true,
            run: {
              accessMode: "repoWrite",
              entry: "codexCli",
              substrate: "codexCli",
              auditState: "unverified",
              changedPaths: [],
              repairs: [],
              warnings: ["audit skipped"],
            },
          },
        }, 502);
      }
      return originalFetch ? originalFetch(input, init) : json({ error: "missing fetch" }, 500);
    });

    fireEvent.change(await screen.findByLabelText("AI Chat message"), { target: { value: "Run the Current repo task." } });
    fireEvent.click(screen.getByRole("button", { name: "Send AI Chat message" }));

    const guidance = "AI Chat stopped unexpectedly, and Local Reader App could not confirm that the CLI process ended. Close the CLI, review the Current repo, restart the Local Reader App server, and reload the page before continuing.";
    expect((await screen.findAllByText(guidance)).length).toBeGreaterThan(0);
    expect(await screen.findByText("AI Entry is not ready.")).toBeTruthy();
    expect(document.body.textContent || "").not.toContain("__RAW_PROCESS_TREE_SENTINEL__");
    expect(screen.queryByRole("button", { name: "Retry AI Chat request" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send AI Chat message" })).toBeNull();
  });

  it("does not restore one-shot selected paths after cancelling a stream", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(openSettingsButton());
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    await activateReadyCliEntry();

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

  it("explains cancellation failures without exposing the raw endpoint error", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(openSettingsButton());
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    await activateReadyCliEntry();
    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));

    const originalFetch = fetchMock.getMockImplementation();
    const held = serverCancelableStreamResponse();
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/api/ai/chat/stream") return held.response;
      if (String(input) === "/api/ai/cancel") return json({ error: "__RAW_CANCEL_SENTINEL__ endpoint stack" }, 500);
      return originalFetch ? originalFetch(input, init) : json({ error: "missing fetch" }, 500);
    });

    fireEvent.change(screen.getByLabelText("AI Chat message"), { target: { value: "Start a cancellable run." } });
    fireEvent.click(screen.getByRole("button", { name: "Send AI Chat message" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel AI Chat request" }));
    expect(await screen.findByText("Local Reader App could not confirm cancellation. Close the CLI, review the Current repo, restart the Local Reader App server, and reload the page before continuing.")).toBeTruthy();
    expect(document.body.textContent || "").not.toContain("__RAW_CANCEL_SENTINEL__");
    expect(screen.queryByRole("button", { name: "Retry AI Chat request" })).toBeNull();

    await act(async () => held.finish());
    await waitFor(() => expect(screen.getByRole("button", { name: "Send AI Chat message" })).toBeTruthy());
  });

  it("aborts locally when cancellation happens before the stream run id arrives", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(openSettingsButton());
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    await activateReadyCliEntry();

    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    const originalFetch = fetchMock.getMockImplementation();
    let streamSignal: AbortSignal | null | undefined;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/api/ai/chat/stream") {
        streamSignal = init?.signal;
        return abortableStreamResponse(init?.signal);
      }
      return originalFetch ? originalFetch(input, init) : json({ error: "missing fetch" }, 500);
    });

    fireEvent.change(screen.getByLabelText("AI Chat message"), { target: { value: "Wait for readiness before the stream starts." } });
    fireEvent.click(screen.getByRole("button", { name: "Send AI Chat message" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel AI Chat request" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Cancel AI Chat request" }));
    expect(screen.queryByRole("button", { name: "Retry AI Chat request" })).toBeNull();
    await waitFor(() => expect(streamSignal?.aborted).toBe(true));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send AI Chat message" })).toBeTruthy());
    expect(fetchCallsTo("/api/ai/cancel")).toHaveLength(0);
    expect(screen.getByLabelText("AI Chat transcript").textContent).toContain("The AI Chat request was canceled.");
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
    await activateReadyCliEntry();

    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    const messageInput = screen.getByLabelText("AI Chat message") as HTMLTextAreaElement;
    const aiChatPanel = document.querySelector(".ai-chat-panel") as HTMLElement;
    expect(aiChatPanel).toBeTruthy();
    expect(aiChatPanel.querySelector(".ai-chat-status")).toBeNull();
    expect(within(aiChatPanel).queryByText("Codex CLI")).toBeNull();
    expect(within(aiChatPanel).queryByText("codex / medium")).toBeNull();
    const selectedModel = within(aiChatPanel).getByLabelText("AI Chat model selection");
    expect(selectedModel.textContent).toContain("gpt-5.5-codex");
    expect(selectedModel.textContent).toContain("medium");
    expect(selectedModel.textContent).toContain("Standard");
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
      target: {
        kind: "codexCli",
        entry: "codexCli",
        selection: { model: "gpt-5.5-codex", effort: "medium", speedMode: "standard", catalogRevision: "codex-catalog-v1", setupGeneration: 1 },
      },
    });
    expect(streamBody).not.toHaveProperty("modelBehavior");

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

  it("keeps the transcript and draft when the active CLI entry changes", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(openSettingsButton());
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "AI Chat" }));
    await activateReadyCliEntry();
    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    fireEvent.change(screen.getByLabelText("AI Chat message"), { target: { value: "Keep this transcript." } });
    fireEvent.click(screen.getByRole("button", { name: "Send AI Chat message" }));
    expect(await screen.findByText("codexCli says the active file says hello.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("AI Chat message"), { target: { value: "kept draft" } });

    fireEvent.click(openSettingsButton());
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    await activateReadyCliEntry("claudeCli");
    const claudeSetup = await screen.findByLabelText("Claude Code CLI authentication and model settings");
    const claudeSpeed = within(claudeSetup).getByLabelText("Claude Code CLI inference speed");
    expect(within(claudeSpeed).getByRole("option", { name: "Standard" })).toBeTruthy();
    expect(within(claudeSpeed).getByRole("option", { name: "Fast" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    expect(screen.getByText("codexCli says the active file says hello.")).toBeTruthy();
    expect((screen.getByLabelText("AI Chat message") as HTMLTextAreaElement).value).toBe("kept draft");
    fireEvent.change(screen.getByLabelText("AI Chat message"), { target: { value: "Continue with Claude." } });
    fireEvent.click(screen.getByRole("button", { name: "Send AI Chat message" }));
    expect(await screen.findByText("claudeCli says the active file says hello.")).toBeTruthy();
  });

  it("reuses Model behavior for CLI authentication, keeps readiness for dynamic effort ids, and fails closed on a stale catalog", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(openSettingsButton());
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));

    await activateReadyCliEntry();
    expect(screen.getByRole("heading", { name: "CLI Readiness" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Authentication and model" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Model behavior" })).toBeNull();

    const setup = await screen.findByLabelText(["Co", "dex CLI authentication and model settings"].join(""));
    expect(within(setup).queryByRole("button", { name: "Sign in" })).toBeNull();
    const modelSelect = within(setup).getByLabelText(["Co", "dex CLI model"].join("")) as HTMLSelectElement;
    fireEvent.change(modelSelect, { target: { value: "gpt-5.5-codex" } });
    const effortSelect = within(setup).getByLabelText(["Co", "dex CLI reasoning effort"].join("")) as HTMLSelectElement;
    expect(within(effortSelect).getByRole("option", { name: "Max" })).toBeTruthy();
    expect(within(effortSelect).getByRole("option", { name: "Ultra" })).toBeTruthy();
    expect(within(effortSelect).getByRole("option", { name: "Experimental depth" })).toBeTruthy();
    const readinessCalls = fetchCallsTo("/api/ai/entry-readiness").length;
    fireEvent.change(effortSelect, { target: { value: "experimental-depth" } });

    const readiness = screen.getByLabelText(["Co", "dex CLI readiness"].join(""));
    expect(within(readiness).getByRole("button", { name: "Check again" })).toBeTruthy();
    expect(within(readiness).getAllByText("Success").length).toBeGreaterThan(0);
    expect(fetchCallsTo("/api/ai/entry-readiness")).toHaveLength(readinessCalls);
    expect(within(setup).getByText(/Experimental depth \/ Standard/u)).toBeTruthy();

    cliSetups.codexCli = {
      ...cliSetups.codexCli,
      message: "Catalog changed and requires an explicit model selection.",
      catalog: {
        ...cliSetups.codexCli.catalog!,
        revision: "codex-catalog-v2",
        models: [cliSetups.codexCli.catalog!.models[1]],
      },
    };
    fireEvent.click(within(setup).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect((within(setup).getByLabelText(["Co", "dex CLI model"].join("")) as HTMLSelectElement).value).toBe(""));
    expect((within(readiness).getByRole("button", { name: "Check readiness" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    expect(await screen.findByText("AI Entry is not ready.")).toBeTruthy();
  });

  it("keeps verified readiness while model, effort, and inference speed change", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(openSettingsButton());
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    const readiness = await activateReadyCliEntry();
    const setup = await screen.findByLabelText(["Co", "dex CLI authentication and model settings"].join(""));
    const readinessCalls = fetchCallsTo("/api/ai/entry-readiness").length;

    const speedSelect = within(setup).getByLabelText(["Co", "dex CLI inference speed"].join("")) as HTMLSelectElement;
    expect(within(speedSelect).getByRole("option", { name: "Standard" })).toBeTruthy();
    expect(within(speedSelect).getByRole("option", { name: "Fast" })).toBeTruthy();
    fireEvent.change(speedSelect, { target: { value: "fast" } });
    expect(speedSelect.value).toBe("fast");
    expect(within(readiness).getAllByText("Success").length).toBeGreaterThan(0);

    const effortSelect = within(setup).getByLabelText(["Co", "dex CLI reasoning effort"].join("")) as HTMLSelectElement;
    fireEvent.change(effortSelect, { target: { value: "ultra" } });
    expect(effortSelect.value).toBe("ultra");
    expect(within(readiness).getByRole("button", { name: "Check again" })).toBeTruthy();

    const modelSelect = within(setup).getByLabelText(["Co", "dex CLI model"].join("")) as HTMLSelectElement;
    fireEvent.change(modelSelect, { target: { value: "gpt-5.4-mini" } });
    expect(modelSelect.value).toBe("gpt-5.4-mini");
    expect(effortSelect.value).toBe("low");
    expect(speedSelect.value).toBe("standard");
    expect(within(speedSelect).queryByRole("option", { name: "Fast" })).toBeNull();
    expect(fetchCallsTo("/api/ai/entry-readiness")).toHaveLength(readinessCalls);
    expect(within(readiness).getAllByText("Success").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    const selected = screen.getByLabelText("AI Chat model selection");
    expect(selected.textContent).toContain("gpt-5.4-mini");
    expect(selected.textContent).toContain("low");
    expect(selected.textContent).toContain("Standard");
  });

  it("does not let delayed CLI readiness overwrite the existing success after the selected effort changes", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(openSettingsButton());
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    await activateReadyCliEntry();
    const setup = await screen.findByLabelText(["Co", "dex CLI authentication and model settings"].join(""));

    const originalFetch = fetchMock.getMockImplementation();
    let releaseReadiness!: (response: Response) => void;
    let markReadinessStarted!: () => void;
    const readinessStarted = new Promise<void>((resolve) => { markReadinessStarted = resolve; });
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/api/ai/entry-readiness") {
        markReadinessStarted();
        return new Promise<Response>((resolve) => { releaseReadiness = resolve; });
      }
      return originalFetch ? originalFetch(input, init) : json({ error: "missing fetch" }, 500);
    });

    const readiness = screen.getByLabelText(["Co", "dex CLI readiness"].join(""));
    fireEvent.click(within(readiness).getByRole("button", { name: "Check again" }));
    await readinessStarted;
    fireEvent.change(within(setup).getByLabelText(["Co", "dex CLI reasoning effort"].join("")), { target: { value: "ultra" } });
    releaseReadiness(json({
      ...aiEntryReadiness("codexCli"),
      ready: false,
      status: {
        state: "failed",
        code: "cli_unavailable",
        message: "This delayed result must be ignored.",
        checkedAt: "2026-07-17T00:00:00.000Z",
      },
    }));

    await waitFor(() => expect(within(readiness).getByRole("button", { name: "Check again" })).toBeTruthy());
    expect(within(readiness).getAllByText("Success").length).toBeGreaterThan(0);
    expect(within(readiness).queryByText("This delayed result must be ignored.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    expect(screen.queryByText("AI Entry is not ready.")).toBeNull();
    expect(screen.getByLabelText("AI Chat model selection").textContent).toContain("ultra");
  });

  it("does not apply stale CLI readiness after setup generation changes and the same pair is reselected", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(openSettingsButton());
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    await activateReadyCliEntry();
    const setup = await screen.findByLabelText(["Co", "dex CLI authentication and model settings"].join(""));
    const model = within(setup).getByLabelText(["Co", "dex CLI model"].join(""));

    const originalFetch = fetchMock.getMockImplementation();
    let releaseReadiness!: (response: Response) => void;
    let markReadinessStarted!: () => void;
    const readinessStarted = new Promise<void>((resolve) => { markReadinessStarted = resolve; });
    let delayedFirstReadiness = true;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/api/ai/entry-readiness") {
        if (delayedFirstReadiness) {
          delayedFirstReadiness = false;
          markReadinessStarted();
          return new Promise<Response>((resolve) => { releaseReadiness = resolve; });
        }
      }
      return originalFetch ? originalFetch(input, init) : json({ error: "missing fetch" }, 500);
    });

    const readiness = screen.getByLabelText(["Co", "dex CLI readiness"].join(""));
    fireEvent.click(within(readiness).getByRole("button", { name: "Check again" }));
    await readinessStarted;
    cliSetups.codexCli = { ...cliSetups.codexCli, setupGeneration: cliSetups.codexCli.setupGeneration + 1 };
    fireEvent.click(within(setup).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect((model as HTMLSelectElement).value).toBe("gpt-5.5-codex"));
    await waitFor(() => expect(within(readiness).getByRole("button", { name: "Check again" })).toBeTruthy());
    releaseReadiness(json(aiEntryReadiness("codexCli")));

    await waitFor(() => expect(within(readiness).getAllByText("Success").length).toBeGreaterThan(0));
  });

  it("shows CLI sign-in only after inspection reports loginRequired and supports cancel", async () => {
    cliSetups.codexCli = {
      ...cliSetups.codexCli,
      phase: "loginRequired",
      message: "Codex CLI is installed. Sign in with ChatGPT to load the supported model catalog.",
      authentication: { state: "idle" },
      catalog: undefined,
    };
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(openSettingsButton());
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));

    const codexEntry = screen.getByLabelText(["Co", "dex CLI entry"].join(""));
    fireEvent.click(within(codexEntry).getByRole("button", { name: "Set active" }));
    const setup = await screen.findByLabelText(["Co", "dex CLI authentication and model settings"].join(""));
    fireEvent.click(within(setup).getByRole("button", { name: "Sign in" }));

    expect(await within(setup).findByText("TEST-CODE")).toBeTruthy();
    expect(within(setup).getByRole("link", { name: "Open sign-in page" }).getAttribute("href")).toBe("https://example.test/device");
    expect(fetchCallsTo("/api/ai/cli-setup/auth/start")).toHaveLength(1);
    fireEvent.click(within(setup).getByRole("button", { name: "Cancel sign-in" }));
    await waitFor(() => expect(within(setup).getByRole("button", { name: "Sign in" })).toBeTruthy());
    expect(fetchCallsTo("/api/ai/cli-setup/auth/cancel")).toHaveLength(1);

    fireEvent.click(within(setup).getByRole("button", { name: "Sign in" }));
    expect(await within(setup).findByText("TEST-CODE")).toBeTruthy();
    cliSetups.codexCli = {
      ...createCliSetupCollection().codexCli,
      setupGeneration: cliSetups.codexCli.setupGeneration + 1,
    };
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 1_100));
    });
    await waitFor(() => expect((within(setup).getByLabelText(["Co", "dex CLI model"].join("")) as HTMLSelectElement).disabled).toBe(false));
    expect(within(setup).queryByText("TEST-CODE")).toBeNull();
  });

  it("polls both CLI snapshots and applies a global fatal invalidation to the inactive entry", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(openSettingsButton());
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    await activateReadyCliEntry("codexCli");

    cliSetups.codexCli = {
      ...cliSetups.codexCli,
      phase: "unavailable",
      message: "Global CLI process ownership was lost.",
      authentication: { state: "failed", message: "Restart Local Reader App." },
      catalog: undefined,
      failureReason: "processTreeUnverified",
    };
    cliSetups.claudeCli = {
      ...cliSetups.claudeCli,
      phase: "unavailable",
      message: "Inactive Claude snapshot was invalidated by the global fatal latch.",
      authentication: { state: "failed", message: "Restart Local Reader App." },
      catalog: undefined,
      failureReason: "processTreeUnverified",
    };
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 1_100));
    });

    expect(await screen.findByText("Global CLI process ownership was lost.")).toBeTruthy();
    const claudeEntry = screen.getByLabelText("Claude Code CLI entry");
    fireEvent.click(within(claudeEntry).getByRole("button", { name: "Set active" }));
    expect(await screen.findByText("Inactive Claude snapshot was invalidated by the global fatal latch.")).toBeTruthy();
    expect((screen.getByLabelText("Claude Code CLI model") as HTMLSelectElement).disabled).toBe(true);
  });

  it("keeps the managed latest-release check explicit and reruns readiness after confirmation", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(openSettingsButton());
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    await activateReadyCliEntry();

    const setup = await screen.findByLabelText(["Co", "dex CLI authentication and model settings"].join(""));
    const readinessCallsBeforeUpdate = fetchCallsTo("/api/ai/entry-readiness").length;
    expect(within(setup).getByText("The CLI has no availability-only check. After confirmation, its fixed updater checks for and applies a newer release if one is available.")).toBeTruthy();
    fireEvent.click(within(setup).getByRole("button", { name: "Check and apply latest" }));

    const confirmUpdate = await within(setup).findByRole("button", { name: "Run managed updater" });
    expect(fetchCallsTo("/api/ai/cli-setup/update/prepare")).toHaveLength(1);
    expect((within(setup).getByLabelText(["Co", "dex CLI model"].join("")) as HTMLSelectElement).disabled).toBe(true);
    fireEvent.click(confirmUpdate);

    await waitFor(() => expect(fetchCallsTo("/api/ai/cli-setup/update/confirm")).toHaveLength(1));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("check for and apply a newer release if available"));
    await waitFor(() => expect(fetchCallsTo("/api/ai/entry-readiness")).toHaveLength(readinessCallsBeforeUpdate + 1));
    await waitFor(() => expect(within(setup).getAllByText("Updater completed").length).toBeGreaterThan(0));
    expect((within(setup).getByLabelText(["Co", "dex CLI model"].join("")) as HTMLSelectElement).value).toBe("gpt-5.5-codex");
  });

  it("enables Codex CLI and Claude Code CLI after readiness succeeds", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    fireEvent.click(openSettingsButton());
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "AI Chat" }));

    const codexAuth = await activateReadyCliEntry();
    expect(screen.getByRole("heading", { name: "CLI Readiness" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Authentication and model" })).toBeTruthy();
    const codexDetails = screen.getByLabelText(["Co", "dex CLI readiness details"].join("")) as HTMLDetailsElement;
    expect(codexDetails.open).toBe(false);
    expect(within(codexDetails).getByLabelText("Readiness checklist").textContent).toContain("Current repo-only boundary");
    expect(within(codexAuth).getAllByText("Success").length).toBeGreaterThan(0);
    expect(fetchCallsTo("/api/ai/entry-readiness")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    expect(await screen.findByLabelText("AI Chat message")).toBeTruthy();

    fireEvent.click(openSettingsButton());
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    const claudeAuth = await activateReadyCliEntry("claudeCli");
    expect(within(claudeAuth).getAllByText("Success").length).toBeGreaterThan(0);
    expect(fetchCallsTo("/api/ai/entry-readiness")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Back to viewer" }));
    fireEvent.click(await screen.findByRole("tab", { name: "AI Chat" }));
    expect(await screen.findByLabelText("AI Chat message")).toBeTruthy();
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

async function activateReadyCliEntry(entry: "codexCli" | "claudeCli" = "codexCli"): Promise<HTMLElement> {
  const label = entry === "codexCli" ? ["Co", "dex CLI"].join("") : "Claude Code CLI";
  const card = screen.getByLabelText(`${label} entry`);
  const activate = within(card).queryByRole("button", { name: "Set active" });
  if (activate) {
    fireEvent.click(activate);
  } else {
    const setup = await screen.findByLabelText(`${label} authentication and model settings`);
    fireEvent.click(within(setup).getByRole("button", { name: "Check again" }));
  }
  const modelSelect = await screen.findByLabelText(`${label} model`) as HTMLSelectElement;
  await waitFor(() => expect(modelSelect.disabled).toBe(false));
  await waitFor(() => expect(modelSelect.value).toBe(entry === "codexCli" ? "gpt-5.5-codex" : "claude-sonnet-4-5"));
  const readiness = await screen.findByLabelText(`${label} readiness`);
  await waitFor(() => expect(within(readiness).getByRole("button", { name: "Check again" })).toBeTruthy());
  return readiness;
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

function createCliSetupCollection(): Record<AICliEntryKind, AICliSetupSnapshot> {
  const effortOptions = [
    { id: "low", label: "Low", description: null, isDefault: false },
    { id: "medium", label: "Medium", description: null, isDefault: true },
    { id: "high", label: "High", description: null, isDefault: false },
    { id: "xhigh", label: "X High", description: null, isDefault: false },
    { id: "max", label: "Max", description: null, isDefault: false },
    { id: "ultra", label: "Ultra", description: null, isDefault: false },
    { id: "experimental-depth", label: "Experimental depth", description: "Unknown future effort remains selectable.", isDefault: false },
  ];
  return {
    codexCli: {
      entry: "codexCli" as const,
      setupGeneration: 1,
      phase: "ready" as const,
      message: "Codex CLI authentication and model catalog are ready.",
      cliVersion: "codex-cli 0.144.1",
      checkedAt: "2026-07-16T00:00:00.000Z",
      compatibility: "compatible" as const,
      managedUpdateSupported: true,
      authentication: { state: "succeeded" as const, message: "Signed in." },
      update: { state: "idle" as const },
      catalog: {
        entry: "codexCli" as const,
        cliVersion: "codex-cli 0.144.1",
        revision: "codex-catalog-v1",
        fetchedAt: "2026-07-16T00:00:00.000Z",
        models: [
          {
            id: "gpt-5.5-codex",
            label: "GPT-5.5 Codex",
            description: "Primary coding model",
            isDefault: true,
            defaultEffort: "medium",
            efforts: effortOptions,
            defaultSpeedMode: "standard",
            speedModes: [
              { id: "standard", label: "Standard", description: "Regular service tier.", isDefault: true },
              { id: "fast", label: "Fast", description: "Faster inference.", isDefault: false },
            ],
          },
          {
            id: "gpt-5.4-mini",
            label: "GPT-5.4 mini",
            description: null,
            isDefault: false,
            defaultEffort: "low",
            efforts: effortOptions.slice(0, 3),
            defaultSpeedMode: "standard",
            speedModes: [{ id: "standard", label: "Standard", description: null, isDefault: true }],
          },
        ],
      },
    },
    claudeCli: {
      entry: "claudeCli" as const,
      setupGeneration: 1,
      phase: "ready" as const,
      message: "Claude Code CLI setup foundation is available for mock validation.",
      cliVersion: "2.1.199",
      checkedAt: "2026-07-16T00:00:00.000Z",
      compatibility: "compatible" as const,
      managedUpdateSupported: true,
      authentication: { state: "succeeded" as const, message: "Mock authentication state only." },
      update: { state: "idle" as const },
      foundationOnly: true,
      catalog: {
        entry: "claudeCli" as const,
        cliVersion: "2.1.199",
        revision: "claude-catalog-v1",
        fetchedAt: "2026-07-16T00:00:00.000Z",
        models: [
          {
            id: "claude-sonnet-4-5",
            label: "Claude Sonnet 4.5",
            description: "Mocked SDK catalog entry",
            isDefault: true,
            defaultEffort: "medium",
            efforts: effortOptions.slice(0, 5),
            defaultSpeedMode: "standard",
            speedModes: [
              { id: "standard", label: "Standard", description: "Regular inference.", isDefault: true },
              { id: "fast", label: "Fast", description: "Faster inference.", isDefault: false },
            ],
          },
        ],
      },
    },
  };
}

function aiEntryReadiness(entry: string, provider?: Record<string, unknown>) {
  if (entry === "aiApi" || entry === "localAi") {
    const label = entry === "aiApi" ? "AI API" : "Local AI";
    const model = String(provider?.model || "");
    const baseUrl = String(provider?.baseUrl || "");
    const credential = String(provider?.credential || "");
    const configured = entry === "aiApi"
      ? Boolean(model && credential && (provider?.provider === "openai" || baseUrl))
      : Boolean(model && baseUrl);
    const repoWrite = provider?.executionMode === "repoWrite";
    const { credential: _credential, ...publicProvider } = provider || {};
    return {
      entry,
      ready: configured,
      status: {
        state: configured ? "ready" : "notConfigured",
        code: configured ? "success" : "not_configured",
        severity: configured ? "success" : "warning",
        message: configured ? `${label} ${repoWrite ? "guarded Current repo write" : "context-only execution"} is ready.` : "Connection settings are incomplete.",
        nextAction: configured ? "Use this entry for AI Chat or check again." : "Complete the entry settings, then run readiness again.",
        checkedAt: "2026-07-03T00:00:00.000Z",
      },
      settings: { entry, ...publicProvider },
      checks: [
        { id: "provider", label: entry === "aiApi" ? "Provider settings" : "Local settings", status: configured ? "ready" : "error", message: configured ? "Ready" : "Settings are incomplete." },
        { id: "endpoint", label: "Endpoint reachable", status: configured ? "ready" : "error", message: configured ? "Ready" : "Pending settings." },
        ...(repoWrite ? [
          { id: "protocol", label: "Guarded edit protocol", status: configured ? "ready" : "error", message: configured ? "Ready" : "Pending settings." },
          { id: "workspace", label: "Workspace", status: "ready", message: "Ready" },
        ] : []),
        { id: "execution-policy", label: "Execution policy", status: "ready", message: "Ready" },
      ],
    };
  }
  const codex = entry === "codexCli";
  const label = codex ? "Codex CLI" : "Claude Code CLI";
  const message = `${label} Current repo write is ready.`;
  return {
    entry,
    ready: true,
    status: {
      state: "ready",
      code: "success",
      severity: "success",
      message,
      nextAction: "Use this entry for AI Chat or check again.",
      checkedAt: "2026-07-03T00:00:00.000Z",
    },
    settings: {
      entry,
      binaryName: codex ? "codex" : "claude",
      version: codex ? "codex-cli 0.144.1" : "2.1.199",
      authState: "configured",
      readOnlyWrapperState: "ready",
      executionMode: "repoWrite",
      lastCheckedAt: "2026-07-03T00:00:00.000Z",
      readinessMessage: message,
    },
    checks: [
      { id: "binary", label: "Binary", status: "ready", message: "Ready" },
      { id: "auth", label: "Existing CLI auth", status: "ready", message: "Ready" },
      { id: "wrapper", label: codex ? "Current repo-only write boundary" : "Repo-scoped write wrapper", status: "ready", message },
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
            substrate: "serverEditProtocol",
            auditState: "verified",
            changedPaths: [],
            repairs: [],
            warnings: [],
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
