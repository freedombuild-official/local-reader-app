// @vitest-environment node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { requestRepoWriteAIChatCompletion, resolveAICommandLaunch, runAICommand, safeCliEnv } from "../server/aiCliAdapters.js";

describe("AI CLI process boundary", () => {
  it.each([
    ["codexCli", "Codex CLI"],
    ["claudeCli", "Claude Code CLI"],
  ] as const)("keeps %s repository editing fail-closed before launching a process", async (entry, label) => {
    const target = entry === "codexCli"
      ? { kind: "codexCli" as const, entry: "codexCli" as const, status: { state: "ready" as const, code: "success" as const, message: "stale ready", checkedAt: new Date().toISOString() } }
      : { kind: "claudeCli" as const, entry: "claudeCli" as const, status: { state: "ready" as const, code: "success" as const, message: "stale ready", checkedAt: new Date().toISOString() } };
    await expect(requestRepoWriteAIChatCompletion({
      target,
      messages: [{ role: "user", content: "Edit the repository." }],
      context: { repoId: "docs", revision: "revision", primaryItems: [], ruleItems: [], systemPromptVersion: "test" },
      repo: { id: "docs", label: "Docs", root: process.cwd(), defaultPath: "README.md", excludes: [] },
    })).rejects.toMatchObject({ status: 409, message: expect.stringContaining(label) });
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
      message: "CLI output exceeded the Reader-Wiki byte limit.",
    });
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
