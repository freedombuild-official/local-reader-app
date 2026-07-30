// @vitest-environment node

import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HTML_PREVIEW_MAX_SESSIONS,
  HTML_PREVIEW_MAX_WRITE_BYTES,
  HTML_PREVIEW_WRITE_HEADER,
  HTML_PREVIEW_WRITE_VALUE,
  HtmlPreviewServerService,
  type HtmlPreviewService,
} from "../server/htmlPreviewServer.js";
import { repositoryRevision } from "../server/repositoryRevision.js";
import type { HtmlPreviewSessionStatus, RepositoryConfig } from "../server/types.js";

const tempPaths: string[] = [];
const services: HtmlPreviewService[] = [];
const EMPTY_WASM_MODULE = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()));
  await Promise.all(tempPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe("HtmlPreviewServerService", () => {
  it("bootstraps a one-time HttpOnly cookie and serves same-repo executable assets from a dedicated origin", async () => {
    const fixture = await createFixture();
    const active = await startActiveSession(fixture);

    expect(active.status.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(active.status.origin).not.toBe("http://127.0.0.1:5173");
    expect(active.status.url).toContain("/__reader_wiki_preview_bootstrap?token=");
    expect(active.bootstrap.status).toBe(303);
    expect(active.bootstrap.headers.get("set-cookie")).toContain("HttpOnly");
    expect(active.bootstrap.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(active.bootstrap.headers.get("referrer-policy")).toBe("no-referrer");

    const reusedBootstrap = await fetch(active.status.url, { redirect: "manual" });
    expect(reusedBootstrap.status).toBe(401);

    const unauthorized = await fetch(active.url);
    expect(unauthorized.status).toBe(401);

    const htmlResponse = await previewFetch(active, active.url, {
      headers: { "Sec-Fetch-Dest": "iframe" },
    });
    expect(htmlResponse.status).toBe(200);
    expect(htmlResponse.headers.get("content-type")).toContain("text/html");
    expect(htmlResponse.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(htmlResponse.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(htmlResponse.headers.get("x-content-type-options")).toBe("nosniff");
    expect(htmlResponse.headers.get("x-frame-options")).toBeNull();
    expect(htmlResponse.headers.get("permissions-policy")).toContain("camera=()");
    const csp = htmlResponse.headers.get("content-security-policy") || "";
    expect(csp).toContain("script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("frame-src 'self'");
    expect(csp).not.toContain("frame-src 'self' blob:");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'self' http://127.0.0.1:5173");
    expect(csp).not.toContain("https:");
    expect(csp).not.toContain(" 'unsafe-eval'");

    const html = await htmlResponse.text();
    expect(html).toContain("data-reader-wiki-preview-guard");
    expect(html.indexOf("data-reader-wiki-preview-guard")).toBeLessThan(html.indexOf("fixture-inline-script"));
    expect(html).toContain("Object.defineProperty(window, \"open\"");
    expect(html).toContain("allowedPopupUrl");
    expect(html).toContain("opensNewContext");
    expect(html).toContain("/[.]html?$/i");
    expect(html).toContain("new URL(String(rawUrl), document.baseURI)");
    expect(html).toContain("meta[http-equiv=\"refresh\" i]");

    const rawHtmlResponse = await previewFetch(active, active.url, {
      headers: { "Sec-Fetch-Dest": "empty" },
    });
    expect(rawHtmlResponse.status).toBe(200);
    expect(rawHtmlResponse.headers.get("etag")).toBe(htmlResponse.headers.get("etag"));
    const rawHtml = await rawHtmlResponse.text();
    expect(rawHtml).not.toContain("data-reader-wiki-preview-guard");
    expect(rawHtml).toContain("fixture-inline-script");

    const css = await previewFetch(active, new URL("../styles/app.css", active.url));
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");

    const cssNavigation = await previewFetch(active, new URL("../styles/app.css", active.url), {
      headers: { "Sec-Fetch-Dest": "iframe" },
    });
    expect(cssNavigation.status).toBe(415);

    const module = await previewFetch(active, new URL("/scripts/app.mjs", active.url));
    expect(module.status).toBe(200);
    expect(module.headers.get("content-type")).toContain("text/javascript");

    const json = await previewFetch(active, new URL("/data/state.json", active.url));
    expect(json.status).toBe(200);
    await expect(json.json()).resolves.toEqual({ ready: true });

    const yaml = await previewFetch(active, new URL("/data/state.yaml", active.url));
    expect(yaml.status).toBe(200);
    expect(yaml.headers.get("content-type")).toContain("application/yaml");

    const wasm = await previewFetch(active, new URL("/wasm/empty.wasm", active.url));
    expect(wasm.status).toBe(200);
    expect(wasm.headers.get("content-type")).toBe("application/wasm");

    const child = await previewFetch(active, new URL("/frames/child.html", active.url), {
      headers: { "Sec-Fetch-Dest": "iframe" },
    });
    expect(child.status).toBe(200);
    expect(await child.text()).toContain("data-reader-wiki-preview-guard");

    const directory = await previewFetch(active, new URL("/", active.url));
    expect(directory.status).toBe(403);
    const unsupported = await previewFetch(active, new URL("/archive.zip", active.url));
    expect(unsupported.status).toBe(415);
  });

  it("atomically replaces existing UTF-8 text with same-origin intent and a current ETag", async () => {
    const fixture = await createFixture();
    const active = await startActiveSession(fixture);
    const yamlUrl = new URL("/data/state.yaml", active.url);
    const initialRead = await previewFetch(active, yamlUrl);
    const initialEtag = requireEtag(initialRead);
    const nextYaml = 'ready: false\nnote: "saved from HTML"\n';

    const write = await previewWrite(active, yamlUrl, nextYaml, initialEtag, "application/yaml; charset=utf-8");
    expect(write.status).toBe(200);
    expect(write.headers.get("etag")).not.toBe(initialEtag);
    const result = await write.json() as Record<string, unknown>;
    expect(result).toMatchObject({
      path: "data/state.yaml",
      byteLength: Buffer.byteLength(nextYaml),
    });
    expect(JSON.stringify(result)).not.toContain(fixture.root);
    await expect(readFile(path.join(fixture.root, "data", "state.yaml"), "utf8")).resolves.toBe(nextYaml);

    const staleWrite = await previewWrite(active, yamlUrl, "stale: true\n", initialEtag, "application/yaml; charset=utf-8");
    expect(staleWrite.status).toBe(412);
    await expect(readFile(path.join(fixture.root, "data", "state.yaml"), "utf8")).resolves.toBe(nextYaml);

    const currentRead = await previewFetch(active, yamlUrl);
    const currentEtag = requireEtag(currentRead);
    const [first, second] = await Promise.all([
      previewWrite(active, yamlUrl, "winner: first\n", currentEtag, "application/yaml; charset=utf-8"),
      previewWrite(active, yamlUrl, "winner: second\n", currentEtag, "application/yaml; charset=utf-8"),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 412]);
    expect(["winner: first\n", "winner: second\n"]).toContain(
      await readFile(path.join(fixture.root, "data", "state.yaml"), "utf8"),
    );
  });

  it("requires cookie, exact Host and Origin, write intent, If-Match, and UTF-8 text", async () => {
    const fixture = await createFixture();
    const active = await startActiveSession(fixture);
    const targetUrl = new URL("/data/state.yaml", active.url);
    const original = await readFile(path.join(fixture.root, "data", "state.yaml"), "utf8");
    const etag = requireEtag(await previewFetch(active, targetUrl));
    const baseHeaders = {
      "Content-Type": "application/yaml; charset=utf-8",
      "If-Match": etag,
      Origin: active.status.origin,
      [HTML_PREVIEW_WRITE_HEADER]: HTML_PREVIEW_WRITE_VALUE,
    };

    const missingCookie = await fetch(targetUrl, { method: "PUT", headers: baseHeaders, body: "ready: false\n" });
    expect(missingCookie.status).toBe(401);

    const missingOrigin = await previewFetch(active, targetUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/yaml; charset=utf-8",
        "If-Match": etag,
        [HTML_PREVIEW_WRITE_HEADER]: HTML_PREVIEW_WRITE_VALUE,
      },
      body: "ready: false\n",
    });
    expect(missingOrigin.status).toBe(403);

    const wrongOrigin = await previewFetch(active, targetUrl, {
      method: "PUT",
      headers: { ...baseHeaders, Origin: "https://attacker.invalid" },
      body: "ready: false\n",
    });
    expect(wrongOrigin.status).toBe(403);

    const wrongHost = await rawWriteStatus(active, targetUrl, "ready: false\n", {
      ...baseHeaders,
      Host: "localhost:1",
      Cookie: active.cookie,
    });
    expect(wrongHost).toBe(403);

    const missingIntent = await previewFetch(active, targetUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/yaml; charset=utf-8",
        "If-Match": etag,
        Origin: active.status.origin,
      },
      body: "ready: false\n",
    });
    expect(missingIntent.status).toBe(403);

    const missingIfMatch = await previewFetch(active, targetUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/yaml; charset=utf-8",
        Origin: active.status.origin,
        [HTML_PREVIEW_WRITE_HEADER]: HTML_PREVIEW_WRITE_VALUE,
      },
      body: "ready: false\n",
    });
    expect(missingIfMatch.status).toBe(428);

    const binaryBody = await previewWrite(
      active,
      targetUrl,
      Buffer.from([0xc3, 0x28]),
      etag,
      "application/yaml; charset=utf-8",
    );
    expect(binaryBody.status).toBe(415);

    const nulBody = await previewWrite(active, targetUrl, "bad\0text", etag, "text/plain; charset=utf-8");
    expect(nulBody.status).toBe(415);

    const wrongCharset = await previewWrite(active, targetUrl, "ready: false\n", etag, "text/plain; charset=shift_jis");
    expect(wrongCharset.status).toBe(415);

    const oversized = await previewWrite(
      active,
      targetUrl,
      Buffer.alloc(HTML_PREVIEW_MAX_WRITE_BYTES + 1, 0x61),
      etag,
      "text/plain; charset=utf-8",
    );
    expect(oversized.status).toBe(413);
    await expect(readFile(path.join(fixture.root, "data", "state.yaml"), "utf8")).resolves.toBe(original);
  });

  it("rejects creation, directories, excludes, binary targets, traversal, and symlink paths", async () => {
    const fixture = await createFixture();
    const active = await startActiveSession(fixture);
    const stateUrl = new URL("/data/state.yaml", active.url);
    const etag = requireEtag(await previewFetch(active, stateUrl));
    const outsideBefore = await readFile(fixture.outsideFile, "utf8");

    const missing = await previewWrite(
      active,
      new URL("/data/new.yaml", active.url),
      "created: true\n",
      etag,
      "application/yaml; charset=utf-8",
    );
    expect(missing.status).toBe(404);

    const directory = await previewWrite(active, new URL("/data", active.url), "invalid\n", etag, "text/plain; charset=utf-8");
    expect(directory.status).toBe(400);

    const excluded = await previewWrite(
      active,
      new URL("/private/secret.json", active.url),
      "{}\n",
      etag,
      "application/json; charset=utf-8",
    );
    expect(excluded.status).toBe(403);

    const git = await previewWrite(active, new URL("/.git/config", active.url), "invalid\n", etag, "text/plain; charset=utf-8");
    expect(git.status).toBe(403);

    const binary = await previewWrite(active, new URL("/wasm/empty.wasm", active.url), "not wasm", etag, "text/plain; charset=utf-8");
    expect(binary.status).toBe(415);
    await expect(readFile(path.join(fixture.root, "wasm", "empty.wasm"))).resolves.toEqual(EMPTY_WASM_MODULE);

    const traversal = await previewWrite(
      active,
      `${active.status.origin}/..%2F..%2Foutside.yaml`,
      "invalid\n",
      etag,
      "application/yaml; charset=utf-8",
    );
    expect(traversal.status).toBe(400);

    if (process.platform !== "win32") {
      await symlink(path.join(fixture.root, "site", "index.html"), path.join(fixture.root, "site", "linked.html"));
      await expect(fixture.service.start({
        repoId: fixture.repo.id,
        path: "site/linked.html",
        expectedRevision: fixture.revision,
        appOrigin: "http://127.0.0.1:5173",
      })).rejects.toThrow(/symbolic links/i);

      await symlink(path.join(fixture.root, "data", "state.yaml"), path.join(fixture.root, "data", "linked.yaml"));
      const linked = await previewWrite(
        active,
        new URL("/data/linked.yaml", active.url),
        "invalid\n",
        etag,
        "application/yaml; charset=utf-8",
      );
      expect(linked.status).toBe(403);

      await symlink(fixture.outsideFile, path.join(fixture.root, "data", "outside.yaml"));
      const outsideLink = await previewWrite(
        active,
        new URL("/data/outside.yaml", active.url),
        "invalid\n",
        etag,
        "application/yaml; charset=utf-8",
      );
      expect(outsideLink.status).toBe(403);
    }

    const hardLinkPath = path.join(fixture.root, "data", "hard-linked.yaml");
    await link(fixture.outsideFile, hardLinkPath);
    const hardLinkUrl = new URL("/data/hard-linked.yaml", active.url);
    const hardLinkEtag = requireEtag(await previewFetch(active, hardLinkUrl));
    const hardLinkWrite = await previewWrite(
      active,
      hardLinkUrl,
      "inside: replaced\n",
      hardLinkEtag,
      "application/yaml; charset=utf-8",
    );
    expect(hardLinkWrite.status).toBe(200);
    await expect(readFile(hardLinkPath, "utf8")).resolves.toBe("inside: replaced\n");
    await expect(readFile(fixture.outsideFile, "utf8")).resolves.toBe(outsideBefore);
  });

  it("enforces capacity, heartbeat leases, idempotent stop, revision checks, and loopback app origins", async () => {
    let now = Date.parse("2026-07-30T12:00:00.000Z");
    const fixture = await createFixture({
      now: () => now,
      ttlMs: 100,
      cleanupIntervalMs: 60_000,
    });

    await expect(fixture.service.start({
      repoId: fixture.repo.id,
      path: "site/index.html",
      expectedRevision: "stale",
      appOrigin: "http://127.0.0.1:5173",
    })).rejects.toThrow(/revision/i);
    await expect(fixture.service.start({
      repoId: fixture.repo.id,
      path: "site/index.html",
      expectedRevision: fixture.revision,
      appOrigin: "https://example.com",
    })).rejects.toThrow(/loopback/i);

    const statuses = await Promise.all(
      Array.from({ length: HTML_PREVIEW_MAX_SESSIONS }, () => fixture.service.start({
        repoId: fixture.repo.id,
        path: "site/index.html",
        expectedRevision: fixture.revision,
        appOrigin: "http://127.0.0.1:5173",
      })),
    );
    expect(fixture.service.activeCount()).toBe(HTML_PREVIEW_MAX_SESSIONS);
    expect(new Set(statuses.map((status) => status.origin)).size).toBe(HTML_PREVIEW_MAX_SESSIONS);
    const bootstraps = await Promise.all(statuses.map((status) => fetch(status.url, { redirect: "manual" })));
    const cookieNames = bootstraps.map((response) => (
      (response.headers.get("set-cookie") || "").split("=", 1)[0]
    ));
    expect(cookieNames.every(Boolean)).toBe(true);
    expect(new Set(cookieNames).size).toBe(HTML_PREVIEW_MAX_SESSIONS);

    await expect(fixture.service.start({
      repoId: fixture.repo.id,
      path: "site/index.html",
      expectedRevision: fixture.revision,
      appOrigin: "http://127.0.0.1:5173",
    })).rejects.toThrow(/up to 5/i);

    now += 50;
    const heartbeat = await fixture.service.heartbeat(statuses[0].id);
    expect(Date.parse(heartbeat.expiresAt)).toBe(now + 100);
    await fixture.service.stop(statuses[1].id);
    await fixture.service.stop(statuses[1].id);
    expect(fixture.service.activeCount()).toBe(4);

    now += 101;
    await expect(fixture.service.heartbeat(statuses[0].id)).rejects.toThrow(/expired/i);
    expect(fixture.service.activeCount()).toBe(0);

    const changed = await fixture.service.start({
      repoId: fixture.repo.id,
      path: "site/index.html",
      expectedRevision: fixture.revision,
      appOrigin: "http://127.0.0.1:5173",
    });
    const active = await activateSession(changed);
    fixture.repo.defaultPath = "changed.html";
    const expiredByConfig = await previewFetch(active, active.url);
    expect(expiredByConfig.status).toBe(409);
    expect(fixture.service.activeCount()).toBe(0);
  });
});

type Fixture = {
  root: string;
  outsideFile: string;
  repo: RepositoryConfig;
  revision: string;
  service: HtmlPreviewService;
};

type ActiveSession = {
  status: HtmlPreviewSessionStatus;
  bootstrap: Response;
  cookie: string;
  url: string;
};

async function createFixture(options: { now?: () => number; ttlMs?: number; cleanupIntervalMs?: number } = {}): Promise<Fixture> {
  const base = await mkdtemp(path.join(tmpdir(), "reader-wiki-html-preview-"));
  tempPaths.push(base);
  const root = path.join(base, "repo");
  const outsideFile = path.join(base, "outside.yaml");
  await Promise.all([
    mkdir(path.join(root, "site"), { recursive: true }),
    mkdir(path.join(root, "styles"), { recursive: true }),
    mkdir(path.join(root, "scripts"), { recursive: true }),
    mkdir(path.join(root, "data"), { recursive: true }),
    mkdir(path.join(root, "wasm"), { recursive: true }),
    mkdir(path.join(root, "frames"), { recursive: true }),
    mkdir(path.join(root, "private"), { recursive: true }),
    mkdir(path.join(root, ".git"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(root, "site", "index.html"), "<!doctype html><script id=\"fixture-inline-script\">window.fixture = true;</script><h1>Preview fixture</h1>\n"),
    writeFile(path.join(root, "styles", "app.css"), "body { color: green; }\n"),
    writeFile(path.join(root, "scripts", "app.mjs"), "export const ready = true;\n"),
    writeFile(path.join(root, "data", "state.json"), "{\"ready\":true}\n"),
    writeFile(path.join(root, "data", "state.yaml"), "ready: true\n"),
    writeFile(path.join(root, "wasm", "empty.wasm"), EMPTY_WASM_MODULE),
    writeFile(path.join(root, "frames", "child.html"), "<!doctype html><title>Child</title>\n"),
    writeFile(path.join(root, "private", "secret.json"), "{}\n"),
    writeFile(path.join(root, ".git", "config"), "[core]\n"),
    writeFile(path.join(root, "archive.zip"), Buffer.from([0x50, 0x4b])),
    writeFile(outsideFile, "outside: unchanged\n"),
  ]);
  const repo: RepositoryConfig = {
    id: "fixture-repo",
    label: "Fixture",
    root,
    defaultPath: "site/index.html",
    excludes: [".git", "private"],
  };
  const service = new HtmlPreviewServerService({
    repositoryRegistry: {
      findRepository: async (id) => {
        if (id !== repo.id) throw new Error("not found");
        return repo;
      },
    },
    bindHost: "127.0.0.1",
    ...options,
  });
  services.push(service);
  return { root, outsideFile, repo, revision: await repositoryRevision(repo), service };
}

async function startActiveSession(fixture: Fixture): Promise<ActiveSession> {
  const status = await fixture.service.start({
    repoId: fixture.repo.id,
    path: "site/index.html",
    expectedRevision: fixture.revision,
    appOrigin: "http://127.0.0.1:5173",
  });
  return activateSession(status);
}

async function activateSession(status: HtmlPreviewSessionStatus): Promise<ActiveSession> {
  const bootstrap = await fetch(status.url, { redirect: "manual" });
  const setCookie = bootstrap.headers.get("set-cookie") || "";
  const cookie = setCookie.split(";", 1)[0];
  const location = bootstrap.headers.get("location") || "";
  if (!cookie || !location) throw new Error("HTML preview bootstrap did not return cookie and location.");
  return { status, bootstrap, cookie, url: new URL(location, status.origin).href };
}

function previewFetch(active: ActiveSession, input: string | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Cookie", active.cookie);
  if (!headers.has("Sec-Fetch-Dest")) headers.set("Sec-Fetch-Dest", "empty");
  return fetch(input, { ...init, headers });
}

function previewWrite(
  active: ActiveSession,
  input: string | URL,
  body: BodyInit,
  etag: string,
  contentType: string,
): Promise<Response> {
  return previewFetch(active, input, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "If-Match": etag,
      Origin: active.status.origin,
      [HTML_PREVIEW_WRITE_HEADER]: HTML_PREVIEW_WRITE_VALUE,
    },
    body,
  });
}

function requireEtag(response: Response): string {
  const etag = response.headers.get("etag") || "";
  expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
  return etag;
}

function rawWriteStatus(
  active: ActiveSession,
  target: URL,
  body: string,
  headers: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: "PUT",
      headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode || 0));
    });
    request.once("error", reject);
    request.end(body);
  });
}
