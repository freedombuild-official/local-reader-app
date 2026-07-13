// @vitest-environment node

import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claudeCurrentRepoSandboxSupported, claudeCurrentRepoSettings, codexCurrentRepoArgs, requestRepoWriteAIChatCompletion, resolveAICommandLaunch, runAICommand, safeCliEnv, sanitizeCliText } from "../server/aiCliAdapters.js";
import { probeAIEntryReadiness } from "../server/aiEntries.js";

describe("AI CLI process boundary", () => {
  it("runs Codex native tools in the Current repo without Local Reader App edit-count limits", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-codex-direct-"));
    await writeFile(path.join(root, "README.md"), "# Direct Codex\n");
    const calls: Array<{ args: string[]; cwd: string; input: string }> = [];
    try {
      const result = await requestRepoWriteAIChatCompletion({
        target: { kind: "codexCli", entry: "codexCli", status: { state: "ready", code: "success", message: "ready", checkedAt: new Date().toISOString() } },
        messages: [{ role: "user", content: "Create the requested directory tree and files." }],
        context: { repoId: "docs", revision: "revision", primaryItems: [], ruleItems: [], systemPromptVersion: "test" },
        repo: { id: "docs", label: "Docs", root, defaultPath: "README.md", excludes: [] },
        runner: async (binary, args, options) => {
          expect(binary).toBe("codex");
          calls.push({ args, cwd: options.cwd, input: options.input || "" });
          if (args.includes("mcp")) return { stdout: '[{"name":"project-tools","transport":{"type":"stdio"}}]', stderr: "" };
          await Promise.all(Array.from({ length: 12 }, async (_, index) => {
            const directory = path.join(options.cwd, "generated", `group-${Math.floor(index / 4)}`);
            await mkdir(directory, { recursive: true });
            await writeFile(path.join(directory, `file-${index}.md`), `# File ${index}\n`);
          }));
          return { stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"Created the requested files."}}\n', stderr: "" };
        },
      });

      expect(result.content).toBe("Created the requested files.");
      expect(result.run).toMatchObject({ accessMode: "repoWrite", entry: "codexCli", substrate: "codexCli", auditState: "verified" });
      expect(result.run.changedPaths).toHaveLength(12);
      expect(result.run.changedPaths).toEqual(expect.arrayContaining([
        { path: "generated/group-0/file-0.md", status: "new" },
        { path: "generated/group-2/file-11.md", status: "new" },
      ]));
      const captured = calls.find((call) => Boolean(call.input));
      expect(captured?.cwd).toBe(await realpath(root));
      expect(captured?.input).toContain("does not impose a file-count, directory-count, or edit-operation-count limit");
      expect(captured?.args).toEqual(expect.arrayContaining([
        "exec",
        "--strict-config",
        "--ignore-user-config",
        "approval_policy=\"never\"",
        "--ephemeral",
        "--skip-git-repo-check",
        "--json",
        "-C",
        await realpath(root),
        "-",
      ]));
      expect(captured?.args).not.toContain("--add-dir");
      expect(captured?.args).not.toContain("--ignore-rules");
      expect(captured?.args.some((argument) => /^default_permissions="reader_wiki_[a-f0-9]{32}"$/.test(argument))).toBe(true);
      expect(captured?.args.some((argument) => /^permissions\.reader_wiki_[a-f0-9]{32}\.filesystem=/.test(argument))).toBe(true);
      expect(captured?.args).toContain('mcp_servers."project-tools"={enabled=false,command="reader-wiki-disabled-mcp",args=[]}');
      expect(codexCurrentRepoArgs("reader_wiki_test")).toEqual(expect.arrayContaining([
        "--strict-config",
        "--ignore-user-config",
        "approval_policy=\"never\"",
        "default_permissions=\"reader_wiki_test\"",
        "permissions.reader_wiki_test.network.enabled=false",
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs Claude native repository tools with acceptEdits, isolated settings, and inherited CLI auth", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-claude-direct-"));
    const previousToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-claude-oauth-token";
    const calls: Array<{ args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
    try {
      const result = await requestRepoWriteAIChatCompletion({
        target: { kind: "claudeCli", entry: "claudeCli", status: { state: "ready", code: "success", message: "ready", checkedAt: new Date().toISOString() } },
        messages: [{ role: "user", content: "Create a nested file." }],
        context: { repoId: "docs", revision: "revision", primaryItems: [], ruleItems: [], systemPromptVersion: "test" },
        repo: { id: "docs", label: "Docs", root, defaultPath: "README.md", excludes: [] },
        runner: async (binary, args, options) => {
          expect(binary).toBe("claude");
          calls.push({ args, cwd: options.cwd, env: options.env });
          await mkdir(path.join(options.cwd, "nested"), { recursive: true });
          await writeFile(path.join(options.cwd, "nested", "claude.md"), "# Claude\n");
          return { stdout: JSON.stringify({ is_error: false, result: "Created nested/claude.md." }), stderr: "" };
        },
      });

      expect(result.run.changedPaths).toEqual([{ path: "nested/claude.md", status: "new" }]);
      const captured = calls[0];
      expect(captured?.cwd).toBe(await realpath(root));
      expect(captured?.args).toEqual(expect.arrayContaining([
        "-p",
        "--output-format",
        "json",
        "--setting-sources",
        "",
        "--settings",
        claudeCurrentRepoSettings(),
        "--tools",
        "Bash,Glob,Grep,Read,Edit,Write",
        "--permission-mode",
        "acceptEdits",
      ]));
      expect(captured?.args).not.toContain("--disallowedTools");
      expect(captured?.args).not.toContain("--max-budget-usd");
      expect(captured?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("test-claude-oauth-token");
    } finally {
      if (previousToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = previousToken;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not expose raw Codex output when no final agent message is present", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-codex-natural-error-"));
    await writeFile(path.join(root, "README.md"), "# Codex natural error\n");
    try {
      const request = requestRepoWriteAIChatCompletion({
        target: { kind: "codexCli", entry: "codexCli", status: { state: "ready", code: "success", message: "ready", checkedAt: new Date().toISOString() } },
        messages: [{ role: "user", content: "Complete the request." }],
        context: { repoId: "docs", revision: "revision", primaryItems: [], ruleItems: [], systemPromptVersion: "test" },
        repo: { id: "docs", label: "Docs", root, defaultPath: "README.md", excludes: [] },
        runner: async (_binary, args) => args.includes("mcp")
          ? { stdout: "[]", stderr: "" }
          : { stdout: "RAW_STDOUT_SENTINEL\n{\"type\":\"thread.completed\"}\n", stderr: "RAW_STDERR_SENTINEL" },
      });
      const error = await request.then(() => null, (reason: unknown) => reason as Error);
      expect(error?.message).toBe("Codex CLI did not return a usable natural-language response. Try the request again.");
      expect(error?.message).not.toContain("RAW_STDOUT_SENTINEL");
      expect(error?.message).not.toContain("RAW_STDERR_SENTINEL");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("converts Claude error payloads to a user-facing explanation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-claude-natural-error-"));
    await writeFile(path.join(root, "README.md"), "# Claude natural error\n");
    try {
      const request = requestRepoWriteAIChatCompletion({
        target: { kind: "claudeCli", entry: "claudeCli", status: { state: "ready", code: "success", message: "ready", checkedAt: new Date().toISOString() } },
        messages: [{ role: "user", content: "Complete the request." }],
        context: { repoId: "docs", revision: "revision", primaryItems: [], ruleItems: [], systemPromptVersion: "test" },
        repo: { id: "docs", label: "Docs", root, defaultPath: "README.md", excludes: [] },
        runner: async () => ({ stdout: JSON.stringify({ is_error: true, result: "RAW_PROVIDER_SENTINEL Invalid API key" }), stderr: "RAW_STDERR_SENTINEL" }),
      });
      const error = await request.then(() => null, (reason: unknown) => reason as Error);
      expect(error?.message).toBe("Claude Code CLI could not authenticate. Open Settings, complete CLI sign-in, and check readiness again.");
      expect(error?.message).not.toContain("RAW_PROVIDER_SENTINEL");
      expect(error?.message).not.toContain("RAW_STDERR_SENTINEL");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("redacts inherited Claude secrets from JSON and authorization output", () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "plain-secret-value";
    try {
      expect(sanitizeCliText('{"ANTHROPIC_API_KEY":"plain-secret-value","authorization":"Bearer plain-secret-value"}')).toBe(
        '{"ANTHROPIC_API_KEY":"[redacted]","authorization":"Bearer [redacted]"}',
      );
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it("fails closed instead of claiming a Current repo-only Claude Bash boundary on native Windows", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-claude-windows-boundary-"));
    await writeFile(path.join(root, "README.md"), "# Windows boundary\n");
    const calls: string[][] = [];
    try {
      expect(claudeCurrentRepoSandboxSupported("win32")).toBe(false);
      expect(JSON.parse(claudeCurrentRepoSettings())).toMatchObject({
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          allowUnsandboxedCommands: false,
        },
      });
      const readiness = await probeAIEntryReadiness("claudeCli", {
        platform: "win32",
        repo: { id: "docs", label: "Docs", root, defaultPath: "README.md", excludes: [] },
        runner: async (_binary, args) => {
          calls.push(args);
          if (args.includes("--version")) return { stdout: "2.1.206 (Claude Code)\n", stderr: "" };
          if (args.includes("auth")) return { stdout: '{"loggedIn":true}\n', stderr: "" };
          if (args.includes("--help")) {
            return { stdout: "--print --output-format --tools --permission-mode --safe-mode --no-chrome --disable-slash-commands --strict-mcp-config --mcp-config --setting-sources --settings --no-session-persistence\n", stderr: "" };
          }
          throw new Error("A model probe must not run on an unsupported native Windows boundary.");
        },
      });
      expect(readiness).toMatchObject({
        ready: false,
        status: { code: "wrapper_not_ready" },
        settings: { authState: "configured", executionMode: "unknown" },
      });
      expect(readiness.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "wrapper", status: "error", message: expect.stringContaining("Native Windows") }),
      ]));
      expect(calls.some((args) => args.includes("--tools"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not report Claude ready when a configured credential fails the no-tool model probe", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-claude-auth-probe-"));
    await writeFile(path.join(root, "README.md"), "# Auth probe\n");
    const repo = { id: "docs", label: "Docs", root, defaultPath: "README.md", excludes: [] };
    try {
      const readiness = await probeAIEntryReadiness("claudeCli", {
        platform: "linux",
        repo,
        runner: async (_binary, args) => {
          if (args.includes("--version")) return { stdout: "2.1.206 (Claude Code)\n", stderr: "" };
          if (args.includes("auth")) return { stdout: '{"loggedIn":true}\n', stderr: "" };
          if (args.includes("--help")) {
            return { stdout: "--print --output-format --tools --permission-mode --safe-mode --no-chrome --disable-slash-commands --strict-mcp-config --mcp-config --setting-sources --settings --no-session-persistence\n", stderr: "" };
          }
          if (args[args.indexOf("--tools") + 1] === "") throw new Error("Invalid API key");
          throw new Error("Unexpected Claude command");
        },
      });
      expect(readiness.ready).toBe(false);
      expect(readiness.status).toMatchObject({ state: "failed", code: "cli_auth_missing" });
      expect(readiness.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "auth", status: "error", message: "Invalid API key" }),
      ]));
      expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("# Auth probe\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("handles a child that closes stdin early without an unhandled EPIPE", async () => {
    const result = await runAICommand(process.execPath, ["-e", "process.exit(0)"], {
      cwd: process.cwd(),
      env: process.env,
      input: "x".repeat(256 * 1024),
      timeoutMs: 5_000,
      maxBuffer: 1024,
    }).then(
      (value) => ({ kind: "resolved" as const, value }),
      (error) => ({ kind: "rejected" as const, error }),
    );
    if (result.kind === "rejected") expect(result.error).toMatchObject({ status: 502 });
    else expect(result.value).toEqual({ stdout: "", stderr: "" });
  });

  it("terminates a command when combined stdout and stderr exceed the byte limit", async () => {
    await expect(runAICommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 1000)"], {
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5_000,
      maxBuffer: 128,
    })).rejects.toMatchObject({
      status: 502,
      message: "The CLI returned more information than Local Reader App can display safely. Ask for a smaller result and try again.",
    });
  });

  it("does not expose stdout, stderr, or an exit code when a CLI process fails", async () => {
    const result = runAICommand(process.execPath, ["-e", "process.stdout.write('RAW_STDOUT_SENTINEL'); process.stderr.write('RAW_STDERR_SENTINEL'); process.exit(7)"], {
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5_000,
      maxBuffer: 1024,
    });
    const error = await result.then(() => null, (reason: unknown) => reason as Error);
    expect(error?.message).toBe("The CLI could not complete the request. Check readiness and try again.");
    expect(error?.message).not.toContain("RAW_STDOUT_SENTINEL");
    expect(error?.message).not.toContain("RAW_STDERR_SENTINEL");
    expect(error?.message).not.toContain("7");
  });

  it("does not resolve an aborted run until its descendant process is gone", { timeout: 15_000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-process-tree-"));
    const pidFile = path.join(root, "grandchild.pid");
    const controller = new AbortController();
    const script = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const run = runAICommand(process.execPath, ["-e", script], {
      cwd: root,
      env: process.env,
      timeoutMs: 10_000,
      maxBuffer: 1024,
      signal: controller.signal,
    });

    await waitFor(async () => {
      try {
        return Boolean((await readFile(pidFile, "utf8")).trim());
      } catch {
        return false;
      }
    });
    const grandchildPid = Number(await readFile(pidFile, "utf8"));
    controller.abort();
    await expect(run).rejects.toMatchObject({ status: 499 });
    await waitFor(() => !processExists(grandchildPid));
    expect(processExists(grandchildPid)).toBe(false);
  });

  it("preserves the minimum Windows command environment without forwarding provider secrets", () => {
    const previous = {
      USERPROFILE: process.env.USERPROFILE,
      APPDATA: process.env.APPDATA,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      SystemRoot: process.env.SystemRoot,
      COMSPEC: process.env.COMSPEC,
      PATHEXT: process.env.PATHEXT,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    };
    try {
      process.env.USERPROFILE = "C:\\Users\\example";
      process.env.APPDATA = "C:\\Users\\example\\AppData\\Roaming";
      process.env.LOCALAPPDATA = "C:\\Users\\example\\AppData\\Local";
      process.env.SystemRoot = "C:\\Windows";
      process.env.COMSPEC = "C:\\Windows\\System32\\cmd.exe";
      process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
      process.env.OPENAI_API_KEY = "secret-not-forwarded";
      expect(safeCliEnv("codexCli", {}, "win32")).toMatchObject({
        USERPROFILE: process.env.USERPROFILE,
        APPDATA: process.env.APPDATA,
        LOCALAPPDATA: process.env.LOCALAPPDATA,
        SystemRoot: process.env.SystemRoot,
        COMSPEC: process.env.COMSPEC,
        PATHEXT: process.env.PATHEXT,
      });
      expect(safeCliEnv("codexCli", {}, "win32")).not.toHaveProperty("OPENAI_API_KEY");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("resolves a trusted Windows npm cmd shim to Node while preserving every argv item", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-windows-cmd-"));
    const entry = path.join(root, "node_modules", "@openai", "codex", "bin", "codex.js");
    const shim = path.join(root, "codex.cmd");
    const nodeExecutable = path.join(root, "node.exe");
    const args = ["exec", "--model", "value with spaces", "& calc.exe", "\"quoted\"", "100%"];
    try {
      await mkdir(path.dirname(entry), { recursive: true });
      await writeFile(entry, "process.exit(0);\n", "utf8");
      await writeFile(shim, [
        "@ECHO off",
        "SETLOCAL",
        "SET dp0=%~dp0",
        "SET _prog=node",
        "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js\" %*",
      ].join("\r\n"), "utf8");

      await expect(resolveAICommandLaunch("codex", args, {
        platform: "win32",
        env: { PATH: root },
        cwd: root,
        nodeExecutable,
      })).resolves.toEqual({
        binary: nodeExecutable,
        args: [entry, ...args],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prefers a native Windows executable over a same-name cmd shim", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-windows-native-"));
    const shimDirectory = path.join(root, "shim-first");
    const nativeDirectory = path.join(root, "native-second");
    const executable = path.join(nativeDirectory, "codex.exe");
    try {
      await Promise.all([
        mkdir(shimDirectory, { recursive: true }),
        mkdir(nativeDirectory, { recursive: true }),
      ]);
      await writeFile(executable, "native placeholder", "utf8");
      await writeFile(path.join(shimDirectory, "codex.cmd"), "@echo off\r\nunsupported.exe %*\r\n", "utf8");
      await expect(resolveAICommandLaunch("codex", ["exec", "argument with spaces"], {
        platform: "win32",
        env: { PATH: `${shimDirectory};${nativeDirectory}` },
        cwd: root,
      })).resolves.toEqual({
        binary: executable,
        args: ["exec", "argument with spaces"],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unsupported Windows cmd shims instead of invoking a command shell", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-windows-unsupported-"));
    try {
      await writeFile(path.join(root, "codex.cmd"), "@echo off\r\n%COMSPEC% /c calc.exe %*\r\n", "utf8");
      await expect(resolveAICommandLaunch("codex", ["exec"], {
        platform: "win32",
        env: { PATH: root },
        cwd: root,
      })).rejects.toMatchObject({
        status: 502,
        message: "Unsupported Windows .cmd shim; only trusted npm or pnpm Node launchers are allowed.",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for process state.");
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
