import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { startReaderWikiServer } from "../server/createReaderWikiServer";
import { createReaderWikiSecurity } from "../server/security";

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
