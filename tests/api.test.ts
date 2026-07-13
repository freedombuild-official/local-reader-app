// @vitest-environment node

import express from "express";
import { JSDOM } from "jsdom";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { type Server } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createApiRouter } from "../server/api.js";
import { safeCliEnv, type AICommandRunner } from "../server/aiCliAdapters.js";
import type { GuardedProviderRequester } from "../server/guardedRepoEdits.js";
import { testAIConnection } from "../server/aiProviders.js";
import { createHttpDeliveryService } from "../server/httpDelivery.js";
import { createRepositoryRegistry } from "../server/repositoryRegistry.js";

const execFileAsync = promisify(execFile);
async function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = await new Promise<Server>((resolve, reject) => {
    const nextServer = app.listen(0);
    nextServer.once("listening", () => resolve(nextServer));
    nextServer.once("error", reject);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))) };
}

describe("api", () => {
  it("serves repository tree and markdown file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-api-"));
    await writeFile(path.join(root, "README.md"), "---\ntitle: Test\n---\n# Hello\n");
    const configPath = path.join(root, "repositories.yaml");
    await writeFile(configPath, `repositories:\n  - id: docs\n    label: Docs\n    root: ${root}\n    defaultPath: README.md\n`);
    const app = express();
    app.use("/api", createApiRouter(configPath));
    const server = await listen(app);
    try {
      const reposResponse = await fetch(`${server.url}/api/repos`);
      expect(reposResponse.status).toBe(200);
      await expect(reposResponse.json()).resolves.toMatchObject({ repositories: [expect.objectContaining({ id: "docs" })] });

      const treeResponse = await fetch(`${server.url}/api/tree?repo=docs&path=`);
      expect(treeResponse.status).toBe(200);
      const tree = await treeResponse.json() as { nodes: Array<{ path: string; type: string }> };
      expect(tree.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ path: "README.md", type: "file" })]));

      const fileResponse = await fetch(`${server.url}/api/file?repo=docs&path=README.md`);
      const file = await fileResponse.json() as { kind?: string; fileInfo?: { path?: string; byteLength?: number; characterCount?: number; lineCount?: number; createdAt?: string }; markdown?: { frontmatter?: string; html?: string } };
      expect(file.kind).toBe("markdown");
      expect(file.fileInfo).toMatchObject({ path: "README.md", characterCount: 28, lineCount: 5 });
      expect(file.fileInfo?.byteLength).toBeGreaterThan(0);
      expect(file.fileInfo?.createdAt).toEqual(expect.any(String));
      expect(file.markdown?.frontmatter).toContain("title: Test");
      expect(file.markdown?.html).toContain("<h1>Hello</h1>");
    } finally {
      await server.close();
    }
  });

  it("opens a repository with full tree metadata without reading file contents", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-open-api-"));
    await mkdir(path.join(root, "docs", "nested"), { recursive: true });
    await writeFile(path.join(root, "README.md"), "# Root\n");
    await writeFile(path.join(root, "docs", "guide.md"), "# Guide\n");
    await writeFile(path.join(root, "docs", "nested", "deep.txt"), "deep content\n");
    const configPath = path.join(root, "repositories.yaml");
    await writeFile(configPath, `repositories:\n  - id: docs\n    label: Docs\n    root: ${root}\n    defaultPath: README.md\n`);
    const app = express();
    app.use("/api", createApiRouter(configPath));
    const server = await listen(app);
    try {
      const response = await postJson(`${server.url}/api/repo-open`, { repoId: "docs" });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("no-store");
      const data = await response.json() as {
        repoId?: string;
        sync?: { state?: string; fetched?: boolean; message?: string };
        tree?: Record<string, Array<{ path: string; type: string; content?: string }>>;
      };
      expect(data.repoId).toBe("docs");
      expect(data.sync).toEqual({ state: "disabled", message: "Git remote fetch disabled.", fetched: false });
      expect(data.tree?.[""]).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "docs", type: "directory" }),
        expect.objectContaining({ path: "README.md", type: "file" }),
      ]));
      expect(data.tree?.docs).toEqual(expect.arrayContaining([expect.objectContaining({ path: "docs/guide.md", type: "file" })]));
      expect(data.tree?.["docs/nested"]).toEqual(expect.arrayContaining([expect.objectContaining({ path: "docs/nested/deep.txt", type: "file" })]));
      expect(data.tree?.["docs/nested"]?.[0]).not.toHaveProperty("content");
    } finally {
      await server.close();
    }
  });

  it("does not execute legacy fetchRemote requests in the public build", async () => {
    const remote = await mkdtemp(path.join(tmpdir(), "reader-wiki-remote-"));
    await git(remote, "init", "--bare");
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-git-open-"));
    await git(root, "init");
    await git(root, "config", "user.email", "reader-wiki@example.test");
    await git(root, "config", "user.name", "Reader Wiki");
    await writeFile(path.join(root, "README.md"), "# Hello\n");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "initial");
    await git(root, "remote", "add", "origin", remote);
    const configPath = path.join(root, "repositories.yaml");
    await writeFile(configPath, `repositories:\n  - id: docs\n    label: Docs\n    root: ${root}\n    defaultPath: README.md\n    fetchRemote: true\n`);
    const { stdout: beforeStatus } = await execFileAsync("git", ["-C", root, "status", "--porcelain=v1"]);
    const app = express();
    app.use("/api", createApiRouter(configPath));
    const server = await listen(app);
    try {
      const response = await postJson(`${server.url}/api/repo-open`, { repoId: "docs" });
      expect(response.status).toBe(200);
      const data = await response.json() as { sync?: { state?: string; fetched?: boolean; message?: string }; tree?: Record<string, Array<{ path: string }>> };
      expect(data.sync).toEqual({ state: "disabled", message: "Git remote fetch is disabled by the public execution policy.", fetched: false });
      expect(data.tree?.[""]).toEqual(expect.arrayContaining([expect.objectContaining({ path: "README.md" })]));
      const { stdout: afterStatus } = await execFileAsync("git", ["-C", root, "status", "--porcelain=v1"]);
      expect(String(afterStatus).trim()).toBe(String(beforeStatus).trim());
    } finally {
      await server.close();
    }
  });

  it("does not fetch Git remotes by default", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-git-disabled-"));
    await git(root, "init");
    await git(root, "config", "user.email", "reader-wiki@example.test");
    await git(root, "config", "user.name", "Reader Wiki");
    await writeFile(path.join(root, "README.md"), "# Hello\n");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "initial");
    await git(root, "remote", "add", "origin", path.join(root, "missing-remote.git"));
    const configPath = path.join(root, "repositories.yaml");
    await writeFile(configPath, `repositories:\n  - id: docs\n    label: Docs\n    root: ${root}\n    defaultPath: README.md\n`);
    const app = express();
    app.use("/api", createApiRouter(configPath));
    const server = await listen(app);
    try {
      const response = await postJson(`${server.url}/api/repo-open`, { repoId: "docs" });
      expect(response.status).toBe(200);
      const data = await response.json() as { sync?: { state?: string; fetched?: boolean; message?: string }; tree?: Record<string, Array<{ path: string }>> };
      expect(data.sync).toEqual({ state: "disabled", message: "Git remote fetch disabled.", fetched: false });
      expect(data.tree?.[""]).toEqual(expect.arrayContaining([expect.objectContaining({ path: "README.md" })]));
    } finally {
      await server.close();
    }
  });

  it("keeps serving local tree metadata without invoking a configured missing remote", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-git-open-fail-"));
    await git(root, "init");
    await git(root, "config", "user.email", "reader-wiki@example.test");
    await git(root, "config", "user.name", "Reader Wiki");
    await writeFile(path.join(root, "README.md"), "# Hello\n");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "initial");
    await git(root, "remote", "add", "origin", path.join(root, "missing-remote.git"));
    const configPath = path.join(root, "repositories.yaml");
    await writeFile(configPath, `repositories:\n  - id: docs\n    label: Docs\n    root: ${root}\n    defaultPath: README.md\n    fetchRemote: true\n`);
    const app = express();
    app.use("/api", createApiRouter(configPath));
    const server = await listen(app);
    try {
      const response = await postJson(`${server.url}/api/repo-open`, { repoId: "docs" });
      expect(response.status).toBe(200);
      const data = await response.json() as { sync?: { state?: string; fetched?: boolean; message?: string }; tree?: Record<string, Array<{ path: string }>> };
      expect(data.sync).toEqual({ state: "disabled", message: "Git remote fetch is disabled by the public execution policy.", fetched: false });
      expect(data.tree?.[""]).toEqual(expect.arrayContaining([expect.objectContaining({ path: "README.md" })]));
    } finally {
      await server.close();
    }
  });

  it("serves changed, deleted, and binary git markers without text badges", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-git-api-"));
    await git(root, "init");
    await git(root, "config", "user.email", "reader-wiki@example.test");
    await git(root, "config", "user.name", "Reader Wiki");
    await writeFile(path.join(root, "README.md"), "# Hello\nold line\n");
    await writeFile(path.join(root, "deleted.md"), "# Deleted\nold body\n");
    await writeFile(path.join(root, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
    await git(root, "add", ".");
    await git(root, "commit", "-m", "initial");

    await writeFile(path.join(root, "README.md"), "# Hello\nnew line\n");
    await unlink(path.join(root, "deleted.md"));
    await writeFile(path.join(root, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]));

    const configPath = path.join(root, "repositories.yaml");
    await writeFile(configPath, `repositories:\n  - id: docs\n    label: Docs\n    root: ${root}\n    defaultPath: README.md\n`);
    const app = express();
    app.use("/api", createApiRouter(configPath));
    const server = await listen(app);
    try {
      const treeResponse = await fetch(`${server.url}/api/tree?repo=docs&path=`);
      const tree = await treeResponse.json() as { nodes: Array<{ path: string; gitStatus?: string }> };
      expect(tree.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "README.md", gitStatus: "changed" }),
        expect.objectContaining({ path: "deleted.md", gitStatus: "deleted" }),
        expect.objectContaining({ path: "image.png", gitStatus: "binary" }),
      ]));

      const changedResponse = await fetch(`${server.url}/api/file?repo=docs&path=README.md`);
      const changedFile = await changedResponse.json() as { gitDiff?: { status?: string; changedLines?: number[] }; fileInfo?: { gitStatus?: string } };
      expect(changedFile.fileInfo?.gitStatus).toBe("changed");
      expect(changedFile.gitDiff).toEqual({ status: "changed", changedLines: [2] });

      const deletedResponse = await fetch(`${server.url}/api/file?repo=docs&path=deleted.md`);
      const deletedFile = await deletedResponse.json() as { content?: string; fileInfo?: { gitStatus?: string; viewerStatus?: string; createdAt?: string | null }; gitDiff?: { status?: string; changedLines?: number[] } };
      expect(deletedFile.content).toContain("# Deleted");
      expect(deletedFile.fileInfo).toMatchObject({ gitStatus: "deleted", viewerStatus: "deleted", createdAt: null });
      expect(deletedFile.gitDiff).toEqual({ status: "deleted", changedLines: [1, 2, 3] });

      const binaryResponse = await fetch(`${server.url}/api/file?repo=docs&path=image.png`);
      const binaryFile = await binaryResponse.json() as { kind?: string; fileInfo?: { gitStatus?: string; viewerStatus?: string }; gitDiff?: { status?: string; changedLines?: number[] } };
      expect(binaryFile.kind).toBe("image");
      expect(binaryFile.fileInfo).toMatchObject({ gitStatus: "changed", viewerStatus: "displayable" });
      expect(binaryFile.gitDiff).toEqual({ status: "binary", changedLines: [] });
    } finally {
      await server.close();
    }
  });

  it("serves Markdown extracted from .docx and metadata for unsupported files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-docx-api-"));
    await mkdir(path.join(root, "word"), { recursive: true });
    const documentXml = [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
      "<w:body>",
      "<w:p><w:r><w:t># From Docx</w:t></w:r></w:p>",
      "<w:p><w:r><w:t>Body text</w:t></w:r></w:p>",
      "</w:body>",
      "</w:document>",
    ].join("");
    await writeFile(path.join(root, "source.docx"), createZip([{ name: "word/document.xml", data: Buffer.from(documentXml) }]));
    await writeFile(path.join(root, "archive.zip"), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const configPath = path.join(root, "repositories.yaml");
    await writeFile(configPath, `repositories:\n  - id: docs\n    label: Docs\n    root: ${root}\n    defaultPath: source.docx\n`);
    const app = express();
    app.use("/api", createApiRouter(configPath));
    const server = await listen(app);
    try {
      const docxResponse = await fetch(`${server.url}/api/file?repo=docs&path=source.docx`);
      const docxFile = await docxResponse.json() as {
        kind?: string;
        content?: string;
        fileInfo?: { mimeType?: string; type?: string; viewerStatus?: string; characterCount?: number; lineCount?: number };
        docx?: { source?: string; byteLength?: number };
      };
      expect(docxResponse.status).toBe(200);
      expect(docxFile.kind).toBe("markdown");
      expect(docxFile.content).toContain("# From Docx");
      expect(docxFile.fileInfo).toMatchObject({ type: "Markdown", viewerStatus: "displayable", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
      expect(docxFile.fileInfo?.characterCount).toBeGreaterThan(0);
      expect(docxFile.fileInfo?.lineCount).toBe(2);
      expect(docxFile.docx).toMatchObject({ source: "markdown-in-docx", byteLength: expect.any(Number) });

      const unsupportedResponse = await fetch(`${server.url}/api/file?repo=docs&path=archive.zip`);
      const unsupportedFile = await unsupportedResponse.json() as { kind?: string; fileInfo?: { type?: string; viewerStatus?: string; characterCount?: number; lineCount?: number } };
      expect(unsupportedResponse.status).toBe(200);
      expect(unsupportedFile.kind).toBe("unsupported");
      expect(unsupportedFile.fileInfo).toMatchObject({ type: "Unsupported", viewerStatus: "unsupported", characterCount: 0, lineCount: 0 });
    } finally {
      await server.close();
    }
  });

  it("starts, reuses, stops, caps, and path-guards HTTP Delivery items", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-http-delivery-api-"));
    await writeFile(
      path.join(root, "README.md"),
      [
        "# Hello",
        "",
        "```ts",
        'console.log("copy me")',
        "```",
        "",
        '<script>globalThis.__readerWikiUserScriptMarker = true</script>',
        "",
        "![Asset](asset.png)",
        "",
      ].join("\n"),
    );
    await writeFile(path.join(root, "asset.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
    await writeFile(path.join(root, "credentials.json"), '{"secret":"not-deliverable"}');
    await writeFile(path.join(root, "active.html"), "<script>fetch('/api/repos')</script>");
    await writeFile(path.join(root, "active.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/repos")</script></svg>');
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets", "inside.txt"), "inside\n");
    await writeFile(path.join(tmpdir(), "reader-wiki-outside.txt"), "outside\n");
    for (let index = 0; index < 6; index += 1) {
      await writeFile(path.join(root, `file-${index}.md`), `# File ${index}\n`);
    }
    const configPath = path.join(root, "repositories.yaml");
    await writeFile(configPath, `repositories:\n  - id: docs\n    label: Docs\n    root: ${root}\n    defaultPath: README.md\n`);
    const registry = createRepositoryRegistry({ configPath });
    const delivery = createHttpDeliveryService(registry);
    const app = express();
    app.use("/api", createApiRouter(registry, delivery));
    app.use("/delivery", delivery.router);
    const server = await listen(app);
    try {
      const firstStart = await postJson(`${server.url}/api/http-delivery/start`, { repoId: "docs", path: "README.md" });
      expect(firstStart.status).toBe(200);
      const firstStatus = await firstStart.json() as { items: Array<{ id: string; path: string; url: string }> };
      expect(firstStatus.items).toHaveLength(1);
      expect(firstStatus.items[0]).toMatchObject({ path: "README.md" });

      const reusedStart = await postJson(`${server.url}/api/http-delivery/start`, { repoId: "docs", path: "README.md" });
      const reusedStatus = await reusedStart.json() as { items: Array<{ id: string; path: string; url: string }> };
      expect(reusedStatus.items).toHaveLength(1);
      expect(reusedStatus.items[0].id).toBe(firstStatus.items[0].id);

      const delivered = await fetch(firstStatus.items[0].url);
      expect(delivered.status).toBe(200);
      expect(delivered.headers.get("cache-control")).toContain("no-store");
      expect(delivered.headers.get("content-type")).toContain("text/html; charset=utf-8");
      expect(delivered.headers.get("x-content-type-options")).toBe("nosniff");
      const deliveredHtml = await delivered.text();
      expect(deliveredHtml).toContain("<!doctype html>");
      expect(deliveredHtml).toContain("<h1>Hello</h1>");
      expect(deliveredHtml).not.toContain("# Hello");
      expect(deliveredHtml).not.toContain("__readerWikiUserScriptMarker");
      expect(deliveredHtml).toContain(`/delivery/${firstStatus.items[0].id}?asset=asset.png`);
      expect(deliveredHtml).not.toContain("/api/image");

      const pageDom = new JSDOM(deliveredHtml, { runScripts: "outside-only" });
      const pageWindow = pageDom.window;
      const pageDocument = pageWindow.document;
      const contentSecurityPolicy = pageDocument.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") || "";
      const inlineScript = pageDocument.querySelector("script")?.textContent || "";
      const inlineScriptHash = createHash("sha256").update(inlineScript, "utf8").digest("base64");
      expect(contentSecurityPolicy).toContain(`script-src 'sha256-${inlineScriptHash}'`);
      expect(contentSecurityPolicy).not.toContain("script-src 'unsafe-inline'");
      expect(contentSecurityPolicy).toContain("default-src 'none'");
      expect(delivered.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(delivered.headers.get("content-security-policy")).toContain("connect-src 'none'");
      expect(deliveredHtml).toContain(".markdown-code-block.wrapped pre");
      expect(deliveredHtml).toContain(".markdown-code-copy-button[data-copy-state=\"copied\"]");
      expect(deliveredHtml).toContain(".markdown-code-copy-button[data-copy-state=\"error\"]");
      expect(deliveredHtml).toContain(".markdown-code-wrap-button[data-wrap-state=\"on\"]");
      expect(inlineScript).toContain("navigator.clipboard.writeText");
      expect(inlineScript).toContain("toggleCodeBlockWrap");
      expect(inlineScript).toContain("dataset.wrapState");

      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(pageWindow.navigator, "clipboard", { configurable: true, value: { writeText } });
      pageWindow.eval(inlineScript);
      const copyButton = pageDocument.querySelector<HTMLButtonElement>(".markdown-code-copy-button");
      const wrapButton = pageDocument.querySelector<HTMLButtonElement>(".markdown-code-wrap-button");
      const codeBlock = pageDocument.querySelector<HTMLElement>(".markdown-code-block");
      expect(copyButton).toBeTruthy();
      expect(wrapButton).toBeTruthy();
      expect(codeBlock).toBeTruthy();
      copyButton?.click();
      await new Promise((resolve) => pageWindow.setTimeout(resolve, 0));
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining('console.log("copy me")'));
      expect(copyButton?.dataset.copyState).toBe("copied");

      wrapButton?.click();
      expect(codeBlock?.classList.contains("wrapped")).toBe(true);
      expect(wrapButton?.dataset.wrapState).toBe("on");
      expect(wrapButton?.getAttribute("aria-pressed")).toBe("true");
      expect(wrapButton?.getAttribute("aria-label")).toBe("Disable code wrap");
      pageWindow.close();

      const deliveredAsset = await fetch(new URL("asset.png", firstStatus.items[0].url));
      expect(deliveredAsset.status).toBe(200);
      expect(deliveredAsset.headers.get("content-type")).toBe("image/png");

      expect((await fetch(new URL("credentials.json", firstStatus.items[0].url))).status).toBe(403);

      const directoryListing = await fetch(new URL("assets", firstStatus.items[0].url));
      expect(directoryListing.status).toBe(403);

      const outsideAsset = await fetch(`${server.url}/delivery/${firstStatus.items[0].id}/%2e%2e%2Freader-wiki-outside.txt`);
      expect(outsideAsset.status).toBe(403);
      expect(outsideAsset.headers.get("cache-control")).toContain("no-store");
      expect(outsideAsset.headers.get("x-content-type-options")).toBe("nosniff");
      const outsideAssetText = await outsideAsset.text();
      expect(outsideAssetText).toContain("HTTP Delivery assets must stay under the delivered file directory.");
      expect(outsideAssetText).not.toContain(root);
      expect(outsideAssetText).not.toContain(tmpdir());

      const stopped = await postJson(`${server.url}/api/http-delivery/stop`, { deliveryId: firstStatus.items[0].id });
      await expect(stopped.json()).resolves.toMatchObject({ items: [] });
      expect((await fetch(firstStatus.items[0].url)).status).toBe(404);

      for (let index = 0; index < 5; index += 1) {
        const response = await postJson(`${server.url}/api/http-delivery/start`, { repoId: "docs", path: `file-${index}.md` });
        expect(response.status).toBe(200);
      }
      const capped = await postJson(`${server.url}/api/http-delivery/start`, { repoId: "docs", path: "file-5.md" });
      expect(capped.status).toBe(409);

      const guarded = await postJson(`${server.url}/api/http-delivery/start`, { repoId: "docs", path: "../reader-wiki-outside.txt" });
      expect(guarded.status).toBe(400);

      expect((await postJson(`${server.url}/api/http-delivery/start`, { repoId: "docs", path: "active.html" })).status).toBe(415);
      expect((await postJson(`${server.url}/api/http-delivery/start`, { repoId: "docs", path: "active.svg" })).status).toBe(415);
    } finally {
      await server.close();
    }
  });

  it("validates, previews, and saves repository config without touching repository directories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-settings-api-"));
    const secondRoot = await mkdtemp(path.join(tmpdir(), "reader-wiki-settings-second-api-"));
    await writeFile(path.join(root, "README.md"), "# Hello\n");
    const configPath = path.join(root, "repositories.yaml");
    await writeFile(configPath, `repositories:\n  - id: docs\n    label: Docs\n    root: ${root}\n    defaultPath: README.md\n    excludes:\n      - .git\n`);
    const app = express();
    app.use("/api", createApiRouter(configPath));
    const server = await listen(app);
    try {
      const stateResponse = await fetch(`${server.url}/api/repository-config`);
      expect(stateResponse.status).toBe(200);
      const state = await stateResponse.json() as { configPath?: string; entries?: Array<{ id?: string; fetchRemote?: boolean }>; validation?: { valid?: boolean } };
      expect(state.configPath).toBe(configPath);
      expect(state.entries).toEqual([expect.objectContaining({ id: "docs", fetchRemote: false })]);
      expect(state.validation?.valid).toBe(true);

      const draft = {
        entries: [
          { id: "docs", label: "Docs", root, defaultPath: "README.md", excludes: [".git", "node_modules"], fetchRemote: false },
          { id: "second", label: "Second", root: secondRoot, defaultPath: "", excludes: [".git"], fetchRemote: true },
        ],
      };
      const previewResponse = await postJson(`${server.url}/api/repository-config/preview`, draft);
      expect(previewResponse.status).toBe(200);
      const preview = await previewResponse.json() as { yaml?: string; validation?: { valid?: boolean } };
      expect(preview.validation?.valid).toBe(true);
      expect(preview.yaml).toContain("id: second");
      expect(preview.yaml).toContain("fetchRemote: true");
      expect(preview.yaml).not.toContain("fetchRemote: false");

      const beforeReadme = await readFileText(path.join(root, "README.md"));
      const saveResponse = await postJson(`${server.url}/api/repository-config/save`, draft);
      expect(saveResponse.status).toBe(200);
      expect(await readFileText(path.join(root, "README.md"))).toBe(beforeReadme);
      expect(await readFileText(configPath)).toContain("id: second");

      const invalidResponse = await postJson(`${server.url}/api/repository-config/validate`, { entries: [{ id: "bad", label: "Bad", root: "./relative", defaultPath: "../escape", excludes: ["../out"], fetchRemote: false }] });
      expect(invalidResponse.status).toBe(200);
      const invalid = await invalidResponse.json() as { valid?: boolean; checks?: Array<{ status?: string; message?: string }> };
      expect(invalid.valid).toBe(false);
      expect(invalid.checks?.some((item) => item.status === "error")).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("runs Local AI directly with explicit context and no repository write access", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-ai-api-"));
    await mkdir(path.join(root, "private"));
    await writeFile(path.join(root, "README.md"), "# AI Context\n\nVisible content\n");
    await writeFile(path.join(root, "AGENTS.md"), "# Repo Rules\n\nUse project rules.\n");
    await mkdir(path.join(root, "docs", "nested"), { recursive: true });
    await writeFile(path.join(root, "docs", "guide.md"), "# Guide\n");
    await writeFile(path.join(root, "docs", "nested", "deep.md"), "# Deep\n");
    await writeFile(path.join(root, "private", "notes.md"), "# Hidden\n");
    const configPath = path.join(root, "repositories.yaml");
    await writeFile(configPath, `repositories:\n  - id: docs\n    label: Docs\n    root: ${root}\n    defaultPath: README.md\n    excludes:\n      - private\n`);
    await initGitRepo(root);
    const calls: Array<{ binary: string; args: string[]; cwd: string; input: string; env: NodeJS.ProcessEnv }> = [];
    const runner: AICommandRunner = async (binary, args, options) => {
      calls.push({ binary, args, cwd: options.cwd, input: options.input || "", env: options.env });
      throw new Error("Direct provider execution must not invoke a CLI adapter.");
    };
    const app = express();
    app.use("/v1", express.json({ limit: "100kb" }));
    app.get("/v1/models", (_request, response) => response.json({ data: [{ id: "openai/gpt-oss-20b" }] }));
    app.post("/v1/chat/completions", (request, response) => {
      const body = request.body as { messages?: Array<{ content?: string }> };
      const joined = (body.messages || []).map((message) => message.content || "").join("\n");
      response.json({ choices: [{ message: { content: joined.includes("Visible content") ? "I can read the active file." : "Connection ready." } }] });
    });
    app.use("/api", createApiRouter(configPath, undefined, { aiCommandRunner: runner }));
    const server = await listen(app);
    const provider = {
      entry: "localAi" as const,
      runtime: "openaiLocal" as const,
      model: "openai/gpt-oss-20b",
      baseUrl: `${server.url}/v1`,
      apiFormat: "openaiCompatible" as const,
      credential: "local-readiness-secret",
    };
    try {
      const testResponse = await postJson(`${server.url}/api/ai/test-connection`, provider);
      expect(testResponse.status).toBe(200);
      const providerStatus = await testResponse.json() as { state?: string; code?: string; severity?: string; nextAction?: string };
      expect(providerStatus).toMatchObject({ state: "ready", code: "success", severity: "success", nextAction: expect.any(String) });

      const readinessResponse = await postJson(`${server.url}/api/ai/entry-readiness`, { entry: "localAi", provider, repoId: "docs" });
      expect(readinessResponse.status).toBe(200);
      const readiness = await readinessResponse.json() as { ready?: boolean; status?: { state?: string; code?: string }; settings?: { entry?: string } };
      expect(readiness).toMatchObject({ ready: true, status: { state: "ready", code: "success" }, settings: { entry: "localAi" } });
      expect(readiness.settings).not.toHaveProperty("credential");
      expect(JSON.stringify(readiness)).not.toContain("local-readiness-secret");
      expect((readiness as { checks?: Array<{ id?: string; message?: string }> }).checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "execution-policy", message: expect.stringContaining("cannot write") }),
      ]));

      const unverifiedResponse = await postJson(`${server.url}/api/ai/chat`, {
        target: { kind: "codexBackedLocal", provider },
        messages: [{ role: "user", content: "Read hidden notes." }],
        context: { repoId: "docs", primaryPaths: [{ path: "private/notes.md", includeContent: true }] },
      });
      expect(unverifiedResponse.status).toBe(409);

      const chatResponse = await postJson(`${server.url}/api/ai/chat`, {
        target: { kind: "codexBackedLocal", provider, status: readiness.status },
        messages: [{ role: "user", content: "Summarize this file." }],
        context: { repoId: "docs", primaryPaths: [{ path: "README.md", includeContent: true, source: "manual" }], rulePaths: [{ path: "AGENTS.md", source: "auto-root-rule" }] },
      });
      expect(chatResponse.status).toBe(200);
      const chat = await chatResponse.json() as {
        message?: { content?: string };
        context?: { primaryItems?: Array<{ contentIncluded?: boolean; path?: string }>; ruleItems?: Array<{ path?: string; content?: string }>; systemPromptVersion?: string };
        run?: { accessMode?: string; changedPaths?: Array<{ path?: string; status?: string }>; substrate?: string; entry?: string };
      };
      expect(chat.message?.content).toContain("active file");
      expect(chat.context?.systemPromptVersion).toBe("2.3.0");
      expect(chat.context?.primaryItems?.[0]).toMatchObject({ path: "README.md", contentIncluded: true });
      expect(chat.context?.ruleItems?.[0]).toMatchObject({ path: "AGENTS.md", content: expect.stringContaining("Use project rules") });
      expect(chat.run).toMatchObject({
        accessMode: "readOnly",
        entry: "localAi",
        substrate: "directProvider",
        changedPaths: [],
      });
      expect(calls).toEqual([]);
      await expect(readFile(path.join(root, "ai-api-output.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const missingRuleResponse = await postJson(`${server.url}/api/ai/chat`, {
        target: { kind: "codexBackedLocal", provider, status: readiness.status },
        messages: [{ role: "user", content: "Use missing rules only." }],
        context: { repoId: "docs", rulePaths: [{ path: "CLAUDE.md", source: "auto-root-rule" }] },
      });
      expect(missingRuleResponse.status).toBe(200);
      const missingRuleChat = await missingRuleResponse.json() as { context?: { ruleItems?: unknown[]; primaryItems?: unknown[] } };
      expect(missingRuleChat.context?.ruleItems).toEqual([]);
      expect(missingRuleChat.context?.primaryItems).toEqual([]);

      const directoryResponse = await postJson(`${server.url}/api/ai/chat`, {
        target: { kind: "codexBackedLocal", provider, status: readiness.status },
        messages: [{ role: "user", content: "Summarize docs." }],
        context: { repoId: "docs", primaryPaths: [{ path: "docs", kind: "directory", source: "manual" }] },
      });
      expect(directoryResponse.status).toBe(200);
      const directoryChat = await directoryResponse.json() as { context?: { primaryItems?: Array<{ kind?: string; content?: string }> } };
      expect(directoryChat.context?.primaryItems?.[0]).toMatchObject({ kind: "directory", content: expect.stringContaining("docs/guide.md") });
      expect(directoryChat.context?.primaryItems?.[0]?.content).not.toContain("deep.md");

      const streamResponse = await postJson(`${server.url}/api/ai/chat/stream`, {
        target: { kind: "codexBackedLocal", provider, status: readiness.status },
        messages: [{ role: "user", content: "Summarize this file with attachment." }],
        context: { repoId: "docs", primaryPaths: [{ path: "README.md", includeContent: true, source: "manual" }], rulePaths: [{ path: "AGENTS.md", source: "auto-root-rule" }] },
        attachments: [{ id: "a1", name: "note.md", mimeType: "text/markdown", sizeBytes: 5, contentIncluded: true, content: "Note." }],
        modelBehavior: { kind: "intelligence", level: "medium" },
      });
      expect(streamResponse.status).toBe(200);
      const streamEvents = await readJsonLines(streamResponse);
      expect(streamEvents.map((event) => event.type)).toEqual(["meta", "delta", "done"]);
      expect(streamEvents[1]).toMatchObject({ type: "delta", content: expect.stringContaining("active file") });
      expect(streamEvents[2]).toMatchObject({ type: "done", message: { content: expect.stringContaining("active file") }, run: { accessMode: "readOnly", entry: "localAi", substrate: "directProvider", changedPaths: [] } });

      const excludedResponse = await postJson(`${server.url}/api/ai/chat`, {
        target: { kind: "codexBackedLocal", provider, status: readiness.status },
        messages: [{ role: "user", content: "Read hidden notes." }],
        context: { repoId: "docs", primaryPaths: [{ path: "private/notes.md", includeContent: true }] },
      });
      expect(excludedResponse.status).toBe(403);
    } finally {
      await server.close();
    }
  });

  it("runs Local AI repo-wide with no selected path and with directory or multiple-path context", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-local-repo-wide-"));
    const previousPromptPath = process.env.READER_WIKI_AI_CHAT_SYSTEM_PROMPT;
    await mkdir(path.join(root, "docs"), { recursive: true });
    await mkdir(path.join(root, "public", ".codex"), { recursive: true });
    await writeFile(path.join(root, "README.md"), "alpha\n");
    await writeFile(path.join(root, "SECOND.md"), "second\n");
    await writeFile(path.join(root, "docs", "guide.md"), "guide\n");
    await writeFile(path.join(root, "public", "visible.md"), "visible\n");
    await writeFile(path.join(root, "public", ".codex", "private.md"), "protected nested name\n");
    await mkdir(path.join(root, ".codex"));
    await mkdir(path.join(root, ".agents"));
    await writeFile(path.join(root, ".codex", "private.md"), "protected\n");
    await writeFile(path.join(root, ".agents", "private.md"), "protected\n");
    await writeFile(path.join(root, "ai-system.md"), "---\nversion: 9.9.9-test\n---\nLocal Reader App test system prompt.\n");
    process.env.READER_WIKI_AI_CHAT_SYSTEM_PROMPT = path.join(root, "ai-system.md");
    const configPath = path.join(root, "repositories.yaml");
    await writeFile(configPath, `repositories:\n  - id: docs\n    label: Docs\n    root: ${root}\n    defaultPath: README.md\n    excludes:\n      - .git\n`);

    const cliCalls: string[] = [];
    const runner: AICommandRunner = async (binary) => {
      cliCalls.push(binary);
      throw new Error("Guarded provider execution must not invoke a CLI adapter.");
    };
    const providerCalls: Array<{ systemPrompt?: string; messages?: Array<{ role: string; content: string }> }> = [];
    let runCount = 0;
    const requester: GuardedProviderRequester = async (request) => {
      providerCalls.push(request);
      const protocolMessages = request.messages || [];
      const latest = JSON.parse(protocolMessages.at(-1)?.content || "{}") as { type?: string; synthetic?: boolean };
      if (latest.type === "capability_check") {
        return { content: JSON.stringify({
          version: "reader-wiki.edit-protocol.v1",
          type: "read",
          paths: ["reader-wiki-capability-probe.md"],
          operations: null,
          message: null,
        }), status: readyProviderStatus() };
      }
      if (latest.type === "read_result" && latest.synthetic) {
        return { content: JSON.stringify({
          version: "reader-wiki.edit-protocol.v1",
          type: "apply",
          paths: null,
          operations: [{
            op: "replace",
            path: "reader-wiki-capability-probe.md",
            content: null,
            oldText: "Local Reader App capability probe: before",
            newText: "Local Reader App capability probe: after",
          }],
          message: "ready",
        }), status: readyProviderStatus() };
      }
      if (latest.type === "task") {
        runCount += 1;
        return {
          content: JSON.stringify({ version: "reader-wiki.edit-protocol.v1", type: "read", paths: runCount === 1 ? ["README.md"] : ["SECOND.md", "docs/guide.md"] }),
          status: readyProviderStatus(),
        };
      }
      return {
        content: JSON.stringify(runCount === 1
          ? {
            version: "reader-wiki.edit-protocol.v1",
            type: "apply",
            operations: [
              { op: "write", path: "README.md", content: "alpha-updated\n" },
              { op: "write", path: "generated/nested/result.md", content: "created\n" },
            ],
            message: "Local repo-wide run 1 completed.",
          }
          : {
            version: "reader-wiki.edit-protocol.v1",
            type: "apply",
            operations: [
              { op: "write", path: "SECOND.md", content: "second-updated\n" },
              { op: "write", path: "docs/guide.md", content: "guide-updated\n" },
            ],
            message: "Local repo-wide run 2 completed.",
          }),
        status: readyProviderStatus(),
      };
    };
    const app = express();
    app.use("/api", createApiRouter(configPath, undefined, { aiCommandRunner: runner, aiProviderRequester: requester }));
    const server = await listen(app);
    const provider = {
      entry: "localAi" as const,
      runtime: "lmStudio" as const,
      model: "openai/gpt-oss-20b",
      baseUrl: "http://127.0.0.1:1234/v1",
      apiFormat: "openaiCompatible" as const,
      credential: "",
      executionMode: "repoWrite" as const,
    };

    try {
      const readinessResponse = await postJson(`${server.url}/api/ai/entry-readiness`, { entry: "localAi", provider, repoId: "docs" });
      expect(readinessResponse.status).toBe(200);
      const readiness = await readinessResponse.json() as { status: { state?: string; code?: string }; checks?: Array<{ id?: string; status?: string }> };
      expect(readiness.status).toMatchObject({ state: "ready", code: "success" });
      expect(readiness.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "protocol", status: "ready" }),
        expect.objectContaining({ id: "workspace", status: "ready" }),
      ]));

      const noPathResponse = await postJson(`${server.url}/api/ai/chat`, {
        target: { kind: "codexBackedLocal", provider, status: readiness.status },
        messages: [{ role: "user", content: "Update the repo and create a nested result." }],
        context: { repoId: "docs", primaryPaths: [] },
      });
      expect(noPathResponse.status).toBe(200);
      await expect(noPathResponse.json()).resolves.toMatchObject({
        message: { content: expect.stringContaining("Local repo-wide run 1 completed.") },
        run: { accessMode: "repoWrite", entry: "localAi", substrate: "serverEditProtocol", changedPaths: expect.arrayContaining([
          { path: "README.md", status: "changed" },
          { path: "generated/nested/result.md", status: "new" },
        ]) },
      });

      const streamResponse = await postJson(`${server.url}/api/ai/chat/stream`, {
        target: { kind: "codexBackedLocal", provider, status: readiness.status },
        messages: [{ role: "user", content: "Update both selected contexts." }],
        context: { repoId: "docs", primaryPaths: [
          { path: "docs", kind: "directory", source: "manual", includeContent: true },
          { path: "public", kind: "directory", source: "manual", includeContent: true },
          { path: "SECOND.md", kind: "file", source: "manual", includeContent: true },
        ] },
      });
      expect(streamResponse.status).toBe(200);
      const events = await readJsonLines(streamResponse);
      expect(events.map((event) => event.type)).toEqual(["meta", "delta", "done"]);
      expect(events[2]).toMatchObject({ run: { changedPaths: expect.arrayContaining([
        { path: "SECOND.md", status: "changed" },
        { path: "docs/guide.md", status: "changed" },
      ]) } });
      expect(cliCalls).toEqual([]);
      expect(providerCalls.filter((call) => call.messages?.some((message) => message.content.includes('"type":"task"')))).toHaveLength(4);
      expect(providerCalls.some((call) => call.systemPrompt?.includes("no shell, filesystem, Git"))).toBe(true);
      const providerVisibleMessages = providerCalls.flatMap((call) => call.messages || []).map((message) => message.content).join("\n");
      expect(providerVisibleMessages).not.toContain(root);
      expect(providerVisibleMessages).not.toContain("repositories.yaml");
      expect(providerVisibleMessages).not.toContain("public/.codex");
      expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("alpha-updated\n");
      expect(await readFile(path.join(root, "generated/nested/result.md"), "utf8")).toBe("created\n");
      expect(await readFile(path.join(root, "SECOND.md"), "utf8")).toBe("second-updated\n");
      expect(await readFile(path.join(root, "docs/guide.md"), "utf8")).toBe("guide-updated\n");

      for (const protectedPath of [".codex/private.md", ".agents/private.md", "repositories.yaml", "ai-system.md"]) {
        const callsBeforeProtectedContext = providerCalls.length;
        const protectedResponse = await postJson(`${server.url}/api/ai/chat`, {
          target: { kind: "codexBackedLocal", provider, status: readiness.status },
          messages: [{ role: "user", content: "Read the protected file." }],
          context: { repoId: "docs", primaryPaths: [{ path: protectedPath, kind: "file", source: "manual", includeContent: true }] },
        });
        expect(protectedResponse.status).toBe(403);
        expect(providerCalls).toHaveLength(callsBeforeProtectedContext);
      }
    } finally {
      await server.close();
      if (previousPromptPath === undefined) delete process.env.READER_WIKI_AI_CHAT_SYSTEM_PROMPT;
      else process.env.READER_WIKI_AI_CHAT_SYSTEM_PROMPT = previousPromptPath;
    }
  }, 15_000);

  it("classifies provider readiness failures without surfacing raw fetch errors", async () => {
    const app = express();
    app.use("/v1", express.json({ limit: "100kb" }));
    app.get("/v1/auth-required/models", (_request, response) => response.status(401).json({ error: { message: "raw auth detail" } }));
    app.get("/v1/model-missing/models", (_request, response) => response.json({ data: [{ id: "other-model" }] }));
    app.get("/v1/http-error/models", (_request, response) => response.status(404).json({}));
    app.post("/v1/http-error/chat/completions", (_request, response) => response.status(500).json({ error: { message: "raw provider detail" } }));
    const server = await listen(app);
    try {
      const base = {
        entry: "aiApi" as const,
        provider: "openaiCompatible" as const,
        model: "wanted-model",
        apiFormat: "openaiCompatible" as const,
        credential: "test-key",
      };
      const localBase = {
        entry: "localAi" as const,
        runtime: "lmStudio" as const,
        model: "wanted-model",
        apiFormat: "openaiCompatible" as const,
        credential: "",
      };

      await expect(testAIConnection({ ...base, baseUrl: "not a url" })).resolves.toMatchObject({
        state: "failed",
        code: "invalid_endpoint",
        severity: "error",
        nextAction: expect.any(String),
      });
      await expect(testAIConnection({ ...base, baseUrl: "http://127.0.0.1:9/v1" })).resolves.toMatchObject({
        state: "failed",
        code: "invalid_endpoint",
        severity: "error",
      });
      await expect(testAIConnection({ ...base, baseUrl: "https://127.0.0.1:443/v1" })).resolves.toMatchObject({
        state: "failed",
        code: "invalid_endpoint",
        severity: "error",
        message: expect.stringContaining("private"),
      });
      await expect(testAIConnection({ ...localBase, baseUrl: `${server.url}/v1/auth-required` })).resolves.toMatchObject({
        state: "failed",
        code: "credential_required",
        severity: "warning",
        message: "Provider rejected the credential.",
      });
      await expect(testAIConnection({ ...localBase, baseUrl: `${server.url}/v1/model-missing` })).resolves.toMatchObject({
        state: "failed",
        code: "model_missing",
        severity: "warning",
        message: "Model is not visible at this endpoint.",
      });
      await expect(testAIConnection({ ...localBase, baseUrl: `${server.url}/v1/http-error` })).resolves.toMatchObject({
        state: "failed",
        code: "provider_http_error",
        severity: "error",
        message: "Provider returned HTTP 500.",
      });

      const controller = new AbortController();
      controller.abort();
      await expect(testAIConnection({ ...localBase, baseUrl: `${server.url}/v1/model-missing` }, controller.signal)).resolves.toMatchObject({
        state: "failed",
        code: "timeout_or_abort",
        severity: "warning",
      });
    } finally {
      await server.close();
    }
  });

  it("runs Codex CLI and Claude Code CLI directly in the Current repo after readiness", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-cli-direct-"));
    await writeFile(path.join(root, "README.md"), "# CLI direct execution\n");
    const configPath = path.join(root, "repositories.yaml");
    await writeFile(configPath, `repositories:\n  - id: docs\n    label: Docs\n    root: ${root}\n    defaultPath: README.md\n`);
    const calls: Array<{ binary: string; args: string[]; input: string; cwd: string }> = [];
    const runner: AICommandRunner = async (binary, args, options) => {
      calls.push({ binary, args, input: options.input || "", cwd: options.cwd });
      if (binary === "codex") {
        if (args.includes("--version")) return { stdout: "codex-cli 0.144.1\n", stderr: "" };
        if (args.includes("login")) return { stdout: "Logged in using ChatGPT\n", stderr: "" };
        if (args.includes("--help")) return { stdout: "--strict-config --disable --config --cd --ignore-user-config --skip-git-repo-check --ephemeral --json\n", stderr: "" };
        if (args.includes("mcp")) return { stdout: '[{"name":"project-tools","transport":{"type":"stdio"}}]', stderr: "" };
        if (options.input) {
          await mkdir(path.join(options.cwd, "codex", "nested"), { recursive: true });
          await writeFile(path.join(options.cwd, "codex", "nested", "result.md"), "# Codex result\n");
          return { stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"Codex updated the Current repo."}}\n', stderr: "" };
        }
      }
      if (binary === "claude") {
        if (args.includes("--version")) return { stdout: "2.1.199 (Claude Code)\n", stderr: "" };
        if (args.includes("auth")) return { stdout: '{"loggedIn":true}\n', stderr: "" };
        if (args.includes("--help")) return { stdout: `${"diagnostic filler ".repeat(900)} --print --output-format --tools --permission-mode --safe-mode --no-chrome --disable-slash-commands --strict-mcp-config --mcp-config --setting-sources --settings --no-session-persistence\n`, stderr: "" };
        if (args[args.indexOf("--tools") + 1] === "") return { stdout: JSON.stringify({ is_error: false, result: "READY" }), stderr: "" };
        if (options.input) {
          await mkdir(path.join(options.cwd, "claude", "nested"), { recursive: true });
          await writeFile(path.join(options.cwd, "claude", "nested", "result.md"), "# Claude result\n");
          return { stdout: JSON.stringify({ is_error: false, result: "Claude updated the Current repo." }), stderr: "" };
        }
      }
      throw new Error("Unexpected CLI command");
    };
    const app = express();
    app.use("/api", createApiRouter(configPath, undefined, { aiCommandRunner: runner, aiCliPlatform: "linux" }));
    const server = await listen(app);
    try {
      for (const entry of ["codexCli", "claudeCli"] as const) {
        const readinessResponse = await postJson(`${server.url}/api/ai/entry-readiness`, { entry, repoId: "docs" });
        expect(readinessResponse.status).toBe(200);
        const readiness = await readinessResponse.json() as {
          ready?: boolean;
          status?: { state?: string; code?: string };
          settings?: { authState?: string; readOnlyWrapperState?: string; executionMode?: string };
          checks?: Array<{ label?: string; status?: string }>;
        };
        expect(readiness).toMatchObject({
          ready: true,
          status: { state: "ready", code: "success" },
          settings: { authState: "configured", readOnlyWrapperState: "ready", executionMode: "repoWrite" },
        });
        expect(readiness.checks).toEqual(expect.arrayContaining([
          expect.objectContaining({ label: "Current repo CLI execution", status: "ready" }),
        ]));
        const chatResponse = await postJson(`${server.url}/api/ai/chat`, {
          target: { kind: entry, entry, status: readiness.status },
          messages: [{ role: "user", content: "Create a nested result file in the Current repo." }],
          context: { repoId: "docs", primaryPaths: entry === "codexCli" ? [{ path: "repositories.yaml", includeContent: true, source: "manual" }] : [] },
        });
        expect(chatResponse.status).toBe(200);
        await expect(chatResponse.json()).resolves.toMatchObject({
          message: { content: expect.stringContaining(entry === "codexCli" ? "Codex" : "Claude") },
          run: {
            accessMode: "repoWrite",
            entry,
            substrate: entry,
            changedPaths: [{ path: `${entry === "codexCli" ? "codex" : "claude"}/nested/result.md`, status: "new" }],
          },
        });
        const chatCall = calls.find((call) => {
          if (call.binary !== (entry === "codexCli" ? "codex" : "claude") || !call.input) return false;
          return entry === "codexCli" || call.args[call.args.indexOf("--tools") + 1] !== "";
        });
        expect(chatCall?.cwd).toBe(await realpath(root));
        if (entry === "codexCli") {
          expect(chatCall?.args).toEqual(expect.arrayContaining(["--strict-config", "--ignore-user-config", "-C", await realpath(root)]));
          expect(chatCall?.args.some((argument) => /^default_permissions="reader_wiki_[a-f0-9]{32}"$/.test(argument))).toBe(true);
          expect(chatCall?.args).toContain('mcp_servers."project-tools"={enabled=false,command="reader-wiki-disabled-mcp",args=[]}');
          expect(chatCall?.args).not.toContain("--add-dir");
        } else {
          expect(chatCall?.args).toEqual(expect.arrayContaining(["--setting-sources", "", "--tools", "Bash,Glob,Grep,Read,Edit,Write", "--permission-mode", "acceptEdits"]));
          expect(chatCall?.args).not.toContain("--max-budget-usd");
        }
      }
      expect(calls).toHaveLength(11);
    } finally {
      await server.close();
    }
  });

  it("keeps raw CLI failure output out of the AI Chat stream", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-cli-natural-error-api-"));
    await writeFile(path.join(root, "README.md"), "# Natural CLI error\n");
    const configPath = path.join(root, "repositories.yaml");
    await writeFile(configPath, `repositories:\n  - id: docs\n    label: Docs\n    root: ${root}\n    defaultPath: README.md\n`);
    const runner: AICommandRunner = async (_binary, args, options) => {
      if (args.includes("--version")) return { stdout: "codex-cli 0.144.1\n", stderr: "" };
      if (args.includes("login")) return { stdout: "Logged in using ChatGPT\n", stderr: "" };
      if (args.includes("--help")) return { stdout: "--strict-config --disable --config --cd --ignore-user-config --skip-git-repo-check --ephemeral --json\n", stderr: "" };
      if (args.includes("mcp")) return { stdout: "[]", stderr: "" };
      if (options.input) throw new Error("RAW_STDOUT_SENTINEL RAW_STDERR_SENTINEL CLI exited with code 17");
      throw new Error("Unexpected CLI command");
    };
    const app = express();
    app.use("/api", createApiRouter(configPath, undefined, { aiCommandRunner: runner }));
    const server = await listen(app);
    try {
      const readinessResponse = await postJson(`${server.url}/api/ai/entry-readiness`, { entry: "codexCli", repoId: "docs" });
      const readiness = await readinessResponse.json() as { status: { state?: string; code?: string } };
      expect(readiness).toMatchObject({ status: { state: "ready", code: "success" } });
      const streamResponse = await postJson(`${server.url}/api/ai/chat/stream`, {
        target: { kind: "codexCli", entry: "codexCli", status: readiness.status },
        messages: [{ role: "user", content: "Complete the request." }],
        context: { repoId: "docs", primaryPaths: [] },
      });
      expect(streamResponse.status).toBe(200);
      const events = await readJsonLines(streamResponse);
      expect(events.at(-1)).toMatchObject({
        type: "error",
        error: "Codex CLI could not complete the request. Check readiness and try again.",
        details: { run: { accessMode: "repoWrite", entry: "codexCli", substrate: "codexCli" } },
      });
      expect(JSON.stringify(events)).not.toContain("RAW_STDOUT_SENTINEL");
      expect(JSON.stringify(events)).not.toContain("RAW_STDERR_SENTINEL");
      expect(JSON.stringify(events)).not.toContain("code 17");
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reuses Claude authentication readiness across repo switches and follow-up edits", async () => {
    const firstRoot = await mkdtemp(path.join(tmpdir(), "reader-wiki-claude-lease-first-"));
    const secondRoot = await mkdtemp(path.join(tmpdir(), "reader-wiki-claude-lease-second-"));
    await writeFile(path.join(firstRoot, "README.md"), "# First repo\n");
    await writeFile(path.join(secondRoot, "README.md"), "# Second repo\n");
    const configPath = path.join(firstRoot, "repositories.yaml");
    await writeFile(configPath, [
      "repositories:",
      "  - id: first",
      "    label: First",
      `    root: ${firstRoot}`,
      "    defaultPath: README.md",
      "  - id: second",
      "    label: Second",
      `    root: ${secondRoot}`,
      "    defaultPath: README.md",
      "",
    ].join("\n"));
    const calls: Array<{ args: string[]; cwd: string; input: string }> = [];
    let chatRuns = 0;
    const runner: AICommandRunner = async (binary, args, options) => {
      expect(binary).toBe("claude");
      calls.push({ args, cwd: options.cwd, input: options.input || "" });
      if (args.includes("--version")) return { stdout: "2.1.206 (Claude Code)\n", stderr: "" };
      if (args.includes("auth")) return { stdout: '{"loggedIn":true}\n', stderr: "" };
      if (args.includes("--help")) {
        return { stdout: "--print --output-format --tools --permission-mode --safe-mode --no-chrome --disable-slash-commands --strict-mcp-config --mcp-config --setting-sources --settings --no-session-persistence\n", stderr: "" };
      }
      if (args[args.indexOf("--tools") + 1] === "") return { stdout: JSON.stringify({ is_error: false, result: "READY" }), stderr: "" };
      chatRuns += 1;
      await mkdir(path.join(options.cwd, "claude"), { recursive: true });
      await writeFile(path.join(options.cwd, "claude", "result.md"), `# Run ${chatRuns}\n`);
      return { stdout: JSON.stringify({ is_error: false, result: `Claude completed run ${chatRuns}.` }), stderr: "" };
    };
    const app = express();
    app.use("/api", createApiRouter(configPath, undefined, { aiCommandRunner: runner, aiCliPlatform: "linux" }));
    const server = await listen(app);
    try {
      const readinessResponse = await postJson(`${server.url}/api/ai/entry-readiness`, { entry: "claudeCli", repoId: "first" });
      expect(readinessResponse.status).toBe(200);
      const readiness = await readinessResponse.json() as { ready?: boolean; status: { state?: string; code?: string } };
      expect(readiness).toMatchObject({ ready: true, status: { state: "ready", code: "success" } });
      const request = {
        target: { kind: "claudeCli", entry: "claudeCli", status: readiness.status },
        messages: [{ role: "user", content: "Update the result in the newly selected Current repo." }],
        context: { repoId: "second", primaryPaths: [] },
      };
      expect((await postJson(`${server.url}/api/ai/chat`, request)).status).toBe(200);
      expect((await postJson(`${server.url}/api/ai/chat`, request)).status).toBe(200);
      expect(chatRuns).toBe(2);
      expect(calls.filter((call) => call.args.includes("auth"))).toHaveLength(1);
      expect(calls.filter((call) => call.args[call.args.indexOf("--tools") + 1] === "")).toHaveLength(1);
      const editingCalls = calls.filter((call) => call.args.includes("Bash,Glob,Grep,Read,Edit,Write"));
      expect(editingCalls).toHaveLength(2);
      const secondCanonicalRoot = await realpath(secondRoot);
      expect(editingCalls.every((call) => call.cwd === secondCanonicalRoot)).toBe(true);
    } finally {
      await server.close();
      await rm(firstRoot, { recursive: true, force: true });
      await rm(secondRoot, { recursive: true, force: true });
    }
  });

  it("renews missing and expired provider-write readiness leases while sliding valid leases", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-readiness-lease-"));
    await writeFile(path.join(root, "README.md"), "# Readiness Lease\n");
    const configPath = path.join(root, "repositories.yaml");
    await writeFile(configPath, `repositories:\n  - id: docs\n    label: Docs\n    root: ${root}\n    defaultPath: README.md\n`);
    let now = 1_000;
    let capabilityChecks = 0;
    let editRequests = 0;
    const requester: GuardedProviderRequester = async (request) => {
      const latest = JSON.parse(request.messages?.at(-1)?.content || "{}") as { type?: string; synthetic?: boolean };
      if (latest.type === "capability_check") {
        capabilityChecks += 1;
        return { content: JSON.stringify({
          version: "reader-wiki.edit-protocol.v1",
          type: "read",
          paths: ["reader-wiki-capability-probe.md"],
          operations: null,
          message: null,
        }), status: readyProviderStatus() };
      }
      if (latest.type === "read_result" && latest.synthetic) {
        return { content: JSON.stringify({
          version: "reader-wiki.edit-protocol.v1",
          type: "apply",
          paths: null,
          operations: [{
            op: "replace",
            path: "reader-wiki-capability-probe.md",
            content: null,
            oldText: "Local Reader App capability probe: before",
            newText: "Local Reader App capability probe: after",
          }],
          message: "ready",
        }), status: readyProviderStatus() };
      }
      if (latest.type === "task") {
        editRequests += 1;
        return { content: JSON.stringify({ version: "reader-wiki.edit-protocol.v1", type: "complete", message: "No change required." }), status: readyProviderStatus() };
      }
      throw new Error("Unexpected guarded provider message");
    };
    const app = express();
    app.use("/api", createApiRouter(configPath, undefined, {
      aiProviderRequester: requester,
      readinessAttestationTtlMs: 100,
      readinessAttestationNow: () => now,
    }));
    const server = await listen(app);
    const provider = {
      entry: "localAi" as const,
      runtime: "lmStudio" as const,
      model: "local-model",
      baseUrl: "http://127.0.0.1:1234/v1",
      apiFormat: "openaiCompatible" as const,
      credential: "",
      executionMode: "repoWrite" as const,
    };
    const staleReadyStatus = { state: "ready", code: "success", severity: "success", message: "Browser still shows Success.", checkedAt: "2026-07-11T00:00:00.000Z" };
    const request = {
      target: { kind: "codexBackedLocal", provider, status: staleReadyStatus },
      messages: [{ role: "user", content: "Answer without changing files." }],
      context: { repoId: "docs", primaryPaths: [] },
    };
    try {
      expect((await postJson(`${server.url}/api/ai/chat`, request)).status).toBe(200);
      expect({ capabilityChecks, editRequests }).toEqual({ capabilityChecks: 1, editRequests: 1 });
      now = 1_050;
      expect((await postJson(`${server.url}/api/ai/chat`, request)).status).toBe(200);
      now = 1_120;
      const slidingStream = await postJson(`${server.url}/api/ai/chat/stream`, request);
      expect(slidingStream.status).toBe(200);
      expect((await readJsonLines(slidingStream)).at(-1)).toMatchObject({ type: "done", run: { substrate: "serverEditProtocol", changedPaths: [] } });
      expect({ capabilityChecks, editRequests }).toEqual({ capabilityChecks: 1, editRequests: 3 });
      now = 1_221;
      expect((await postJson(`${server.url}/api/ai/chat`, request)).status).toBe(200);
      expect({ capabilityChecks, editRequests }).toEqual({ capabilityChecks: 2, editRequests: 4 });
    } finally {
      await server.close();
    }
  });

  it("uses a canonical provider fingerprint for readiness leases", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-provider-attestation-"));
    await writeFile(path.join(root, "README.md"), "# Provider Attestation\n");
    const configPath = path.join(root, "repositories.yaml");
    await writeFile(configPath, `repositories:\n  - id: docs\n    label: Docs\n    root: ${root}\n    defaultPath: README.md\n`);
    let modelChecks = 0;
    const providerApp = express();
    providerApp.use("/v1", express.json({ limit: "256kb" }));
    providerApp.get("/v1/models", (_request, response) => {
      modelChecks += 1;
      response.json({ data: [{ id: "local-model" }] });
    });
    providerApp.post("/v1/chat/completions", (_request, response) => response.json({ choices: [{ message: { content: "Canonical provider answer." } }] }));
    const providerServer = await listen(providerApp);
    const app = express();
    app.use("/api", createApiRouter(configPath));
    const server = await listen(app);
    const readinessProvider = {
      entry: "localAi" as const,
      runtime: "lmStudio" as const,
      model: "local-model",
      baseUrl: `${providerServer.url}/v1`,
      apiFormat: "openaiCompatible" as const,
      credential: "",
      executionMode: "readOnly" as const,
    };
    const reorderedProvider = {
      executionMode: "readOnly" as const,
      credential: "",
      apiFormat: "openaiCompatible" as const,
      baseUrl: `${providerServer.url}/v1`,
      model: "local-model",
      runtime: "lmStudio" as const,
      entry: "localAi" as const,
    };
    try {
      const readinessResponse = await postJson(`${server.url}/api/ai/entry-readiness`, { entry: "localAi", provider: readinessProvider, repoId: "docs" });
      const readiness = await readinessResponse.json() as { status: { state?: string; code?: string } };
      expect(readiness.status).toMatchObject({ state: "ready", code: "success" });
      expect(modelChecks).toBe(1);
      const chatResponse = await postJson(`${server.url}/api/ai/chat`, {
        target: { kind: "codexBackedLocal", provider: reorderedProvider, status: readiness.status },
        messages: [{ role: "user", content: "Answer from context only." }],
        context: { repoId: "docs", primaryPaths: [] },
      });
      expect(chatResponse.status).toBe(200);
      expect(modelChecks).toBe(1);
    } finally {
      await Promise.all([server.close(), providerServer.close()]);
    }
  });

  it("forwards only Claude CLI auth environment to Claude while keeping provider credentials isolated", () => {
    const original = {
      CODEX_API_KEY: process.env.CODEX_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    };
    try {
      process.env.CODEX_API_KEY = "codex-api-key-test-value";
      process.env.OPENAI_API_KEY = "openai-api-key-test-value";
      process.env.ANTHROPIC_API_KEY = "anthropic-api-key-test-value";
      process.env.ANTHROPIC_AUTH_TOKEN = "anthropic-auth-redacted-value";
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "claude-code-oauth-redacted-value";
      process.env.CLAUDE_CONFIG_DIR = path.join(tmpdir(), "reader-wiki-test-claude-config");
      process.env.CODEX_HOME = path.join(tmpdir(), "reader-wiki-default-codex-home");
      expect(safeCliEnv("codexCli")).not.toHaveProperty("CODEX_API_KEY");
      expect(safeCliEnv("codexCli")).not.toHaveProperty("OPENAI_API_KEY");
      expect(safeCliEnv("codexCli")).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(safeCliEnv("claudeCli")).toMatchObject({
        ANTHROPIC_API_KEY: "anthropic-api-key-test-value",
        ANTHROPIC_AUTH_TOKEN: "anthropic-auth-redacted-value",
        CLAUDE_CODE_OAUTH_TOKEN: "claude-code-oauth-redacted-value",
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      });
      expect(safeCliEnv("aiApi")).not.toHaveProperty("CODEX_HOME");
      expect(safeCliEnv("aiApi", { CODEX_HOME: "/tmp/reader-wiki-isolated", READER_WIKI_AI_API_KEY: "credential-value" })).toMatchObject({ CODEX_HOME: "/tmp/reader-wiki-isolated", READER_WIKI_AI_API_KEY: "credential-value" });
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("blocks CLI chat when readiness is not confirmed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-cli-not-ready-api-"));
    await writeFile(path.join(root, "README.md"), "# CLI Not Ready\n");
    const configPath = path.join(root, "repositories.yaml");
    await writeFile(configPath, `repositories:\n  - id: docs\n    label: Docs\n    root: ${root}\n    defaultPath: README.md\n`);
    await initGitRepo(root);
    const calls: Array<{ binary: string; args: string[]; input: string }> = [];
    const runner: AICommandRunner = async (binary, args, options) => {
      calls.push({ binary, args, input: options.input || "" });
      if (args.includes("--version")) return { stdout: "codex-cli 0.142.5\n", stderr: "" };
      if (args.includes("login")) return { stdout: "Not logged in\n", stderr: "" };
      if (args.includes("--help")) return { stdout: "codex exec help\n", stderr: "" };
      throw new Error("readiness execution failed");
    };
    const app = express();
    app.use("/api", createApiRouter(configPath, undefined, { aiCommandRunner: runner }));
    const server = await listen(app);
    try {
      const response = await postJson(`${server.url}/api/ai/chat`, {
        target: { kind: "codexCli", entry: "codexCli", status: { state: "ready", code: "success", severity: "success", message: "stale ready", checkedAt: "2026-07-05T00:00:00.000Z" } },
        messages: [{ role: "user", content: "Summarize." }],
        context: { repoId: "docs", path: "README.md", includeContent: true },
      });
      expect(response.status).toBe(409);
      const body = await response.json() as { error?: string };
      expect(body.error).toContain("auth");
      expect(calls.some((call) => call.input.includes("CLI Not Ready"))).toBe(false);
      expect(calls).toHaveLength(4);
      expect(calls.every((call) => call.input === "")).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("rejects stale repository revisions and expires Delivery capabilities after a hand-edited root change", async () => {
    const firstRoot = await mkdtemp(path.join(tmpdir(), "reader-wiki-revision-first-"));
    const secondRoot = await mkdtemp(path.join(tmpdir(), "reader-wiki-revision-second-"));
    await writeFile(path.join(firstRoot, "README.md"), "# First root\n");
    await writeFile(path.join(secondRoot, "README.md"), "# Second root private marker\n");
    const configPath = path.join(firstRoot, "repositories.yaml");
    await writeFile(configPath, `repositories:\n  - id: docs\n    label: Docs\n    root: ${firstRoot}\n    defaultPath: README.md\n`);
    const registry = createRepositoryRegistry({ configPath });
    const delivery = createHttpDeliveryService(registry);
    const app = express();
    app.use("/api", createApiRouter(registry, delivery));
    app.use("/delivery", delivery.router);
    const server = await listen(app);
    try {
      const reposResponse = await fetch(`${server.url}/api/repos`);
      const repos = await reposResponse.json() as { repositories?: Array<{ id?: string; revision?: string }> };
      const staleRevision = repos.repositories?.[0]?.revision || "";
      const deliveryStart = await postJson(`${server.url}/api/http-delivery/start`, { repoId: "docs", path: "README.md" });
      const deliveryState = await deliveryStart.json() as { items?: Array<{ url?: string }> };
      const deliveryUrl = deliveryState.items?.[0]?.url || "";

      await writeFile(configPath, `repositories:\n  - id: docs\n    label: Docs\n    root: ${secondRoot}\n    defaultPath: README.md\n`);
      const staleOpen = await fetch(`${server.url}/api/repo-open`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoId: "docs", expectedRevision: staleRevision }),
      });
      expect(staleOpen.status).toBe(409);
      await expect(staleOpen.json()).resolves.toMatchObject({ details: { currentRevision: expect.not.stringMatching(staleRevision) } });
      const expiredDelivery = await fetch(deliveryUrl);
      expect(expiredDelivery.status).toBe(409);
      expect(await expiredDelivery.text()).not.toContain("Second root private marker");
    } finally {
      await server.close();
    }
  });

  it.skipIf(process.platform === "win32")("disables repository-controlled Git fsmonitor, external diff, and textconv executables", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-git-policy-"));
    const fsmonitorMarker = path.join(tmpdir(), `reader-wiki-fsmonitor-${path.basename(root)}`);
    const diffMarker = path.join(tmpdir(), `reader-wiki-diff-${path.basename(root)}`);
    const fsmonitorProbe = path.join(root, "fsmonitor-probe.js");
    const diffProbe = path.join(root, "diff-probe.js");
    await writeFile(path.join(root, "README.md"), "# Safe Git metadata\n");
    await writeFile(path.join(root, ".gitattributes"), "README.md diff=reader\n");
    await writeFile(fsmonitorProbe, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(fsmonitorMarker)}, "executed");\n`);
    await writeFile(diffProbe, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(diffMarker)}, "executed");\n`);
    await chmod(fsmonitorProbe, 0o755);
    await chmod(diffProbe, 0o755);
    const configPath = path.join(root, "repositories.yaml");
    await writeFile(configPath, `repositories:\n  - id: docs\n    label: Docs\n    root: ${root}\n    defaultPath: README.md\n`);
    await initGitRepo(root);
    await git(root, "config", "diff.external", diffProbe);
    await git(root, "config", "diff.reader.textconv", diffProbe);
    await git(root, "config", "core.fsmonitor", fsmonitorProbe);
    await writeFile(path.join(root, "README.md"), "# Safe Git metadata\n\nchanged\n");
    const app = express();
    app.use("/api", createApiRouter(configPath));
    const server = await listen(app);
    try {
      expect((await fetch(`${server.url}/api/tree?repo=docs&path=`)).status).toBe(200);
      const fileResponse = await fetch(`${server.url}/api/file?repo=docs&path=README.md`);
      expect(fileResponse.status).toBe(200);
      await expect(fileResponse.json()).resolves.toMatchObject({ gitDiff: { status: "changed" } });
      await expect(readFile(fsmonitorMarker)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(diffMarker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await server.close();
    }
  });

});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function initGitRepo(cwd: string): Promise<void> {
  await git(cwd, "init");
  await git(cwd, "config", "user.email", "reader-wiki@example.test");
  await git(cwd, "config", "user.name", "Reader Wiki");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-m", "initial");
}

async function postJson(url: string, payload: unknown): Promise<Response> {
  const parsedUrl = new URL(url);
  let nextPayload = payload;
  if (payload && typeof payload === "object") {
    const source = payload as Record<string, unknown>;
    const context = source.context && typeof source.context === "object" ? source.context as Record<string, unknown> : null;
    const repoId = String(source.repoId || context?.repoId || "");
    const needsRepoRevision = ["/api/repo-open", "/api/http-delivery/start", "/api/ai/entry-readiness", "/api/ai/chat", "/api/ai/chat/stream"].includes(parsedUrl.pathname) && repoId;
    if (needsRepoRevision) {
      const reposResponse = await fetch(`${parsedUrl.origin}/api/repos`);
      const repos = await reposResponse.json() as { repositories?: Array<{ id?: string; revision?: string }> };
      const revision = repos.repositories?.find((repo) => repo.id === repoId)?.revision || "";
      nextPayload = context
        ? { ...source, context: { ...context, expectedRevision: revision } }
        : { ...source, expectedRevision: revision };
    }
    if (parsedUrl.pathname === "/api/repository-config/save") {
      const configResponse = await fetch(`${parsedUrl.origin}/api/repository-config`);
      const config = await configResponse.json() as { configRevision?: string };
      nextPayload = { ...source, expectedConfigRevision: config.configRevision || "" };
    }
  }
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(nextPayload),
  });
}

async function readJsonLines(response: Response): Promise<Array<{ type?: string; content?: string; message?: { content?: string } }>> {
  const text = await response.text();
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as { type?: string; content?: string; message?: { content?: string } });
}

function readyProviderStatus() {
  return { state: "ready" as const, code: "success" as const, severity: "success" as const, message: "Response received.", checkedAt: new Date(0).toISOString() };
}

async function readFileText(filePath: string): Promise<string> {
  return (await import("node:fs/promises")).readFile(filePath, "utf8");
}

function createZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const crc = crc32(entry.data);
    const localHeader = Buffer.alloc(30 + name.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(entry.data.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    name.copy(localHeader, 30);
    localParts.push(localHeader, entry.data);

    const centralHeader = Buffer.alloc(46 + name.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(entry.data.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    name.copy(centralHeader, 46);
    centralParts.push(centralHeader);
    offset += localHeader.length + entry.data.length;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
  endOfCentralDirectory.writeUInt16LE(0, 4);
  endOfCentralDirectory.writeUInt16LE(0, 6);
  endOfCentralDirectory.writeUInt16LE(entries.length, 8);
  endOfCentralDirectory.writeUInt16LE(entries.length, 10);
  endOfCentralDirectory.writeUInt32LE(centralSize, 12);
  endOfCentralDirectory.writeUInt32LE(centralOffset, 16);
  endOfCentralDirectory.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, endOfCentralDirectory]);
}

const CRC32_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
