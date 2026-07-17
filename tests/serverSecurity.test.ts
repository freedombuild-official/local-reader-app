import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { startReaderWikiServer } from "../server/createReaderWikiServer";
import { AiCliSetupService, type AiCliSetupProvider } from "../server/aiCliSetup";
import { HttpError } from "../server/errors";
import type { RepositoryRegistry } from "../server/repositoryRegistry";
import { createReaderWikiSecurity } from "../server/security";
import type { AICliEntryKind } from "../server/types";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-server-security-"));
  const distPath = path.join(root, "dist");
  const configPath = path.join(root, "repositories.yaml");
  await mkdir(distPath);
  await writeFile(path.join(distPath, "index.html"), "<!doctype html><title>Local Reader App</title>");
  await writeFile(path.join(root, "README.md"), "# Test\n");
  await writeFile(configPath, `repositories:\n  - id: docs\n    label: Docs\n    root: ${root}\n    defaultPath: README.md\n`);
  return { root, distPath, configPath };
}

function rawStatus(url: string, headers: Record<string, string>): Promise<number> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: "GET",
      headers,
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode || 0));
    });
    request.once("error", reject);
    request.end();
  });
}

describe("Local Reader App public server boundary", () => {
  it("refuses a non-loopback listener even when the legacy unsafe option is supplied", async () => {
    const next = await fixture();
    await expect(startReaderWikiServer({ host: "0.0.0.0", port: 0, ...next })).rejects.toThrow(/non-loopback/i);
    await expect(startReaderWikiServer({ host: "0.0.0.0", port: 0, allowNonLoopback: true, ...next })).rejects.toThrow(/non-loopback/i);
  });

  it("binds loopback, issues a session, and rejects unauthenticated or hostile API requests", async () => {
    const next = await fixture();
    const handle = await startReaderWikiServer({ host: "127.0.0.1", port: 0, ...next });
    try {
      const address = handle.server.address();
      expect(typeof address === "object" && address ? address.address : "").toBe("127.0.0.1");

      const shell = await fetch(handle.url);
      const cookie = shell.headers.get("set-cookie") || "";
      expect(cookie).toContain("reader_wiki_session=");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      expect(shell.headers.get("x-frame-options")).toBe("DENY");
      const productionCsp = shell.headers.get("content-security-policy") || "";
      expect(productionCsp).toContain("frame-ancestors 'none'");
      expect(productionCsp).toContain("script-src 'self'");
      expect(productionCsp).not.toContain("script-src 'self' 'unsafe-inline'");
      expect(productionCsp).not.toContain("ws://");
      expect(shell.headers.get("referrer-policy")).toBe("no-referrer");

      expect((await fetch(`${handle.url}/api/repos`)).status).toBe(401);
      const cookieSession = cookie.split(";", 1)[0];
      const reposResponse = await fetch(`${handle.url}/api/repos`, { headers: { Cookie: cookieSession } });
      expect(reposResponse.status).toBe(200);
      expect((await fetch(`${handle.url}/api/ai/cli-setup`)).status).toBe(401);
      const setupResponse = await fetch(`${handle.url}/api/ai/cli-setup`, { headers: { Cookie: cookieSession } });
      expect(setupResponse.status).toBe(200);
      await expect(setupResponse.json()).resolves.toMatchObject({
        setups: {
          codexCli: { entry: "codexCli", phase: "idle" },
          claudeCli: { entry: "claudeCli", phase: "idle", foundationOnly: true },
        },
      });
      const repos = await reposResponse.json() as { repositories?: Array<{ id?: string; revision?: string }> };
      const revision = repos.repositories?.find((repo) => repo.id === "docs")?.revision || "";
      await expect(rawStatus(`${handle.url}/api/repos`, {
        "X-Reader-Wiki-Token": handle.sessionToken,
        Host: "attacker.invalid",
      })).resolves.toBe(403);

      const mutationHeaders = {
        "Content-Type": "application/json",
        "X-Reader-Wiki-Request": "1",
        "X-Reader-Wiki-Token": handle.sessionToken,
        Origin: handle.url,
      };
      expect((await fetch(`${handle.url}/api/ai/cli-setup/inspect`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Reader-Wiki-Token": handle.sessionToken,
          Origin: handle.url,
        },
        body: JSON.stringify({ entry: "codexCli" }),
      })).status).toBe(403);
      expect((await fetch(`${handle.url}/api/ai/cli-setup/inspect`, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "X-Reader-Wiki-Request": "1",
          "X-Reader-Wiki-Token": handle.sessionToken,
          Origin: handle.url,
        },
        body: JSON.stringify({ entry: "codexCli" }),
      })).status).toBe(415);
      expect((await fetch(`${handle.url}/api/repo-open`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ repoId: "docs", expectedRevision: revision }),
      })).status).toBe(200);
      expect((await fetch(`${handle.url}/api/repo-open`, {
        method: "POST",
        headers: { ...mutationHeaders, Origin: "https://attacker.invalid" },
        body: JSON.stringify({ repoId: "docs", expectedRevision: revision }),
      })).status).toBe(403);
      expect((await fetch(`${handle.url}/api/repo-open`, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "X-Reader-Wiki-Request": "1",
          "X-Reader-Wiki-Token": handle.sessionToken,
          Origin: handle.url,
        },
        body: JSON.stringify({ repoId: "docs" }),
      })).status).toBe(415);
    } finally {
      await handle.close();
    }
  });

  it("shuts the CLI setup composition root exactly once when the server handle closes", async () => {
    const next = await fixture();
    const provider = (entry: AICliEntryKind): AiCliSetupProvider => ({
      entry,
      inspect: async () => ({ installed: false, managed: false, compatibility: "unknown", authenticated: false, message: "idle" }),
      currentVersion: async () => "unavailable",
      currentExecution: async () => ({ version: "unavailable", executable: { binary: entry === "codexCli" ? "codex" : "claude", argvPrefix: [], identityPath: `/mock/bin/${entry === "codexCli" ? "codex" : "claude"}` } }),
      startAuthentication: async () => ({ state: "waiting", message: "waiting" }),
      cancelAuthentication: async () => undefined,
      update: async () => undefined,
      shutdown: vi.fn(async () => undefined),
    });
    const codex = provider("codexCli");
    const claude = provider("claudeCli");
    const service = new AiCliSetupService({ providers: { codexCli: codex, claudeCli: claude } });
    const shutdown = vi.spyOn(service, "shutdown");
    const handle = await startReaderWikiServer({ host: "127.0.0.1", port: 0, ...next, aiCliSetupService: service });

    await Promise.all([handle.close(), handle.close()]);

    expect(shutdown).toHaveBeenCalledOnce();
    expect(codex.shutdown).toHaveBeenCalledOnce();
    expect(claude.shutdown).toHaveBeenCalledOnce();
  });

  it("aborts an active one-shot CLI readiness request before waiting for HTTP shutdown", async () => {
    const next = await fixture();
    const provider = (entry: AICliEntryKind): AiCliSetupProvider => ({
      entry,
      inspect: async () => ({
        installed: true,
        cliVersion: "1.2.3",
        managed: true,
        compatibility: "compatible",
        authenticated: true,
        message: "ready",
        catalog: {
          entry,
          cliVersion: "1.2.3",
          revision: `${entry}-catalog-r1`,
          fetchedAt: "2026-07-16T00:00:00.000Z",
          models: [{
            id: entry === "codexCli" ? "gpt-test" : "claude-test",
            label: "Test model",
            description: null,
            isDefault: true,
            defaultEffort: "high",
            efforts: [{ id: "high", label: "High", description: null, isDefault: true }],
            defaultSpeedMode: "standard",
            speedModes: [{ id: "standard", label: "Standard", description: null, isDefault: true }],
          }],
        },
      }),
      currentVersion: async () => "1.2.3",
      currentExecution: async () => ({ version: "1.2.3", executable: { binary: entry === "codexCli" ? "codex" : "claude", argvPrefix: [], identityPath: `/mock/bin/${entry === "codexCli" ? "codex" : "claude"}` } }),
      startAuthentication: async () => ({ state: "waiting", message: "waiting" }),
      cancelAuthentication: async () => undefined,
      update: async () => undefined,
      shutdown: vi.fn(async () => undefined),
    });
    const codex = provider("codexCli");
    const claude = provider("claudeCli");
    const service = new AiCliSetupService({ providers: { codexCli: codex, claudeCli: claude } });
    await service.inspect("codexCli");
    let markRunnerStarted!: () => void;
    const runnerStarted = new Promise<void>((resolve) => { markRunnerStarted = resolve; });
    let runnerAborted = false;
    const handle = await startReaderWikiServer({
      host: "127.0.0.1",
      port: 0,
      ...next,
      aiCliSetupService: service,
      aiCommandRunner: async (_binary, _args, options) => {
        markRunnerStarted();
        return new Promise((_resolve, reject) => {
          const abort = () => {
            runnerAborted = true;
            reject(new HttpError(499, "CLI readiness request was canceled."));
          };
          if (options.signal?.aborted) abort();
          else options.signal?.addEventListener("abort", abort, { once: true });
        });
      },
    });
    const headers = {
      "Content-Type": "application/json",
      "X-Reader-Wiki-Request": "1",
      "X-Reader-Wiki-Token": handle.sessionToken,
      Origin: handle.url,
    };
    const reposResponse = await fetch(`${handle.url}/api/repos`, {
      headers: { "X-Reader-Wiki-Token": handle.sessionToken },
    });
    const repos = await reposResponse.json() as { repositories: Array<{ id: string; revision: string }> };
    const revision = repos.repositories.find((repo) => repo.id === "docs")?.revision;
    const readiness = fetch(`${handle.url}/api/ai/entry-readiness`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        entry: "codexCli",
        repoId: "docs",
        expectedRevision: revision,
        selection: { model: "gpt-test", effort: "high", speedMode: "standard", catalogRevision: "codexCli-catalog-r1", setupGeneration: 1 },
      }),
    });
    await runnerStarted;

    const closing = handle.close();

    await expect(readiness).resolves.toMatchObject({ status: 499 });
    await expect(closing).resolves.toBeUndefined();
    expect(runnerAborted).toBe(true);
    expect(codex.shutdown).toHaveBeenCalledOnce();
    expect(claude.shutdown).toHaveBeenCalledOnce();
  });

  it("closes the HTTP server even when CLI process cleanup reports a failure", async () => {
    const next = await fixture();
    const failure = new Error("process tree remained alive");
    const provider = (entry: AICliEntryKind, shutdown: () => Promise<void>): AiCliSetupProvider => ({
      entry,
      inspect: async () => ({ installed: false, managed: false, compatibility: "unknown", authenticated: false, message: "idle" }),
      currentVersion: async () => "unavailable",
      currentExecution: async () => ({ version: "unavailable", executable: { binary: entry === "codexCli" ? "codex" : "claude", argvPrefix: [], identityPath: `/mock/bin/${entry === "codexCli" ? "codex" : "claude"}` } }),
      startAuthentication: async () => ({ state: "waiting", message: "waiting" }),
      cancelAuthentication: async () => undefined,
      update: async () => undefined,
      shutdown: vi.fn(shutdown),
    });
    const codex = provider("codexCli", async () => { throw failure; });
    const claude = provider("claudeCli", async () => undefined);
    const service = new AiCliSetupService({ providers: { codexCli: codex, claudeCli: claude } });
    const handle = await startReaderWikiServer({ host: "127.0.0.1", port: 0, ...next, aiCliSetupService: service });

    await expect(handle.close()).rejects.toBe(failure);

    expect(handle.server.listening).toBe(false);
    expect(codex.shutdown).toHaveBeenCalledOnce();
    expect(claude.shutdown).toHaveBeenCalledOnce();
  });

  it("rejects composition-root close after a CLI chat reports an unverified process tree", async () => {
    const next = await fixture();
    const provider = (entry: AICliEntryKind): AiCliSetupProvider => ({
      entry,
      inspect: async () => ({ installed: false, managed: false, compatibility: "unknown", authenticated: false, message: "idle" }),
      currentVersion: async () => "unavailable",
      currentExecution: async () => ({ version: "unavailable", executable: { binary: entry === "codexCli" ? "codex" : "claude", argvPrefix: [], identityPath: `/mock/bin/${entry === "codexCli" ? "codex" : "claude"}` } }),
      startAuthentication: async () => ({ state: "waiting", message: "waiting" }),
      cancelAuthentication: async () => undefined,
      update: async () => undefined,
      shutdown: vi.fn(async () => undefined),
    });
    const codex = provider("codexCli");
    const claude = provider("claudeCli");
    const service = new AiCliSetupService({ providers: { codexCli: codex, claudeCli: claude } });
    const failure = new HttpError(502, "process tree unverified", { processTreeUnverified: true });
    const handle = await startReaderWikiServer({ host: "127.0.0.1", port: 0, ...next, aiCliSetupService: service });
    service.reportUnverifiedProcessTree("codexCli", failure);

    await expect(handle.close()).rejects.toBe(failure);

    expect(handle.server.listening).toBe(false);
    expect(codex.shutdown).toHaveBeenCalledOnce();
    expect(claude.shutdown).toHaveBeenCalledOnce();
  });

  it("rechecks the fatal process-tree latch after active HTTP requests drain", async () => {
    const next = await fixture();
    let markListStarted: (() => void) | undefined;
    let releaseList: (() => void) | undefined;
    const listStarted = new Promise<void>((resolve) => { markListStarted = resolve; });
    const listReleased = new Promise<void>((resolve) => { releaseList = resolve; });
    const repositoryRegistry: RepositoryRegistry = {
      listRepositoryItems: async () => {
        markListStarted?.();
        await listReleased;
        return [];
      },
      findRepository: async () => { throw new Error("unused"); },
    };
    const provider = (entry: AICliEntryKind): AiCliSetupProvider => ({
      entry,
      inspect: async () => ({ installed: false, managed: false, compatibility: "unknown", authenticated: false, message: "idle" }),
      currentVersion: async () => "unavailable",
      currentExecution: async () => ({ version: "unavailable", executable: { binary: entry === "codexCli" ? "codex" : "claude", argvPrefix: [], identityPath: `/mock/bin/${entry === "codexCli" ? "codex" : "claude"}` } }),
      startAuthentication: async () => ({ state: "waiting", message: "waiting" }),
      cancelAuthentication: async () => undefined,
      update: async () => undefined,
      shutdown: vi.fn(async () => undefined),
    });
    const service = new AiCliSetupService({
      providers: { codexCli: provider("codexCli"), claudeCli: provider("claudeCli") },
    });
    const failure = new HttpError(502, "late process tree failure", { processTreeUnverified: true });
    const handle = await startReaderWikiServer({
      host: "127.0.0.1",
      port: 0,
      ...next,
      repositoryRegistry,
      aiCliSetupService: service,
    });
    const shell = await fetch(handle.url);
    const cookieSession = (shell.headers.get("set-cookie") || "").split(";", 1)[0];
    const pendingRequest = fetch(`${handle.url}/api/repos`, { headers: { Cookie: cookieSession } });
    await listStarted;

    const closing = handle.close();
    await service.shutdown();
    service.reportUnverifiedProcessTree("codexCli", failure);
    releaseList?.();

    await expect(pendingRequest).resolves.toMatchObject({ status: 200 });
    await expect(closing).rejects.toBe(failure);
    expect(handle.server.listening).toBe(false);
  });

  it("keeps inline scripts and every loopback HMR WebSocket development-only", () => {
    const values = new Map<string, string>();
    const response = {
      setHeader(name: string, value: unknown) {
        values.set(name.toLowerCase(), String(value));
        return response;
      },
    } as unknown as Response;
    const next = vi.fn();
    createReaderWikiSecurity({ bindHost: "::1", dev: true }).headers({ path: "/" } as Request, response, next);

    const csp = values.get("content-security-policy") || "";
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("ws://127.0.0.1:*");
    expect(csp).toContain("ws://localhost:*");
    expect(csp).toContain("ws://[::1]:*");
    expect(next).toHaveBeenCalledOnce();
  });
});
