import { readFileSync } from "node:fs";
import path from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";

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

beforeEach(() => {
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
      return json({ state: httpDeliverySessions.length ? "running" : "idle", sessions: httpDeliverySessions });
    }
    if (url === "/api/http-delivery/start") {
      const body = parseJsonBody(init?.body);
      const path = String(body.path || "");
      const existing = httpDeliverySessions.find((session) => session.repoId === body.repoId && session.path === path);
      if (!existing && httpDeliverySessions.length >= 5) return json({ error: "HTTP Delivery supports up to 5 active files." }, 409);
      if (!existing) {
        const id = `session-${httpDeliverySessions.length + 1}`;
        httpDeliverySessions.push({ id, repoId: String(body.repoId || "docs"), path, url: `/delivery/${id}/${path.split("/").pop() || path}`, startedAt: "2026-06-30T00:00:00.000Z" });
      }
      return json({ state: httpDeliverySessions.length ? "running" : "idle", sessions: httpDeliverySessions });
    }
    if (url === "/api/http-delivery/stop") {
      const body = parseJsonBody(init?.body);
      httpDeliverySessions = httpDeliverySessions.filter((session) => session.id !== body.sessionId);
      return json({ state: httpDeliverySessions.length ? "running" : "idle", sessions: httpDeliverySessions });
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
    await waitFor(() => expect(openedHttpDeliveryTabs[0]?.location.href).toBe("/delivery/session-1/README.md"));
    expect(screen.getByRole("link", { name: "README.md" }).getAttribute("href")).toBe("/delivery/session-1/README.md");

    fireEvent.contextMenu(screen.getByRole("tab", { name: "README.md" }), { clientX: 80, clientY: 40 });
    const menuItems = within(screen.getByRole("menu")).getAllByRole("menuitem").map((item) => item.textContent);
    expect(menuItems).toEqual(["Fix Tab", "Pin", "HTTP Delivery", "Close"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "HTTP Delivery" }));
    await waitFor(() => expect(httpDeliverySessions).toHaveLength(1));
    expect(windowOpenMock).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(openedHttpDeliveryTabs[1]?.location.href).toBe("/delivery/session-1/README.md"));

    fireEvent.click(screen.getByRole("button", { name: "Stop HTTP Delivery for README.md" }));
    await waitFor(() => expect(document.querySelector(".http-delivery-count")?.textContent).toBe("0/5"));
    expect(screen.getByText("No active files")).toBeTruthy();
  });

  it("falls back to the session link when HTTP Delivery popup opening is blocked", async () => {
    windowOpenMock.mockReturnValueOnce(null);

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Start HTTP Delivery" }));
    await waitFor(() => expect(document.querySelector(".http-delivery-count")?.textContent).toBe("1/5"));
    expect(windowOpenMock).toHaveBeenCalledTimes(1);
    expect(openedHttpDeliveryTabs).toHaveLength(0);
    expect(screen.getByRole("link", { name: "README.md" }).getAttribute("href")).toBe("/delivery/session-1/README.md");
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

  it("provides session memo render, icon actions, copy, download, and delete without adding an AI panel", async () => {
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: clipboardWrite }, configurable: true });
    const createObjectURL = vi.fn(() => "blob:reader-wiki-memo");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, configurable: true });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "AI" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Memo" }));
    const memo = screen.getByLabelText("Session memo") as HTMLTextAreaElement;
    const memoContent = "# Scratch\n\n- Review this section\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```js\nconsole.log(1)\n```";
    fireEvent.change(memo, { target: { value: memoContent } });
    expect(memo.value).toBe(memoContent);

    fireEvent.click(screen.getByRole("button", { name: "Render" }));
    expect(screen.getByRole("heading", { name: "Scratch" })).toBeTruthy();
    expect(screen.getByText("Review this section")).toBeTruthy();
    const memoPreview = screen.getByLabelText("Memo preview");
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
