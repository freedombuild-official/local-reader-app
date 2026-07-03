import express from "express";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { type Server } from "node:http";
import { mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createApiRouter } from "../server/api.js";
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

  it("uses fetch-only Git sync only when enabled without changing the working tree", async () => {
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
      expect(data.sync).toEqual({ state: "synced", message: "Git remote metadata fetched.", fetched: true });
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

  it("keeps serving local tree metadata when fetch-only Git sync fails", async () => {
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
      expect(data.sync).toEqual({ state: "warning", message: "Git fetch failed. Showing the current local state.", fetched: false });
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

  it("starts, reuses, stops, caps, and path-guards HTTP Delivery sessions", async () => {
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
      const firstStatus = await firstStart.json() as { sessions: Array<{ id: string; path: string; url: string }> };
      expect(firstStatus.sessions).toHaveLength(1);
      expect(firstStatus.sessions[0]).toMatchObject({ path: "README.md" });

      const reusedStart = await postJson(`${server.url}/api/http-delivery/start`, { repoId: "docs", path: "README.md" });
      const reusedStatus = await reusedStart.json() as { sessions: Array<{ id: string; path: string; url: string }> };
      expect(reusedStatus.sessions).toHaveLength(1);
      expect(reusedStatus.sessions[0].id).toBe(firstStatus.sessions[0].id);

      const delivered = await fetch(firstStatus.sessions[0].url);
      expect(delivered.status).toBe(200);
      expect(delivered.headers.get("cache-control")).toContain("no-store");
      expect(delivered.headers.get("content-type")).toContain("text/html; charset=utf-8");
      expect(delivered.headers.get("x-content-type-options")).toBe("nosniff");
      const deliveredHtml = await delivered.text();
      expect(deliveredHtml).toContain("<!doctype html>");
      expect(deliveredHtml).toContain("<h1>Hello</h1>");
      expect(deliveredHtml).not.toContain("# Hello");
      expect(deliveredHtml).not.toContain("__readerWikiUserScriptMarker");

      const pageDocument = new DOMParser().parseFromString(deliveredHtml, "text/html");
      const contentSecurityPolicy = pageDocument.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") || "";
      const inlineScript = pageDocument.querySelector("script")?.textContent || "";
      const inlineScriptHash = createHash("sha256").update(inlineScript, "utf8").digest("base64");
      expect(contentSecurityPolicy).toContain(`script-src 'sha256-${inlineScriptHash}'`);
      expect(contentSecurityPolicy).not.toContain("script-src 'unsafe-inline'");
      expect(contentSecurityPolicy).toContain("default-src 'none'");
      expect(deliveredHtml).toContain(".markdown-code-block.wrapped pre");
      expect(deliveredHtml).toContain(".markdown-code-copy-button[data-copy-state=\"copied\"]");
      expect(deliveredHtml).toContain(".markdown-code-copy-button[data-copy-state=\"error\"]");
      expect(deliveredHtml).toContain(".markdown-code-wrap-button[data-wrap-state=\"on\"]");
      expect(inlineScript).toContain("navigator.clipboard.writeText");
      expect(inlineScript).toContain("toggleCodeBlockWrap");
      expect(inlineScript).toContain("dataset.wrapState");

      const originalBody = document.body.innerHTML;
      const originalClipboard = navigator.clipboard;
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
      try {
        document.body.innerHTML = pageDocument.body.innerHTML;
        new Function(inlineScript)();
        const copyButton = document.querySelector<HTMLButtonElement>(".markdown-code-copy-button");
        const wrapButton = document.querySelector<HTMLButtonElement>(".markdown-code-wrap-button");
        const codeBlock = document.querySelector<HTMLElement>(".markdown-code-block");
        expect(copyButton).toBeTruthy();
        expect(wrapButton).toBeTruthy();
        expect(codeBlock).toBeTruthy();
        copyButton?.click();
        await new Promise((resolve) => window.setTimeout(resolve, 0));
        expect(writeText).toHaveBeenCalledWith(expect.stringContaining('console.log("copy me")'));
        expect(copyButton?.dataset.copyState).toBe("copied");

        wrapButton?.click();
        expect(codeBlock?.classList.contains("wrapped")).toBe(true);
        expect(wrapButton?.dataset.wrapState).toBe("on");
        expect(wrapButton?.getAttribute("aria-pressed")).toBe("true");
        expect(wrapButton?.getAttribute("aria-label")).toBe("Disable code wrap");
      } finally {
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: originalClipboard });
        document.body.innerHTML = originalBody;
      }

      const deliveredAsset = await fetch(new URL("asset.png", firstStatus.sessions[0].url));
      expect(deliveredAsset.status).toBe(200);
      expect(deliveredAsset.headers.get("content-type")).toBe("image/png");

      const directoryListing = await fetch(new URL("assets", firstStatus.sessions[0].url));
      expect(directoryListing.status).toBe(403);

      const outsideAsset = await fetch(`${server.url}/delivery/${firstStatus.sessions[0].id}/%2e%2e%2Freader-wiki-outside.txt`);
      expect(outsideAsset.status).toBe(403);
      expect(outsideAsset.headers.get("cache-control")).toContain("no-store");
      expect(outsideAsset.headers.get("x-content-type-options")).toBe("nosniff");
      const outsideAssetText = await outsideAsset.text();
      expect(outsideAssetText).toContain("HTTP Delivery assets must stay under the delivered file directory.");
      expect(outsideAssetText).not.toContain(root);
      expect(outsideAssetText).not.toContain(tmpdir());

      const stopped = await postJson(`${server.url}/api/http-delivery/stop`, { sessionId: firstStatus.sessions[0].id });
      await expect(stopped.json()).resolves.toMatchObject({ sessions: [] });
      expect((await fetch(firstStatus.sessions[0].url)).status).toBe(404);

      for (let index = 0; index < 5; index += 1) {
        const response = await postJson(`${server.url}/api/http-delivery/start`, { repoId: "docs", path: `file-${index}.md` });
        expect(response.status).toBe(200);
      }
      const capped = await postJson(`${server.url}/api/http-delivery/start`, { repoId: "docs", path: "file-5.md" });
      expect(capped.status).toBe(409);

      const guarded = await postJson(`${server.url}/api/http-delivery/start`, { repoId: "docs", path: "../reader-wiki-outside.txt" });
      expect(guarded.status).toBe(400);
    } finally {
      await server.close();
    }
  });
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

function postJson(url: string, payload: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
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
