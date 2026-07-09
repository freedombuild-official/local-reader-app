import express from "express";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { type Server } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createApiRouter } from "../server/api.js";
import { safeCliEnv, type AICommandRunner } from "../server/aiCliAdapters.js";
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

      const deliveredAsset = await fetch(new URL("asset.png", firstStatus.items[0].url));
      expect(deliveredAsset.status).toBe(200);
      expect(deliveredAsset.headers.get("content-type")).toBe("image/png");

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
    } finally {
      await server.close();
    }
  });

  it("validates, previews, and saves repository config without touching repository directories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-settings-api-"));
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
          { id: "second", label: "Second", root, defaultPath: "", excludes: [".git"], fetchRemote: true },
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

  it("checks Codex-backed AI API readiness and answers with guarded repo-scoped write context", async () => {
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
      if (binary !== "codex") throw new Error("Unexpected command");
      if (args.includes("--version")) return { stdout: "codex-cli 0.143.0\n", stderr: "" };
      if (args.includes("--help")) return { stdout: "--sandbox workspace-write --ephemeral --json --profile --oss --local-provider\n", stderr: "" };
      if (options.input) {
        await writeFile(path.join(options.cwd, "ai-api-output.md"), "# AI API output\n");
        return { stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"I can read the active file and perform repo-scoped write."}}\n', stderr: "" };
      }
      throw new Error("Unexpected command");
    };
    const app = express();
    app.use("/v1", express.json({ limit: "100kb" }));
    app.post("/v1/chat/completions", (request, response) => {
      const body = request.body as { messages?: Array<{ content?: string }> };
      const joined = (body.messages || []).map((message) => message.content || "").join("\n");
      response.json({ choices: [{ message: { content: joined.includes("Visible content") ? "I can read the active file." : "Connection ready." } }] });
    });
    app.use("/api", createApiRouter(configPath, undefined, { aiCommandRunner: runner }));
    const server = await listen(app);
    const provider = {
      entry: "aiApi",
      provider: "openaiCompatible",
      model: "local-test",
      baseUrl: `${server.url}/v1`,
      apiFormat: "openaiCompatible",
      credential: "test-key",
    };
    try {
      const testResponse = await postJson(`${server.url}/api/ai/test-connection`, provider);
      expect(testResponse.status).toBe(200);
      const providerStatus = await testResponse.json() as { state?: string; code?: string; severity?: string; nextAction?: string };
      expect(providerStatus).toMatchObject({ state: "ready", code: "success", severity: "success", nextAction: expect.any(String) });

      const readinessResponse = await postJson(`${server.url}/api/ai/entry-readiness`, { entry: "aiApi", provider, repoId: "docs" });
      expect(readinessResponse.status).toBe(200);
      const readiness = await readinessResponse.json() as { ready?: boolean; status?: { state?: string; code?: string }; settings?: { entry?: string } };
      expect(readiness).toMatchObject({ ready: true, status: { state: "ready", code: "success" }, settings: { entry: "aiApi" } });

      const unverifiedResponse = await postJson(`${server.url}/api/ai/chat`, {
        target: { kind: "codexBackedProvider", provider },
        messages: [{ role: "user", content: "Read hidden notes." }],
        context: { repoId: "docs", primaryPaths: [{ path: "private/notes.md", includeContent: true }] },
      });
      expect(unverifiedResponse.status).toBe(409);

      const chatResponse = await postJson(`${server.url}/api/ai/chat`, {
        target: { kind: "codexBackedProvider", provider, status: readiness.status },
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
      expect(chat.context?.systemPromptVersion).toBe("2.0.0");
      expect(chat.context?.primaryItems?.[0]).toMatchObject({ path: "README.md", contentIncluded: true });
      expect(chat.context?.ruleItems?.[0]).toMatchObject({ path: "AGENTS.md", content: expect.stringContaining("Use project rules") });
      expect(chat.run).toMatchObject({
        accessMode: "repoWrite",
        entry: "aiApi",
        substrate: "codexCli",
        changedPaths: [expect.objectContaining({ path: "ai-api-output.md", status: "new" })],
      });
      const chatCall = calls.find((call) => call.input.includes("Visible content"));
      expect(chatCall?.cwd).toBe(await realpath(root));
      expect(chatCall?.args).toEqual(expect.arrayContaining(["--profile", "reader-wiki-ai-api", "--sandbox", "workspace-write", "--json", "--ephemeral"]));
      expect(chatCall?.env.CODEX_HOME).toContain(path.join("reader-wiki-codex-home", "aiApi"));
      expect(chatCall?.env.READER_WIKI_AI_API_KEY).toBe("test-key");
      const profileText = await readFile(path.join(String(chatCall?.env.CODEX_HOME), "reader-wiki-ai-api.config.toml"), "utf8");
      expect(profileText).toContain("env_key = \"READER_WIKI_AI_API_KEY\"");
      expect(profileText).not.toContain("test-key");

      const missingRuleResponse = await postJson(`${server.url}/api/ai/chat`, {
        target: { kind: "codexBackedProvider", provider, status: readiness.status },
        messages: [{ role: "user", content: "Use missing rules only." }],
        context: { repoId: "docs", rulePaths: [{ path: "CLAUDE.md", source: "auto-root-rule" }] },
      });
      expect(missingRuleResponse.status).toBe(200);
      const missingRuleChat = await missingRuleResponse.json() as { context?: { ruleItems?: unknown[]; primaryItems?: unknown[] } };
      expect(missingRuleChat.context?.ruleItems).toEqual([]);
      expect(missingRuleChat.context?.primaryItems).toEqual([]);

      const directoryResponse = await postJson(`${server.url}/api/ai/chat`, {
        target: { kind: "codexBackedProvider", provider, status: readiness.status },
        messages: [{ role: "user", content: "Summarize docs." }],
        context: { repoId: "docs", primaryPaths: [{ path: "docs", kind: "directory", source: "manual" }] },
      });
      expect(directoryResponse.status).toBe(200);
      const directoryChat = await directoryResponse.json() as { context?: { primaryItems?: Array<{ kind?: string; content?: string }> } };
      expect(directoryChat.context?.primaryItems?.[0]).toMatchObject({ kind: "directory", content: expect.stringContaining("docs/guide.md") });
      expect(directoryChat.context?.primaryItems?.[0]?.content).not.toContain("deep.md");

      const streamResponse = await postJson(`${server.url}/api/ai/chat/stream`, {
        target: { kind: "codexBackedProvider", provider, status: readiness.status },
        messages: [{ role: "user", content: "Summarize this file with attachment." }],
        context: { repoId: "docs", primaryPaths: [{ path: "README.md", includeContent: true, source: "manual" }], rulePaths: [{ path: "AGENTS.md", source: "auto-root-rule" }] },
        attachments: [{ id: "a1", name: "note.md", mimeType: "text/markdown", sizeBytes: 5, contentIncluded: true, content: "Note." }],
        modelBehavior: { kind: "intelligence", level: "medium" },
      });
      expect(streamResponse.status).toBe(200);
      const streamEvents = await readJsonLines(streamResponse);
      expect(streamEvents.map((event) => event.type)).toEqual(["meta", "delta", "done"]);
      expect(streamEvents[1]).toMatchObject({ type: "delta", content: expect.stringContaining("active file") });
      expect(streamEvents[2]).toMatchObject({ type: "done", message: { content: expect.stringContaining("active file") }, run: { accessMode: "repoWrite", entry: "aiApi" } });

      const excludedResponse = await postJson(`${server.url}/api/ai/chat`, {
        target: { kind: "codexBackedProvider", provider, status: readiness.status },
        messages: [{ role: "user", content: "Read hidden notes." }],
        context: { repoId: "docs", primaryPaths: [{ path: "private/notes.md", includeContent: true }] },
      });
      expect(excludedResponse.status).toBe(403);
    } finally {
      await server.close();
    }
  });

  it("checks Codex-backed Local AI readiness with isolated Codex home", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-local-ai-api-"));
    await writeFile(path.join(root, "README.md"), "# Local AI Context\n\nVisible content\n");
    const configPath = path.join(root, "repositories.yaml");
    await writeFile(configPath, `repositories:\n  - id: docs\n    label: Docs\n    root: ${root}\n    defaultPath: README.md\n`);
    await initGitRepo(root);
    const calls: Array<{ binary: string; args: string[]; cwd: string; input: string; env: NodeJS.ProcessEnv }> = [];
    const runner: AICommandRunner = async (binary, args, options) => {
      calls.push({ binary, args, cwd: options.cwd, input: options.input || "", env: options.env });
      if (binary !== "codex") throw new Error("Unexpected command");
      if (args.includes("--version")) return { stdout: "codex-cli 0.143.0\n", stderr: "" };
      if (args.includes("--help")) return { stdout: "--sandbox workspace-write --ephemeral --json --oss --local-provider --model\n", stderr: "" };
      if (options.input) {
        await writeFile(path.join(options.cwd, "local-ai-output.md"), "# Local AI output\n");
        return { stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"Local AI wrote inside the active repo."}}\n', stderr: "" };
      }
      throw new Error("Unexpected command");
    };
    const app = express();
    app.use("/api", createApiRouter(configPath, undefined, { aiCommandRunner: runner }));
    const server = await listen(app);
    const provider = {
      entry: "localAi" as const,
      runtime: "ollama" as const,
      model: "llama3.1",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiFormat: "openaiCompatible" as const,
      credential: "",
    };
    try {
      const readinessResponse = await postJson(`${server.url}/api/ai/entry-readiness`, { entry: "localAi", provider, repoId: "docs" });
      expect(readinessResponse.status).toBe(200);
      const readiness = await readinessResponse.json() as { ready?: boolean; status?: { state?: string; code?: string } };
      expect(readiness).toMatchObject({ ready: true, status: { state: "ready", code: "success" } });

      const chatResponse = await postJson(`${server.url}/api/ai/chat`, {
        target: { kind: "codexBackedLocal", provider, status: readiness.status },
        messages: [{ role: "user", content: "Edit locally." }],
        context: { repoId: "docs", path: "README.md", includeContent: true },
      });
      expect(chatResponse.status).toBe(200);
      await expect(chatResponse.json()).resolves.toMatchObject({
        message: { content: expect.stringContaining("active repo") },
        run: { accessMode: "repoWrite", entry: "localAi", substrate: "codexCli", changedPaths: [expect.objectContaining({ path: "local-ai-output.md", status: "new" })] },
      });
      const chatCall = calls.find((call) => call.input.includes("Visible content"));
      expect(chatCall?.cwd).toBe(await realpath(root));
      expect(chatCall?.args).toEqual(expect.arrayContaining(["--oss", "--local-provider", "ollama", "--model", "llama3.1", "--sandbox", "workspace-write"]));
      expect(chatCall?.env.CODEX_HOME).toContain(path.join("reader-wiki-codex-home", "localAi"));
      expect(chatCall?.env).not.toHaveProperty("READER_WIKI_AI_API_KEY");
    } finally {
      await server.close();
    }
  });

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

      await expect(testAIConnection({ ...base, baseUrl: "not a url" })).resolves.toMatchObject({
        state: "failed",
        code: "invalid_endpoint",
        severity: "error",
        nextAction: expect.any(String),
      });
      await expect(testAIConnection({ ...base, baseUrl: "http://127.0.0.1:9/v1" })).resolves.toMatchObject({
        state: "failed",
        code: "endpoint_unreachable",
        severity: "error",
        message: "Endpoint is unreachable.",
      });
      await expect(testAIConnection({ ...base, baseUrl: `${server.url}/v1/auth-required` })).resolves.toMatchObject({
        state: "failed",
        code: "credential_required",
        severity: "warning",
        message: "Provider rejected the credential.",
      });
      await expect(testAIConnection({ ...base, baseUrl: `${server.url}/v1/model-missing` })).resolves.toMatchObject({
        state: "failed",
        code: "model_missing",
        severity: "warning",
        message: "Model is not visible at this endpoint.",
      });
      await expect(testAIConnection({ ...base, baseUrl: `${server.url}/v1/http-error` })).resolves.toMatchObject({
        state: "failed",
        code: "provider_http_error",
        severity: "error",
        message: "Provider returned HTTP 500.",
      });

      const controller = new AbortController();
      controller.abort();
      await expect(testAIConnection({ ...base, baseUrl: `${server.url}/v1/model-missing` }, controller.signal)).resolves.toMatchObject({
        state: "failed",
        code: "timeout_or_abort",
        severity: "warning",
      });
    } finally {
      await server.close();
    }
  });

  it("checks CLI readiness and answers with guarded repo-scoped write context through fixed adapters", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-cli-api-"));
    await mkdir(path.join(root, "private"));
    await writeFile(path.join(root, "README.md"), "# CLI Context\n\nVisible content\n");
    await writeFile(path.join(root, "private", "notes.md"), "# Hidden\n");
    const configPath = path.join(root, "repositories.yaml");
    await writeFile(configPath, `repositories:\n  - id: docs\n    label: Docs\n    root: ${root}\n    defaultPath: README.md\n    excludes:\n      - private\n`);
    await initGitRepo(root);
    const calls: Array<{ binary: string; args: string[]; cwd: string; input: string }> = [];
    const runner: AICommandRunner = async (binary, args, options) => {
      calls.push({ binary, args, cwd: options.cwd, input: options.input || "" });
      if (binary === "codex") {
        if (args.includes("--version")) return { stdout: "codex-cli 0.142.5\n", stderr: "" };
        if (args.includes("login")) return { stdout: "Logged in using ChatGPT\n", stderr: "" };
        if (args.includes("--help")) return { stdout: "--sandbox workspace-write read-only --ephemeral --skip-git-repo-check --json --cd\n", stderr: "" };
        if (options.input?.includes("Reader-Wiki CLI readiness")) return { stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"ready"}}\n', stderr: "" };
        await writeFile(path.join(options.cwd, "cli-output.md"), "# CLI output\n");
        return { stdout: `{"type":"item.completed","item":{"type":"agent_message","text":"${["Co", "dex CLI"].join("")} answer from repo-scoped write context."}}\n`, stderr: "raw stderr" };
      }
      if (binary === "claude") {
        if (args.includes("--version")) return { stdout: "2.1.199 (Claude Code)\n", stderr: "" };
        if (args.includes("auth")) return { stdout: '{"loggedIn":true}\n', stderr: "" };
        if (args.includes("--help")) return { stdout: `--print --output-format --tools --permission-mode --safe-mode ${["--no-", "sess", "ion", "-persistence"].join("")}\n`, stderr: "" };
        if (options.input) return { stdout: '{"is_error":false,"result":"Claude CLI answer from repo-scoped write context."}\n', stderr: "" };
        return { stdout: '{"is_error":false,"result":"Reader-Wiki Claude readiness."}\n', stderr: "" };
      }
      throw new Error("Unexpected command");
    };
    const app = express();
    app.use("/api", createApiRouter(configPath, undefined, { aiCommandRunner: runner }));
    const server = await listen(app);
    try {
      const codexReadiness = await postJson(`${server.url}/api/ai/entry-readiness`, { entry: "codexCli", repoId: "docs" });
      expect(codexReadiness.status).toBe(200);
      const codexReadinessBody = await codexReadiness.json() as { ready?: boolean; status?: { state?: string; code?: string }; settings?: { entry?: string; authState?: string; readOnlyWrapperState?: string; executionMode?: string } };
      expect(codexReadinessBody).toMatchObject({ ready: true, status: { state: "ready", code: "success" }, settings: { entry: "codexCli", authState: "configured", readOnlyWrapperState: "ready", executionMode: "repoWrite" } });

      const claudeReadiness = await postJson(`${server.url}/api/ai/entry-readiness`, { entry: "claudeCli", repoId: "docs" });
      expect(claudeReadiness.status).toBe(200);
      await expect(claudeReadiness.json()).resolves.toMatchObject({ ready: true, settings: { entry: "claudeCli", authState: "configured", readOnlyWrapperState: "ready", executionMode: "repoWrite" } });

      const chatResponse = await postJson(`${server.url}/api/ai/chat`, {
        target: { kind: "codexCli", entry: "codexCli", status: codexReadinessBody.status },
        messages: [{ role: "user", content: "Summarize this file." }],
        context: { repoId: "docs", path: "README.md", includeContent: true },
      });
      expect(chatResponse.status).toBe(200);
      const chat = await chatResponse.json() as { message?: { content?: string }; context?: { primaryItems?: Array<{ contentIncluded?: boolean; path?: string }> }; run?: { changedPaths?: Array<{ path?: string; status?: string }> } };
      expect(chat.message?.content).toContain("repo-scoped write context");
      expect(chat.context?.primaryItems?.[0]).toMatchObject({ path: "README.md", contentIncluded: true });
      expect(chat.run?.changedPaths).toEqual([expect.objectContaining({ path: "cli-output.md", status: "new" })]);

      const chatCall = calls.find((call) => call.binary === "codex" && call.args[0] === "exec" && call.input.includes("Visible content"));
      expect(chatCall).toBeTruthy();
      const realRoot = await realpath(root);
      expect(chatCall?.cwd).toBe(realRoot);
      expect(chatCall?.input).toContain("Repository-relative path: README.md");
      expect(chatCall?.input).toContain("Visible content");
      expect(chatCall?.input).not.toContain(root);
      expect(chatCall?.args).toEqual(expect.arrayContaining(["--sandbox", "workspace-write", "--json", "--ephemeral", "-C", realRoot]));
      expect(chatCall?.args).not.toContain("--skip-git-repo-check");

      const excludedResponse = await postJson(`${server.url}/api/ai/chat`, {
        target: { kind: "codexCli", entry: "codexCli", status: codexReadinessBody.status },
        messages: [{ role: "user", content: "Read hidden notes." }],
        context: { repoId: "docs", path: "private/notes.md", includeContent: true },
      });
      expect(excludedResponse.status).toBe(403);
    } finally {
      await server.close();
    }
  });

  it("does not explicitly forward credential-like environment variables to CLI adapters", () => {
    const original = {
      CODEX_API_KEY: process.env.CODEX_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    };
    try {
      process.env.CODEX_API_KEY = "codex-api-key-test-value";
      process.env.OPENAI_API_KEY = "openai-api-key-test-value";
      process.env.ANTHROPIC_API_KEY = "anthropic-api-key-test-value";
      process.env.ANTHROPIC_AUTH_TOKEN = "anthropic-auth-redacted-value";
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "claude-code-oauth-redacted-value";
      process.env.CODEX_HOME = path.join(tmpdir(), "reader-wiki-default-codex-home");
      expect(safeCliEnv("codexCli")).not.toHaveProperty("CODEX_API_KEY");
      expect(safeCliEnv("codexCli")).not.toHaveProperty("OPENAI_API_KEY");
      expect(safeCliEnv("claudeCli")).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(safeCliEnv("claudeCli")).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
      expect(safeCliEnv("claudeCli")).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
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
      if (args.includes("login")) return { stdout: "Logged in using ChatGPT\n", stderr: "" };
      if (args.includes("--help")) return { stdout: "--sandbox workspace-write --ephemeral --skip-git-repo-check --json\n", stderr: "" };
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
      expect(body.error).toContain("readiness execution failed");
      expect(calls.some((call) => call.input.includes("CLI Not Ready"))).toBe(false);
      expect(calls.some((call) => call.input.includes("Reader-Wiki CLI readiness"))).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("sanitizes CLI adapter failures before returning API errors", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-cli-error-api-"));
    await writeFile(path.join(root, "README.md"), "# CLI Error\n");
    const configPath = path.join(root, "repositories.yaml");
    await writeFile(configPath, `repositories:\n  - id: docs\n    label: Docs\n    root: ${root}\n    defaultPath: README.md\n`);
    await initGitRepo(root);
    const localPath = ["/Users/", "example/private"].join("");
    const keyLike = ["sk-", "123456789012345"].join("");
    const runIdField = ["sess", "ion_id"].join("");
    const runner: AICommandRunner = async (_binary, args, options) => {
      if (args.includes("--version")) return { stdout: "codex-cli 0.142.5\n", stderr: "" };
      if (args.includes("login")) return { stdout: "Logged in using ChatGPT\n", stderr: "" };
      if (args.includes("--help")) return { stdout: "--sandbox workspace-write --ephemeral --skip-git-repo-check --json\n", stderr: "" };
      if (options.input?.includes("Reader-Wiki CLI readiness")) {
        return { stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"ready"}}\n', stderr: "" };
      }
      throw new Error(`${localPath} ${keyLike} user@example.test "${runIdField}":"abc-123" "uuid":"def-456" raw stderr`);
    };
    const app = express();
    app.use("/api", createApiRouter(configPath, undefined, { aiCommandRunner: runner }));
    const server = await listen(app);
    try {
      const response = await postJson(`${server.url}/api/ai/chat`, {
        target: { kind: "codexCli", entry: "codexCli", status: { state: "ready", code: "success", severity: "success", message: "ready", checkedAt: "2026-07-05T00:00:00.000Z" } },
        messages: [{ role: "user", content: "Summarize." }],
        context: { repoId: "docs", path: "README.md", includeContent: true },
      });
      expect(response.status).toBe(502);
      const body = await response.json() as { error?: string };
      expect(body.error).not.toContain(localPath);
      expect(body.error).not.toContain(keyLike);
      expect(body.error).not.toContain("user@example.test");
      expect(body.error).not.toContain("abc-123");
      expect(body.error).not.toContain("def-456");
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

function postJson(url: string, payload: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function readJsonLines(response: Response): Promise<Array<{ type?: string; content?: string; message?: { content?: string } }>> {
  const text = await response.text();
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as { type?: string; content?: string; message?: { content?: string } });
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
