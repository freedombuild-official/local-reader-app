// @vitest-environment node

import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

import { readGitIgnoredPaths, readTree, readTreeSnapshot } from "../server/repoFiles.js";
import type { RepositoryConfig } from "../server/types.js";

const execFileAsync = promisify(execFile);

class FakeGitChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  killed = false;
  kill = vi.fn(() => {
    this.killed = true;
    return true;
  });

  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.emit("close", code, signal);
  }
}

function mockGitResponse(output: string, code = 0): FakeGitChild {
  const child = new FakeGitChild();
  child.stdin.once("finish", () => {
    if (output) child.stdout.write(output);
    child.close(code);
  });
  spawnMock.mockReturnValueOnce(child);
  return child;
}

async function createGitRepo(): Promise<{ root: string; repo: RepositoryConfig }> {
  const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-git-ignore-process-"));
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  return { root, repo: { id: "test", label: "Test", root, defaultPath: "", excludes: [] } };
}

beforeEach(() => {
  spawnMock.mockReset();
});

describe("Git ignore process boundary", () => {
  it("uses one check-ignore process with NUL-delimited stdin and output", async () => {
    const child = mockGitResponse("ignored\nname.txt\0dir\0");
    const inputChunks: Buffer[] = [];
    child.stdin.on("data", (chunk: Buffer) => inputChunks.push(Buffer.from(chunk)));

    const ignored = await readGitIgnoredPaths("/repo", ["ignored\nname.txt", "dir"]);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(command).toBe("git");
    expect(args.slice(-3)).toEqual(["check-ignore", "-z", "--stdin"]);
    expect(args).not.toContain("--no-index");
    expect(Buffer.concat(inputChunks).toString("utf8")).toBe("ignored\nname.txt\0dir\0");
    expect(Array.from(ignored)).toEqual(["ignored\nname.txt", "dir"]);
  });

  it("starts one ignore process for one readTree batch", async () => {
    const { root, repo } = await createGitRepo();
    await writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(path.join(root, "ignored.txt"), "ignored");
    mockGitResponse("ignored.txt\0");

    const nodes = await readTree(repo, "");

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(nodes.find((node) => node.path === "ignored.txt")?.gitIgnored).toBe(true);
  });

  it("starts one ignore process after collecting one snapshot batch", async () => {
    const { root, repo } = await createGitRepo();
    await writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(path.join(root, "ignored.txt"), "ignored");
    mockGitResponse("ignored.txt\0");

    const result = await readTreeSnapshot(repo);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(result.tree[""]?.find((node) => node.path === "ignored.txt")?.gitIgnored).toBe(true);
  });

  it("keeps one snapshot batch while omitting paths beyond symbolic links", async () => {
    const { root, repo } = await createGitRepo();
    await mkdir(path.join(root, "target-dir"));
    await writeFile(path.join(root, "target-dir", "inside.txt"), "inside");
    await symlink("target-dir", path.join(root, "linked-dir"), "dir");
    await writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(path.join(root, "ignored.txt"), "ignored");
    const child = mockGitResponse("ignored.txt\0");
    const inputChunks: Buffer[] = [];
    child.stdin.on("data", (chunk: Buffer) => inputChunks.push(Buffer.from(chunk)));

    const result = await readTreeSnapshot(repo);
    const candidates = Buffer.concat(inputChunks).toString("utf8").split("\0").filter(Boolean);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(candidates).toContain("linked-dir");
    expect(candidates).not.toContain("linked-dir/inside.txt");
    expect(result.tree["linked-dir"]?.some((node) => node.path === "linked-dir/inside.txt")).toBe(true);
    expect(result.tree[""]?.find((node) => node.path === "ignored.txt")?.gitIgnored).toBe(true);
  });

  it("fails open when spawning Git throws", async () => {
    spawnMock.mockImplementationOnce(() => {
      throw new Error("spawn failed");
    });

    await expect(readGitIgnoredPaths("/repo", ["file.txt"])).resolves.toEqual(new Set());
  });

  it("fails open when the Git process emits an error", async () => {
    const child = new FakeGitChild();
    spawnMock.mockReturnValueOnce(child);
    queueMicrotask(() => child.emit("error", new Error("broken Git")));

    await expect(readGitIgnoredPaths("/repo", ["file.txt"])).resolves.toEqual(new Set());
  });

  it("fails open on timeout", async () => {
    const child = new FakeGitChild();
    spawnMock.mockReturnValueOnce(child);

    await expect(readGitIgnoredPaths("/repo", ["file.txt"], { timeoutMs: 5 })).resolves.toEqual(new Set());
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("fails open when Git exceeds the output budget", async () => {
    const child = mockGitResponse("file.txt\0");

    await expect(readGitIgnoredPaths("/repo", ["file.txt"], { maxOutputBytes: 4 })).resolves.toEqual(new Set());
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("fails open on stdin EPIPE", async () => {
    const child = new FakeGitChild();
    child.stdin.once("finish", () => child.stdin.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" })));
    spawnMock.mockReturnValueOnce(child);

    await expect(readGitIgnoredPaths("/repo", ["file.txt"])).resolves.toEqual(new Set());
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("fails open when stdout emits an error", async () => {
    const child = new FakeGitChild();
    child.stdin.once("finish", () => child.stdout.emit("error", new Error("stdout failed")));
    spawnMock.mockReturnValueOnce(child);

    await expect(readGitIgnoredPaths("/repo", ["file.txt"])).resolves.toEqual(new Set());
  });

  it("fails open when Git exits nonzero", async () => {
    mockGitResponse("file.txt\0", 1);

    await expect(readGitIgnoredPaths("/repo", ["file.txt"])).resolves.toEqual(new Set());
  });
});
