// @vitest-environment node

import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HttpError } from "../server/errors.js";
import { parseGuardedEditResponse } from "../server/guardedEditProtocol.js";
import { buildGuardedRepoPathPolicy, probeGuardedRepoWriteCapability, requestGuardedRepoWriteAIChatCompletion, type GuardedProviderRequester } from "../server/guardedRepoEdits.js";
import type { AIChatContext, AIConnectionStatus, AIProviderSettings, RepositoryConfig } from "../server/types.js";

const VERSION = "reader-wiki.edit-protocol.v1";

describe("guarded provider repository edits", () => {
  it("applies validated multi-file replace, create, and delete operations without giving the provider filesystem access", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-guarded-edit-"));
    const outside = path.join(tmpdir(), `reader-wiki-guarded-outside-${path.basename(root)}.txt`);
    try {
      await writeFile(path.join(root, "README.md"), "# Before\n\nold value\n", "utf8");
      await writeFile(path.join(root, "obsolete.md"), "remove me\n", "utf8");
      await mkdir(path.join(root, ".codex"));
      await mkdir(path.join(root, ".agents"));
      await writeFile(path.join(root, ".codex/secret.txt"), "not provider-visible\n", "utf8");
      await writeFile(path.join(root, ".agents/secret.txt"), "not provider-visible\n", "utf8");
      await writeFile(path.join(root, "secret.txt"), "excluded from provider\n", "utf8");
      await writeFile(outside, "outside unchanged\n", "utf8");
      const calls: Array<{ systemPrompt?: string; messages?: Array<{ role: string; content: string }> }> = [];
      const requester: GuardedProviderRequester = async (request) => {
        calls.push(request);
        const content = calls.length === 1
          ? JSON.stringify({ version: VERSION, type: "read", paths: ["README.md", "obsolete.md"] })
          : JSON.stringify({
            version: VERSION,
            type: "apply",
            operations: [
              { op: "replace", path: "README.md", oldText: "old value", newText: "new value" },
              { op: "write", path: "docs/nested/new.md", content: "# New\n\ncreated\n" },
              { op: "delete", path: "obsolete.md" },
            ],
            message: "更新しました。",
          });
        return { content, status: readyStatus() };
      };

      const result = await requestGuardedRepoWriteAIChatCompletion({
        provider: provider(),
        repo: repository(root, ["secret.txt"]),
        messages: [{ role: "user", content: "READMEを更新し、新規ファイルを作ってください。\nDELETE: obsolete.md" }],
        context: context(),
        requester,
      });

      expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("# Before\n\nnew value\n");
      expect(await readFile(path.join(root, "docs/nested/new.md"), "utf8")).toBe("# New\n\ncreated\n");
      await expect(access(path.join(root, "obsolete.md"))).rejects.toThrow();
      expect(await readFile(outside, "utf8")).toBe("outside unchanged\n");
      expect(result.run).toMatchObject({
        substrate: "serverEditProtocol",
        auditState: "verified",
        readPaths: ["README.md", "obsolete.md"],
        changedPaths: [
          { path: "README.md", status: "changed" },
          { path: "docs/nested/new.md", status: "new" },
          { path: "obsolete.md", status: "deleted" },
        ],
      });
      expect(calls).toHaveLength(2);
      expect(calls[0]?.systemPrompt).toContain("no shell, filesystem, Git");
      const initialTask = calls[0]?.messages?.[0]?.content || "";
      expect(initialTask).not.toContain(root);
      expect(initialTask).not.toContain(".codex");
      expect(initialTask).not.toContain(".agents");
      expect(initialTask).not.toContain("secret.txt");
      const readResult = calls[1]?.messages?.find((message) => message.content.includes('"type":"read_result"'))?.content || "";
      expect(readResult).toContain('"type":"read_result"');
      expect(readResult).not.toContain(root);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { force: true });
    }
  });

  it("rejects protected, excluded, traversal, and symlink reads before any apply", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-guarded-boundary-"));
    const outside = path.join(tmpdir(), `reader-wiki-guarded-secret-${path.basename(root)}.txt`);
    try {
      await mkdir(path.join(root, ".git"));
      await writeFile(path.join(root, ".git/config"), "protected\n", "utf8");
      await writeFile(path.join(root, "secret.txt"), "excluded\n", "utf8");
      await writeFile(outside, "outside\n", "utf8");
      await symlink(outside, path.join(root, "link.txt"));

      for (const requestedPath of [
        ".git/config",
        "secret.txt",
        "SeCrEt.TxT",
        "../outside.txt",
        "C:\\outside.txt",
        ".reader-wiki-ai-staging/note.md",
        "nested/.codex/private.md",
        "nested/.agents/private.md",
        "NUL.txt",
        "line\nbreak.md",
        "safe/\u202eevil.md",
        "link.txt",
      ]) {
        const requester: GuardedProviderRequester = async () => ({
          content: JSON.stringify({ version: VERSION, type: "read", paths: [requestedPath] }),
          status: readyStatus(),
        });
        await expect(requestGuardedRepoWriteAIChatCompletion({
          provider: provider(),
          repo: repository(root, ["secret.txt"]),
          messages: [{ role: "user", content: "read" }],
          context: context(),
          requester,
        })).rejects.toMatchObject({ status: expect.any(Number) });
      }
      expect(await readFile(outside, "utf8")).toBe("outside\n");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { force: true });
    }
  });

  it("fails closed on prose-wrapped or unknown-field JSON", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-guarded-json-"));
    try {
      const responses = [
        `Here is the plan: ${JSON.stringify({ version: VERSION, type: "complete", message: "no-op" })}`,
        JSON.stringify({ version: VERSION, type: "apply", operations: [], message: "no-op", extra: true }),
      ];
      for (const content of responses) {
        const requester: GuardedProviderRequester = async () => ({ content, status: readyStatus() });
        await expect(requestGuardedRepoWriteAIChatCompletion({
          provider: provider(),
          repo: repository(root),
          messages: [{ role: "user", content: "answer" }],
          context: context(),
          requester,
        })).rejects.toMatchObject({ status: 502 });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an existing target that changed after the validated read", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-guarded-cas-"));
    try {
      const target = path.join(root, "note.md");
      await writeFile(target, "before\n", "utf8");
      let call = 0;
      const requester: GuardedProviderRequester = async () => {
        call += 1;
        if (call === 1) return { content: JSON.stringify({ version: VERSION, type: "read", paths: ["note.md"] }), status: readyStatus() };
        await writeFile(target, "external change\n", "utf8");
        return {
          content: JSON.stringify({ version: VERSION, type: "apply", operations: [{ op: "write", path: "note.md", content: "model change\n" }], message: "changed" }),
          status: readyStatus(),
        };
      };

      await expect(requestGuardedRepoWriteAIChatCompletion({
        provider: provider(),
        repo: repository(root),
        messages: [{ role: "user", content: "change note" }],
        context: context(),
        requester,
      })).rejects.toMatchObject({ status: 409 });
      expect(await readFile(target, "utf8")).toBe("external change\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops before apply when the provider request is canceled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-guarded-cancel-"));
    try {
      const target = path.join(root, "note.md");
      await writeFile(target, "before\n", "utf8");
      const controller = new AbortController();
      let call = 0;
      let markSecondStarted: (() => void) | undefined;
      const secondStarted = new Promise<void>((resolve) => {
        markSecondStarted = resolve;
      });
      const requester: GuardedProviderRequester = async (request) => {
        call += 1;
        if (call === 1) {
          return { content: JSON.stringify({ version: VERSION, type: "read", paths: ["note.md"] }), status: readyStatus() };
        }
        markSecondStarted?.();
        return new Promise((_resolve, reject) => {
          const fail = () => reject(new HttpError(499, "AI provider request was canceled."));
          if (request.signal?.aborted) fail();
          else request.signal?.addEventListener("abort", fail, { once: true });
        });
      };

      const run = requestGuardedRepoWriteAIChatCompletion({
        provider: provider(),
        repo: repository(root),
        messages: [{ role: "user", content: "change note" }],
        context: context(),
        requester,
        signal: controller.signal,
      });
      await secondStarted;
      controller.abort();
      await expect(run).rejects.toMatchObject({ status: 499 });
      expect(await readFile(target, "utf8")).toBe("before\n");
      expect((await readdir(root)).filter((name) => name.startsWith(".reader-wiki-ai-"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires an exact user-authorized path before deleting a file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-guarded-delete-auth-"));
    try {
      const target = path.join(root, "note.md");
      await writeFile(target, "keep me\n", "utf8");
      let call = 0;
      const requester: GuardedProviderRequester = async () => {
        call += 1;
        return call === 1
          ? { content: JSON.stringify({ version: VERSION, type: "read", paths: ["note.md"] }), status: readyStatus() }
          : { content: JSON.stringify({ version: VERSION, type: "apply", operations: [{ op: "delete", path: "note.md" }], message: "deleted" }), status: readyStatus() };
      };
      await expect(requestGuardedRepoWriteAIChatCompletion({
        provider: provider(),
        repo: repository(root),
        messages: [{ role: "user", content: "Update the repository." }],
        context: context(),
        requester,
      })).rejects.toMatchObject({ status: 403 });
      expect(await readFile(target, "utf8")).toBe("keep me\n");

      call = 0;
      await expect(requestGuardedRepoWriteAIChatCompletion({
        provider: provider(),
        repo: repository(root),
        messages: [
          { role: "user", content: "DELETE: note.md" },
          { role: "assistant", content: "Deletion noted." },
          { role: "user", content: "Update the repository without deletion." },
        ],
        context: context(),
        requester,
      })).rejects.toMatchObject({ status: 403 });
      expect(await readFile(target, "utf8")).toBe("keep me\n");

      call = 0;
      await expect(requestGuardedRepoWriteAIChatCompletion({
        provider: provider(),
        repo: repository(root),
        messages: [{ role: "user", content: "DELETE: other.md" }],
        context: context(),
        requester,
      })).rejects.toMatchObject({ status: 403 });
      expect(await readFile(target, "utf8")).toBe("keep me\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects case-folded and Unicode-normalized operation collisions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-guarded-unicode-collision-"));
    try {
      const requester: GuardedProviderRequester = async () => ({
        content: JSON.stringify({
          version: VERSION,
          type: "apply",
          operations: [
            { op: "write", path: "Caf\u00e9.md", content: "one\n" },
            { op: "write", path: "CAFE\u0301.md", content: "two\n" },
          ],
          message: "collision",
        }),
        status: readyStatus(),
      });
      await expect(requestGuardedRepoWriteAIChatCompletion({
        provider: provider(),
        repo: repository(root),
        messages: [{ role: "user", content: "Create the files." }],
        context: context(),
        requester,
      })).rejects.toMatchObject({ status: 502 });
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("honors cancellation even when the provider resolves a normal apply response after abort", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-guarded-resolved-cancel-"));
    try {
      const target = path.join(root, "note.md");
      await writeFile(target, "before\n", "utf8");
      const controller = new AbortController();
      let call = 0;
      const requester: GuardedProviderRequester = async () => {
        call += 1;
        if (call === 1) return { content: JSON.stringify({ version: VERSION, type: "read", paths: ["note.md"] }), status: readyStatus() };
        controller.abort();
        return { content: JSON.stringify({ version: VERSION, type: "apply", operations: [{ op: "write", path: "note.md", content: "after\n" }], message: "changed" }), status: readyStatus() };
      };
      await expect(requestGuardedRepoWriteAIChatCompletion({
        provider: provider(),
        repo: repository(root),
        messages: [{ role: "user", content: "change note" }],
        context: context(),
        requester,
        signal: controller.signal,
      })).rejects.toMatchObject({ status: 499 });
      expect(await readFile(target, "utf8")).toBe("before\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rechecks each file immediately before commit and preserves a concurrent external change", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-guarded-commit-cas-"));
    try {
      await writeFile(path.join(root, "first.md"), "first before\n", "utf8");
      await writeFile(path.join(root, "second.md"), "second before\n", "utf8");
      let call = 0;
      const requester: GuardedProviderRequester = async () => {
        call += 1;
        return call === 1
          ? { content: JSON.stringify({ version: VERSION, type: "read", paths: ["first.md", "second.md"] }), status: readyStatus() }
          : { content: JSON.stringify({ version: VERSION, type: "apply", operations: [
            { op: "write", path: "first.md", content: "first after\n" },
            { op: "write", path: "second.md", content: "second after\n" },
          ], message: "changed" }), status: readyStatus() };
      };
      await expect(requestGuardedRepoWriteAIChatCompletion({
        provider: provider(),
        repo: repository(root),
        messages: [{ role: "user", content: "change both" }],
        context: context(),
        requester,
        mutationFaultInjector: async (phase, index) => {
          if (phase === "before-commit" && index === 1) await writeFile(path.join(root, "second.md"), "external change\n", "utf8");
        },
      })).rejects.toMatchObject({ status: 409 });
      expect(await readFile(path.join(root, "first.md"), "utf8")).toBe("first before\n");
      expect(await readFile(path.join(root, "second.md"), "utf8")).toBe("external change\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves an external change and recovery backup when postflight ownership changes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-guarded-postflight-"));
    try {
      const target = path.join(root, "note.md");
      await writeFile(target, "before\n", "utf8");
      let call = 0;
      const requester: GuardedProviderRequester = async () => {
        call += 1;
        return call === 1
          ? { content: JSON.stringify({ version: VERSION, type: "read", paths: ["note.md"] }), status: readyStatus() }
          : { content: JSON.stringify({ version: VERSION, type: "apply", operations: [{ op: "write", path: "note.md", content: "after\n" }], message: "changed" }), status: readyStatus() };
      };
      const failure = await requestGuardedRepoWriteAIChatCompletion({
        provider: provider(),
        repo: repository(root),
        messages: [{ role: "user", content: "change note" }],
        context: context(),
        requester,
        mutationFaultInjector: async (phase) => {
          if (phase === "before-postflight") await writeFile(target, "tampered\n", "utf8");
        },
      }).then(
        () => null,
        (error: unknown) => error as HttpError,
      );
      expect(failure).toMatchObject({
        status: 409,
        details: { code: "guarded_rollback_incomplete", rollbackState: "unverified" },
      });
      expect(failure?.message).toContain("changed after Local Reader App placed it");
      expect(failure?.message).not.toContain(root);
      expect(await readFile(target, "utf8")).toBe("tampered\n");
      const artifacts = (await readdir(root)).filter((name) => name.startsWith(".reader-wiki-ai-") && name.endsWith(".bak"));
      expect(artifacts).toHaveLength(1);
      expect(await readFile(path.join(root, artifacts[0]), "utf8")).toBe("before\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not replace a file recreated after the original was moved to backup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-guarded-no-replace-"));
    try {
      const target = path.join(root, "note.md");
      await writeFile(target, "before\n", "utf8");
      let call = 0;
      const requester: GuardedProviderRequester = async () => {
        call += 1;
        return call === 1
          ? { content: JSON.stringify({ version: VERSION, type: "read", paths: ["note.md"] }), status: readyStatus() }
          : { content: JSON.stringify({ version: VERSION, type: "apply", operations: [{ op: "write", path: "note.md", content: "after\n" }], message: "changed" }), status: readyStatus() };
      };
      const failure = await requestGuardedRepoWriteAIChatCompletion({
        provider: provider(),
        repo: repository(root),
        messages: [{ role: "user", content: "change note" }],
        context: context(),
        requester,
        mutationFaultInjector: async (phase) => {
          if (phase === "after-backup") await writeFile(target, "external recreation\n", "utf8");
        },
      }).then(
        () => null,
        (error: unknown) => error as HttpError,
      );
      expect(failure).toMatchObject({ status: 409, details: { code: "guarded_rollback_incomplete" } });
      expect(await readFile(target, "utf8")).toBe("external recreation\n");
      const backups = (await readdir(root)).filter((name) => name.endsWith(".bak"));
      expect(backups).toHaveLength(1);
      expect(await readFile(path.join(root, backups[0]), "utf8")).toBe("before\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pins the repository root identity before provider work", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-guarded-root-pin-"));
    const movedRoot = `${root}-moved`;
    try {
      await writeFile(path.join(root, "note.md"), "original root\n", "utf8");
      const requester: GuardedProviderRequester = async () => {
        await rename(root, movedRoot);
        await mkdir(root);
        return { content: JSON.stringify({ version: VERSION, type: "apply", operations: [{ op: "write", path: "new.md", content: "must not write\n" }], message: "changed" }), status: readyStatus() };
      };
      await expect(requestGuardedRepoWriteAIChatCompletion({
        provider: provider(),
        repo: repository(root),
        messages: [{ role: "user", content: "create a file" }],
        context: context(),
        requester,
      })).rejects.toMatchObject({ status: 409 });
      await expect(access(path.join(root, "new.md"))).rejects.toThrow();
      expect(await readFile(path.join(movedRoot, "note.md"), "utf8")).toBe("original root\n");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(movedRoot, { recursive: true, force: true });
    }
  });

  it("hides and rejects Local Reader App control-plane files inside the Current repo", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-guarded-control-"));
    const otherRoot = await mkdtemp(path.join(tmpdir(), "reader-wiki-guarded-control-other-"));
    try {
      const configPath = path.join(root, "repositories.yaml");
      const original = `repositories:\n  - id: other\n    root: ${otherRoot}\n`;
      await writeFile(configPath, original, "utf8");
      const repo = repository(root);
      const pathPolicy = await buildGuardedRepoPathPolicy(repo, [configPath]);
      let calls = 0;
      const requester: GuardedProviderRequester = async (request) => {
        calls += 1;
        const task = request.messages?.[0]?.content || "";
        expect(task).not.toContain("repositories.yaml");
        expect(task).not.toContain(otherRoot);
        return { content: JSON.stringify({ version: VERSION, type: "read", paths: ["repositories.yaml"] }), status: readyStatus() };
      };
      await expect(requestGuardedRepoWriteAIChatCompletion({
        provider: provider(),
        repo,
        messages: [{ role: "user", content: "inspect configuration" }],
        context: context(),
        requester,
        pathPolicy,
      })).rejects.toMatchObject({ status: 403 });
      expect(calls).toBe(1);
      expect(await readFile(configPath, "utf8")).toBe(original);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  it("rolls back already-applied files and removes repo-local staging artifacts when a later commit fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-guarded-rollback-"));
    try {
      await writeFile(path.join(root, "first.md"), "first before\n", "utf8");
      await writeFile(path.join(root, "second.md"), "second before\n", "utf8");
      let call = 0;
      const requester: GuardedProviderRequester = async () => {
        call += 1;
        return call === 1
          ? { content: JSON.stringify({ version: VERSION, type: "read", paths: ["first.md", "second.md"] }), status: readyStatus() }
          : {
            content: JSON.stringify({
              version: VERSION,
              type: "apply",
              operations: [
                { op: "write", path: "first.md", content: "first after\n" },
                { op: "write", path: "second.md", content: "second after\n" },
              ],
              message: "changed",
            }),
            status: readyStatus(),
          };
      };

      await expect(requestGuardedRepoWriteAIChatCompletion({
        provider: provider(),
        repo: repository(root),
        messages: [{ role: "user", content: "change both" }],
        context: context(),
        requester,
        mutationFaultInjector: async (_phase, index) => {
          if (index === 1) throw new Error("injected commit failure");
        },
      })).rejects.toMatchObject({ status: 500 });
      expect(await readFile(path.join(root, "first.md"), "utf8")).toBe("first before\n");
      expect(await readFile(path.join(root, "second.md"), "utf8")).toBe("second before\n");
      expect((await readdir(root)).filter((name) => name.startsWith(".reader-wiki-ai-"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports rollback warnings when a guarded staging artifact cannot be safely removed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-guarded-rollback-warning-"));
    const docs = path.join(root, "docs");
    const movedDocs = path.join(root, "docs-moved");
    try {
      await mkdir(docs);
      await writeFile(path.join(docs, "note.md"), "before\n", "utf8");
      let call = 0;
      const requester: GuardedProviderRequester = async () => {
        call += 1;
        return call === 1
          ? { content: JSON.stringify({ version: VERSION, type: "read", paths: ["docs/note.md"] }), status: readyStatus() }
          : { content: JSON.stringify({ version: VERSION, type: "apply", operations: [{ op: "write", path: "docs/note.md", content: "after\n" }], message: "changed" }), status: readyStatus() };
      };
      let rollbackStarted = false;
      const failure = await requestGuardedRepoWriteAIChatCompletion({
        provider: provider(),
        repo: repository(root),
        messages: [{ role: "user", content: "change note" }],
        context: context(),
        requester,
        mutationFaultInjector: async (phase) => {
          if (phase === "before-commit") throw new Error("force rollback");
          if (phase === "before-rollback") {
            rollbackStarted = true;
            await rename(docs, movedDocs);
            await mkdir(docs);
          }
        },
      }).then(
        () => null,
        (error: unknown) => error as { status?: number; message?: string },
      );
      expect(rollbackStarted).toBe(true);
      expect(failure).toMatchObject({ status: 500, message: expect.stringContaining("Rollback warnings:") });
      await rm(docs, { recursive: true, force: true });
      await rename(movedDocs, docs);
      expect(await readFile(path.join(docs, "note.md"), "utf8")).toBe("before\n");
      const artifacts = (await readdir(docs)).filter((name) => name.startsWith(".reader-wiki-ai-"));
      expect(artifacts.length).toBeGreaterThan(0);
      await Promise.all(artifacts.map((name) => rm(path.join(docs, name), { force: true })));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("checks strict protocol capability without exposing a repository", async () => {
    let call = 0;
    const requester: GuardedProviderRequester = async (request) => {
      call += 1;
      expect(request.context).toBeUndefined();
      expect(request.systemPrompt).toContain(VERSION);
      const latest = JSON.parse(request.messages?.at(-1)?.content || "{}") as { type?: string; files?: Array<{ path?: string; content?: string }> };
      if (call === 1) {
        expect(latest).toMatchObject({ type: "capability_check", syntheticPath: "reader-wiki-capability-probe.md" });
        return {
          content: JSON.stringify({ version: VERSION, type: "read", paths: ["reader-wiki-capability-probe.md"], operations: null, message: null }),
          status: readyStatus(),
        };
      }
      expect(latest).toMatchObject({ type: "read_result", synthetic: true, files: [{ path: "reader-wiki-capability-probe.md", content: "Local Reader App capability probe: before" }] });
      return {
        content: JSON.stringify({
          version: VERSION,
          type: "apply",
          paths: [],
          operations: [{
            op: "replace",
            path: "reader-wiki-capability-probe.md",
            content: null,
            oldText: "Local Reader App capability probe: before",
            newText: "Local Reader App capability probe: after",
          }],
          message: "ready",
        }),
        status: readyStatus(),
      };
    };
    await expect(probeGuardedRepoWriteCapability(provider(), undefined, requester)).resolves.toMatchObject({ ok: true });
    expect(call).toBe(2);
    await expect(probeGuardedRepoWriteCapability(provider(), undefined, async () => ({
      content: JSON.stringify({ version: VERSION, type: "complete", message: "ready" }),
      status: readyStatus(),
    }))).resolves.toMatchObject({ ok: false, message: expect.stringContaining("synthetic guarded read") });
  });
});

describe("guarded edit protocol normalization", () => {
  it("accepts minimal and full envelopes while discarding only empty inactive fields", () => {
    expect(parseGuardedEditResponse(JSON.stringify({ version: VERSION, type: "read", paths: ["note.md"] }))).toEqual({ type: "read", paths: ["note.md"] });
    expect(parseGuardedEditResponse(JSON.stringify({
      version: VERSION,
      type: "apply",
      paths: [],
      operations: [{ op: "replace", path: "note.md", content: null, oldText: "before", newText: "after" }],
      message: "updated",
    }))).toEqual({ type: "apply", operations: [{ op: "replace", path: "note.md", oldText: "before", newText: "after" }], message: "updated" });
    expect(parseGuardedEditResponse(JSON.stringify({
      version: VERSION,
      type: "complete",
      paths: null,
      operations: "   ",
      message: "done",
    }))).toEqual({ type: "complete", message: "done" });
  });

  it("rejects missing, unknown, and non-empty conflicting fields with sanitized diagnostics", () => {
    const responses = [
      {
        value: { version: VERSION, type: "apply", operations: [], secretField: "do-not-echo-value" },
        details: { phase: "response", responseType: "apply", missingFields: ["message"], unknownFields: ["secretField"] },
      },
      {
        value: { version: VERSION, type: "apply", paths: ["private-value.md"], operations: [], message: "no-op" },
        details: { phase: "response", responseType: "apply", missingFields: [], unknownFields: ["paths"] },
      },
      {
        value: { version: VERSION, type: "apply", operations: [{ op: "write", path: "note.md", content: "safe", oldText: "private-value", newText: null }], message: "write" },
        details: { phase: "operation", operationType: "write", missingFields: [], unknownFields: ["oldText"] },
      },
    ];
    for (const item of responses) {
      let failure: HttpError | undefined;
      try {
        parseGuardedEditResponse(JSON.stringify(item.value));
      } catch (error) {
        failure = error as HttpError;
      }
      expect(failure).toMatchObject({ status: 502, details: item.details });
      expect(failure?.message).not.toContain("do-not-echo-value");
      expect(failure?.message).not.toContain("private-value");
      expect(JSON.stringify(failure?.details)).not.toContain("private-value");
    }
  });
});

function repository(root: string, excludes: string[] = []): RepositoryConfig {
  return { id: "test-repo", label: "Test repo", root, excludes, fetchRemote: false };
}

function provider(): AIProviderSettings {
  return { entry: "localAi", runtime: "lmStudio", model: "test-model", baseUrl: "http://127.0.0.1:1234/v1", apiFormat: "openaiCompatible", executionMode: "repoWrite" };
}

function context(): AIChatContext {
  return { repoId: "test-repo", revision: "test-revision", systemPromptVersion: "test", primaryItems: [], ruleItems: [] };
}

function readyStatus(): AIConnectionStatus {
  return { state: "ready", code: "success", severity: "success", message: "Response received.", checkedAt: new Date(0).toISOString() };
}
