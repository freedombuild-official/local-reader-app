// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { AICommandRunner } from "../server/aiCliAdapters.js";
import {
  createClaudeAgentSdkSessionFactory,
  loadClaudeAgentSdkCatalog,
  normalizeClaudeAgentSdkModels,
  type ClaudeAgentSdkSession,
  type ClaudeAgentSdkQueryFunction,
} from "../server/claudeAgentSdkCatalog.js";

const FETCHED_AT = "2026-07-16T00:00:00.000Z";
const NATIVE_EXECUTION = {
  binary: "/opt/local/bin/claude",
  argvPrefix: [],
  identityPath: "/opt/local/bin/claude",
};
const NODE_EXECUTION = {
  binary: "/opt/local/bin/node",
  argvPrefix: ["/opt/local/lib/claude.js"],
  identityPath: "/opt/local/lib/claude.js",
};

function fakeSession(overrides: Partial<ClaudeAgentSdkSession> = {}): ClaudeAgentSdkSession {
  return {
    accountInfo: vi.fn(async () => ({ subscriptionType: "mock" })),
    supportedModels: vi.fn(async () => []),
    close: vi.fn(),
    ...overrides,
  };
}

describe("Claude Agent SDK catalog adapter", () => {
  it("loads account and every model through an injected session without launching Claude", async () => {
    const calls: string[] = [];
    const session = fakeSession({
      accountInfo: vi.fn(async () => {
        calls.push("accountInfo");
        return { subscriptionType: "mock" };
      }),
      supportedModels: vi.fn(async () => {
        calls.push("supportedModels");
        return [
          {
            value: "default",
            displayName: "Default model",
            description: "Claude Code default",
            supportedEffortLevels: ["low", "high", "ultra"],
          },
          {
            value: "haiku",
            displayName: "Haiku",
            description: "Fast model",
            supportedEffortLevels: [],
          },
        ];
      }),
      close: vi.fn(() => { calls.push("close"); }),
    });
    const sessionFactory = vi.fn(() => session);

    const catalog = await loadClaudeAgentSdkCatalog({
      execution: NATIVE_EXECUTION,
      cwd: "/tmp/reader-wiki",
      cliVersion: "2.1.0",
      fetchedAt: FETCHED_AT,
      sessionFactory,
    });

    expect(calls).toEqual(["accountInfo", "supportedModels", "close"]);
    expect(sessionFactory).toHaveBeenCalledOnce();
    expect(catalog).toMatchObject({
      entry: "claudeCli",
      cliVersion: "2.1.0",
      fetchedAt: FETCHED_AT,
      revision: expect.stringMatching(/^[a-f0-9]{64}$/u),
      models: [
        {
          id: "default",
          label: "Default model",
          isDefault: true,
          defaultEffort: "high",
          efforts: [
            { id: "low", label: "Low", isDefault: false },
            { id: "high", label: "High", isDefault: true },
            { id: "ultra", label: "Ultra", isDefault: false },
          ],
        },
        {
          id: "haiku",
          isDefault: false,
          defaultEffort: "default",
          efforts: [{ id: "default", label: "Default", isDefault: true }],
        },
      ],
    });
  });

  it("passes a metadata-only prompt and fixed safe SDK options to the production seam", async () => {
    const session = fakeSession();
    const invocations: Parameters<ClaudeAgentSdkQueryFunction>[0][] = [];
    const queryFunction: ClaudeAgentSdkQueryFunction = (params) => {
      invocations.push(params);
      return session;
    };
    const controller = new AbortController();
    const factory = createClaudeAgentSdkSessionFactory(queryFunction);

    expect(factory({
      execution: NATIVE_EXECUTION,
      cwd: "/tmp/reader-wiki",
      abortController: controller,
    })).toBe(session);

    const invocation = invocations[0];
    expect(invocation).toBeDefined();
    if (!invocation) throw new Error("Expected the SDK query seam to be invoked.");
    expect(invocation.options).toMatchObject({
      pathToClaudeCodeExecutable: "/opt/local/bin/claude",
      executableArgs: [],
      cwd: "/tmp/reader-wiki",
      env: expect.objectContaining({ READER_WIKI_AI_CLI: "1" }),
      settingSources: [],
      tools: [],
      permissionMode: "plan",
      mcpServers: {},
      strictMcpConfig: true,
      persistSession: false,
      abortController: controller,
    });
    expect(invocation.options.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(invocation.options.env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    controller.abort();
    await expect(invocation.prompt[Symbol.asyncIterator]().next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("uses the pinned interpreter and launcher prefix for a Node or custom-script execution descriptor", () => {
    const session = fakeSession();
    const invocations: Parameters<ClaudeAgentSdkQueryFunction>[0][] = [];
    const factory = createClaudeAgentSdkSessionFactory((params) => {
      invocations.push(params);
      return session;
    });

    expect(factory({
      execution: NODE_EXECUTION,
      cwd: "/tmp/reader-wiki",
      abortController: new AbortController(),
    })).toBe(session);
    expect(invocations[0]?.options).toMatchObject({
      pathToClaudeCodeExecutable: NODE_EXECUTION.binary,
      executableArgs: NODE_EXECUTION.argvPrefix,
    });
    expect(invocations[0]?.options.pathToClaudeCodeExecutable).not.toBe(NODE_EXECUTION.identityPath);
  });

  it("fails closed when the pinned binary name would be reinterpreted as a script by the SDK", async () => {
    const sessionFactory = vi.fn(() => fakeSession());

    await expect(loadClaudeAgentSdkCatalog({
      execution: { binary: "/opt/local/bin/runtime.js", argvPrefix: ["/opt/local/lib/claude"], identityPath: "/opt/local/lib/claude" },
      cwd: "/tmp/reader-wiki",
      cliVersion: "2.1.0",
      sessionFactory,
    })).rejects.toThrow(/must be a native executable path/u);
    expect(sessionFactory).not.toHaveBeenCalled();
  });

  it("runs the production SDK catalog inside a fixed app-owned worker boundary", async () => {
    const workerRunner = vi.fn<AICommandRunner>(async (_binary, _args, _options) => ({
      stdout: JSON.stringify({
        models: [{
          value: "sonnet",
          displayName: "Sonnet",
          description: "Balanced",
          supportedEffortLevels: ["high", "ultra"],
        }],
      }),
      stderr: "",
    }));

    const catalog = await loadClaudeAgentSdkCatalog({
      execution: NODE_EXECUTION,
      cwd: "/tmp/reader-wiki",
      cliVersion: "2.1.0",
      fetchedAt: FETCHED_AT,
      workerRunner,
      platform: "darwin",
    });

    expect(catalog).toMatchObject({ entry: "claudeCli", models: [{ id: "sonnet", defaultEffort: "high" }] });
    expect(workerRunner).toHaveBeenCalledOnce();
    const [binary, args, options] = workerRunner.mock.calls[0]!;
    expect(binary).toBe(process.execPath);
    expect(args.at(-1)).toMatch(/claudeAgentSdkCatalogWorker\.(?:ts|js)$/u);
    expect(args).not.toContain("/opt/local/bin/claude");
    expect(JSON.parse(options.input || "{}")).toEqual({
      execution: NODE_EXECUTION,
      cwd: "/tmp/reader-wiki",
    });
    expect(options).toMatchObject({ cwd: "/tmp/reader-wiki", timeoutMs: 20_000, maxBuffer: 512 * 1_024 });
    expect(options.env).toMatchObject({ READER_WIKI_AI_CLI: "1" });
    expect(options.env).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("fails closed before launching an SDK worker on Windows", async () => {
    const workerRunner = vi.fn<AICommandRunner>();

    await expect(loadClaudeAgentSdkCatalog({
      execution: { binary: "/mock/claude.exe", argvPrefix: [], identityPath: "/mock/claude.exe" },
      cwd: "/mock/reader-wiki",
      cliVersion: "2.1.0",
      workerRunner,
      platform: "win32",
    })).rejects.toMatchObject({ status: 503 });
    expect(workerRunner).not.toHaveBeenCalled();
  });

  it("closes the injected session when metadata loading fails", async () => {
    const failure = new Error("mock account failure");
    const close = vi.fn();
    const session = fakeSession({
      accountInfo: vi.fn(async () => { throw failure; }),
      close,
    });

    await expect(loadClaudeAgentSdkCatalog({
      execution: NATIVE_EXECUTION,
      cwd: "/tmp/reader-wiki",
      cliVersion: "2.1.0",
      sessionFactory: () => session,
    })).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce();
  });

  it("aborts and closes a session even when metadata loading does not settle", async () => {
    const controller = new AbortController();
    const close = vi.fn();
    const session = fakeSession({
      accountInfo: vi.fn(() => new Promise(() => undefined)),
      close,
    });
    const loading = loadClaudeAgentSdkCatalog({
      execution: NATIVE_EXECUTION,
      cwd: "/tmp/reader-wiki",
      cliVersion: "2.1.0",
      abortController: controller,
      sessionFactory: () => session,
    });

    controller.abort();

    await expect(loading).rejects.toMatchObject({ name: "AbortError" });
    expect(close).toHaveBeenCalledOnce();
    expect(session.supportedModels).not.toHaveBeenCalled();
  });

  it("creates a stable revision independent of fetch time and preserves unknown efforts", () => {
    const input = {
      cliVersion: "2.1.0",
      models: [{
        value: "sonnet",
        displayName: "Sonnet",
        description: "Balanced model",
        supportedEffortLevels: ["medium", "max", "future-depth"],
      }],
    };
    const first = normalizeClaudeAgentSdkModels({ ...input, fetchedAt: FETCHED_AT });
    const second = normalizeClaudeAgentSdkModels({ ...input, fetchedAt: "2026-07-16T01:00:00.000Z" });

    expect(first.revision).toBe(second.revision);
    expect(first.models[0]).toMatchObject({
      isDefault: true,
      defaultEffort: "medium",
      efforts: [
        { id: "medium" },
        { id: "max" },
        { id: "future-depth" },
      ],
    });
    expect(first.models[0].efforts.some((effort) => effort.id === "default")).toBe(false);
  });

  it.each([
    {
      name: "duplicate models",
      models: [
        { value: "sonnet", displayName: "Sonnet", description: "A" },
        { value: "sonnet", displayName: "Sonnet copy", description: "B" },
      ],
      message: /duplicate model sonnet/u,
    },
    {
      name: "duplicate efforts",
      models: [{ value: "sonnet", displayName: "Sonnet", description: "A", supportedEffortLevels: ["high", "high"] }],
      message: /duplicate effort high/u,
    },
    {
      name: "control characters",
      models: [{ value: "sonnet\nunsafe", displayName: "Sonnet", description: "A" }],
      message: /control characters/u,
    },
    {
      name: "empty catalogs",
      models: [],
      message: /returned no models/u,
    },
  ])("rejects $name", ({ models, message }) => {
    expect(() => normalizeClaudeAgentSdkModels({
      cliVersion: "2.1.0",
      fetchedAt: FETCHED_AT,
      models,
    })).toThrow(message);
  });
});
