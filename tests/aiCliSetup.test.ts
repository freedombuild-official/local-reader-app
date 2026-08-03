// @vitest-environment node

import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AiCliSetupError,
  AiCliSetupService,
  codexCatalogToAiCli,
  createClaudeAiCliSetupProvider as createClaudeAiCliSetupProviderBase,
  createCodexAiCliSetupProvider as createCodexAiCliSetupProviderBase,
  createDefaultAiCliSetupService as createDefaultAiCliSetupServiceBase,
  inspectManagedAiCliExecutable,
  parseClaudeAuthenticationStatus,
  sameManagedRuntimeIdentity,
  type AiCliManagedRuntimeIdentity,
  type AiCliUnmanagedRuntimeIdentity,
  type AiCliProviderEvent,
  type AiCliProviderInspection,
  type AiCliSetupProvider,
  type ResolvedAiCliExecutable,
} from "../server/aiCliSetup.js";
import { JsonRpcRemoteError, type CodexAppServerConnection } from "../server/codexAppServerClient.js";
import type { CodexModelCatalog } from "../server/aiCliCatalog.js";
import type { AICommandOptions } from "../server/aiCliAdapters.js";
import type { LoadClaudeAgentSdkCatalogOptions } from "../server/claudeAgentSdkCatalog.js";
import { HttpError } from "../server/errors.js";
import type { AICliEntryKind, AICliModelCatalog } from "../server/types.js";

const NOW = "2026-07-16T00:00:00.000Z";
// Most provider tests exercise the supported POSIX path; the dedicated win32 case overrides this default.
const TEST_AI_CLI_PLATFORM: NodeJS.Platform = process.platform === "win32" ? "linux" : process.platform;

function createCodexAiCliSetupProvider(
  packageRoot: string,
  dependencies: Parameters<typeof createCodexAiCliSetupProviderBase>[1] = {},
): ReturnType<typeof createCodexAiCliSetupProviderBase> {
  return createCodexAiCliSetupProviderBase(packageRoot, { platform: TEST_AI_CLI_PLATFORM, ...dependencies });
}

function createClaudeAiCliSetupProvider(
  packageRoot: string,
  dependencies: Parameters<typeof createClaudeAiCliSetupProviderBase>[1] = {},
): ReturnType<typeof createClaudeAiCliSetupProviderBase> {
  return createClaudeAiCliSetupProviderBase(packageRoot, { platform: TEST_AI_CLI_PLATFORM, ...dependencies });
}

function createDefaultAiCliSetupService(
  packageRoot: string,
  dependencies: Parameters<typeof createDefaultAiCliSetupServiceBase>[1] = {},
): ReturnType<typeof createDefaultAiCliSetupServiceBase> {
  return createDefaultAiCliSetupServiceBase(packageRoot, { platform: TEST_AI_CLI_PLATFORM, ...dependencies });
}

function mockManagedIdentity(
  entry: AICliEntryKind,
  executable: ResolvedAiCliExecutable,
  sha256 = "a".repeat(64),
): AiCliManagedRuntimeIdentity {
  return {
    entry,
    layout: entry === "codexCli" ? "codexNpm" : "claudeNpmNative",
    execution: structuredClone(executable),
    members: [{
      role: "launcher",
      file: { path: executable.identityPath, dev: "1", ino: "2", size: 100, mtimeMs: 1, sha256 },
    }],
  };
}

function mockUnmanagedIdentity(
  entry: AICliEntryKind,
  executable: ResolvedAiCliExecutable,
  sha256 = "a".repeat(64),
): AiCliUnmanagedRuntimeIdentity {
  return {
    entry,
    layout: "customNative",
    execution: structuredClone(executable),
    members: [{
      role: "launcher",
      file: { path: executable.identityPath, dev: "1", ino: "2", size: 100, mtimeMs: 1, sha256 },
    }],
  };
}

function nativeHeader(suffix: string): Buffer {
  const magic = process.platform === "darwin"
    ? Buffer.from("cffaedfe", "hex")
    : process.platform === "linux"
      ? Buffer.from([0x7f, 0x45, 0x4c, 0x46])
      : Buffer.from([0x4d, 0x5a]);
  return Buffer.concat([magic, Buffer.from(suffix)]);
}

async function createClaudeNpmFixture(suffix = "one"): Promise<{ root: string; executable: ResolvedAiCliExecutable }> {
  const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-claude-layout-"));
  const packageRoot = path.join(root, "node_modules", "@anthropic-ai", "claude-code");
  const launcher = path.join(packageRoot, "bin", "claude.exe");
  await mkdir(path.dirname(launcher), { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
    name: "@anthropic-ai/claude-code",
    version: "2.1.207",
    bin: { claude: "bin/claude.exe" },
  }));
  await writeFile(launcher, nativeHeader(suffix));
  await chmod(launcher, 0o755);
  return { root, executable: { binary: launcher, argvPrefix: [], identityPath: launcher } };
}

async function createCodexNpmFixture(): Promise<{ root: string; executable: ResolvedAiCliExecutable } | null> {
  const targets: Record<string, { dependency: string; suffix: string; triple: string; executable: string; os: string; cpu: string }> = {
    "darwin:arm64": { dependency: "codex-darwin-arm64", suffix: "darwin-arm64", triple: "aarch64-apple-darwin", executable: "codex", os: "darwin", cpu: "arm64" },
    "darwin:x64": { dependency: "codex-darwin-x64", suffix: "darwin-x64", triple: "x86_64-apple-darwin", executable: "codex", os: "darwin", cpu: "x64" },
    "linux:arm64": { dependency: "codex-linux-arm64", suffix: "linux-arm64", triple: "aarch64-unknown-linux-musl", executable: "codex", os: "linux", cpu: "arm64" },
    "linux:x64": { dependency: "codex-linux-x64", suffix: "linux-x64", triple: "x86_64-unknown-linux-musl", executable: "codex", os: "linux", cpu: "x64" },
    "win32:arm64": { dependency: "codex-win32-arm64", suffix: "win32-arm64", triple: "aarch64-pc-windows-msvc", executable: "codex.exe", os: "win32", cpu: "arm64" },
    "win32:x64": { dependency: "codex-win32-x64", suffix: "win32-x64", triple: "x86_64-pc-windows-msvc", executable: "codex.exe", os: "win32", cpu: "x64" },
  };
  const target = targets[`${process.platform}:${process.arch}`];
  if (!target) return null;
  const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-codex-layout-"));
  const packageRoot = path.join(root, "node_modules", "@openai", "codex");
  const launcher = path.join(packageRoot, "bin", "codex.js");
  const platformRoot = path.join(packageRoot, "node_modules", "@openai", target.dependency);
  const vendorRoot = path.join(platformRoot, "vendor", target.triple);
  const payload = path.join(vendorRoot, "bin", target.executable);
  await mkdir(path.dirname(launcher), { recursive: true });
  await mkdir(path.dirname(payload), { recursive: true });
  await writeFile(launcher, "#!/usr/bin/env node\n");
  await chmod(launcher, 0o755);
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
    name: "@openai/codex",
    version: "1.2.3",
    type: "module",
    bin: { codex: "bin/codex.js" },
    optionalDependencies: { [`@openai/${target.dependency}`]: `npm:@openai/codex@1.2.3-${target.suffix}` },
  }));
  await writeFile(path.join(platformRoot, "package.json"), JSON.stringify({
    name: "@openai/codex",
    version: `1.2.3-${target.suffix}`,
    os: [target.os],
    cpu: [target.cpu],
  }));
  await writeFile(path.join(vendorRoot, "codex-package.json"), JSON.stringify({
    layoutVersion: 1,
    version: "1.2.3",
    target: target.triple,
    variant: "codex",
    entrypoint: `bin/${target.executable}`,
  }));
  await writeFile(payload, nativeHeader("codex-payload"));
  await chmod(payload, 0o755);
  return { root, executable: { binary: launcher, argvPrefix: [], identityPath: launcher } };
}

function catalog(entry: AICliEntryKind, revision = `${entry}-r1`): AICliModelCatalog {
  return {
    entry,
    cliVersion: "1.2.3",
    revision,
    fetchedAt: NOW,
    models: [{
      id: entry === "codexCli" ? "gpt-future" : "claude-future",
      label: "Future model",
      description: null,
      isDefault: true,
      defaultEffort: "max",
      efforts: [
        { id: "max", label: "Max", description: null, isDefault: true },
        { id: "future-depth", label: "Future Depth", description: null, isDefault: false },
      ],
      defaultSpeedMode: "standard",
      speedModes: [
        { id: "standard", label: "Standard", description: null, isDefault: true },
        { id: "fast", label: "Fast", description: null, isDefault: false },
      ],
    }],
  };
}

function readyInspection(entry: AICliEntryKind, revision = `${entry}-r1`): AiCliProviderInspection {
  return {
    installed: true,
    cliVersion: "1.2.3",
    managed: true,
    compatibility: "compatible",
    authenticated: true,
    message: "ready",
    catalog: catalog(entry, revision),
    ...(entry === "claudeCli" ? { foundationOnly: true } : {}),
  };
}

class FakeProvider implements AiCliSetupProvider {
  readonly inspect = vi.fn<(signal: AbortSignal) => Promise<AiCliProviderInspection>>();
  readonly currentVersion = vi.fn(async (_signal?: AbortSignal) => "1.2.3");
  readonly currentExecution = vi.fn(async (signal: AbortSignal) => ({
    version: await this.currentVersion(signal),
    executable: {
      binary: this.entry === "codexCli" ? "codex" : "claude",
      argvPrefix: [],
      identityPath: this.entry === "codexCli" ? "/mock/bin/codex" : "/mock/bin/claude",
    },
  }));
  readonly startAuthentication = vi.fn(async () => ({ state: "waiting" as const, verificationUrl: "https://example.test/login", userCode: "ABCD", message: "waiting" }));
  readonly cancelAuthentication = vi.fn(async () => undefined);
  readonly update = vi.fn(async () => undefined);
  readonly shutdown = vi.fn(async () => undefined);
  private listener: ((event: AiCliProviderEvent) => void) | undefined;

  constructor(readonly entry: AICliEntryKind, inspections: AiCliProviderInspection[]) {
    let index = 0;
    this.inspect.mockImplementation(async () => inspections[Math.min(index++, inspections.length - 1)]!);
  }

  setEventListener(listener: (event: AiCliProviderEvent) => void): void {
    this.listener = listener;
  }

  emit(event: AiCliProviderEvent): void {
    this.listener?.(event);
  }
}

function serviceWith(
  codex: FakeProvider,
  claude = new FakeProvider("claudeCli", [readyInspection("claudeCli")]),
  options: { now?: () => Date; randomNonce?: () => string; nonceTtlMs?: number } = {},
): AiCliSetupService {
  return new AiCliSetupService({
    providers: { codexCli: codex, claudeCli: claude },
    ...options,
  });
}

function mockCodexConnection(
  requestImplementation: (method: string, params?: unknown) => Promise<unknown>,
): {
  connection: CodexAppServerConnection;
  client: EventEmitter & {
    request: ReturnType<typeof vi.fn>;
    notify: ReturnType<typeof vi.fn>;
    respondError: ReturnType<typeof vi.fn>;
  };
} {
  const client = new EventEmitter() as EventEmitter & {
    request: ReturnType<typeof vi.fn>;
    notify: ReturnType<typeof vi.fn>;
    respondError: ReturnType<typeof vi.fn>;
  };
  client.request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "initialize") return {};
    return requestImplementation(method, params);
  });
  client.notify = vi.fn();
  client.respondError = vi.fn();
  return {
    client,
    connection: {
      client,
      shutdown: vi.fn(async () => undefined),
      child: {} as CodexAppServerConnection["child"],
      exited: Promise.resolve({ code: 0, signal: null }),
    } as unknown as CodexAppServerConnection,
  };
}

function codexProviderDependencies(
  connection: CodexAppServerConnection,
  managed: boolean,
  overrides: Parameters<typeof createCodexAiCliSetupProvider>[1] = {},
): Parameters<typeof createCodexAiCliSetupProvider>[1] {
  const executable: ResolvedAiCliExecutable = {
    binary: "/mock/bin/codex",
    argvPrefix: [],
    identityPath: "/mock/bin/codex",
  };
  return {
    runner: vi.fn(async (_binary: string, args: string[]) => args.includes("--version")
      ? { stdout: "codex-cli 1.2.3\n", stderr: "" }
      : { stdout: "Codex app-server help\n", stderr: "" }),
    locateExecutable: vi.fn(async () => executable),
    inspectManagedExecutable: vi.fn(async () => managed ? mockManagedIdentity("codexCli", executable) : null),
    inspectUnmanagedExecutable: vi.fn(async (_entry, current) => mockUnmanagedIdentity("codexCli", current)),
    spawnCodexConnection: vi.fn(() => connection),
    loadCodexCatalog: vi.fn(async () => ({
      cliVersion: "codex-cli 1.2.3",
      revision: "codex-test",
      fetchedAt: NOW,
      models: [],
    })),
    now: () => new Date(NOW),
    ...overrides,
  };
}

describe("AiCliSetupService", () => {
  it("moves from idle to ready and fails closed for stale or unavailable selections", async () => {
    const codex = new FakeProvider("codexCli", [readyInspection("codexCli")]);
    const service = serviceWith(codex);

    expect(service.getSnapshots().codexCli.phase).toBe("idle");
    expect(codex.inspect).not.toHaveBeenCalled();
    const snapshot = await service.inspect("codexCli");
    expect(snapshot).toMatchObject({ phase: "ready", cliVersion: "1.2.3", catalog: { revision: "codexCli-r1" } });
    expect(snapshot.catalog?.models[0]?.efforts.map((effort) => effort.id)).toEqual(["max", "future-depth"]);

    expect(service.validateSelection("codexCli", {
      model: "gpt-future",
      effort: "future-depth",
      speedMode: "standard",
      catalogRevision: "codexCli-r1",
      setupGeneration: 1,
    })).toEqual({ model: "gpt-future", effort: "future-depth", speedMode: "standard", catalogRevision: "codexCli-r1", setupGeneration: 1 });
    expect(() => service.validateSelection("codexCli", {
      model: "gpt-future",
      effort: "future-depth",
      speedMode: "standard",
      catalogRevision: "stale",
      setupGeneration: 1,
    })).toThrowError(expect.objectContaining({ code: "invalidSelection" }));
    expect(() => service.validateSelection("codexCli", {
      model: "unknown",
      effort: "max",
      speedMode: "standard",
      catalogRevision: "codexCli-r1",
      setupGeneration: 1,
    })).toThrowError(expect.objectContaining({ code: "invalidSelection" }));
    expect(() => service.validateSelection("codexCli", {
      model: "gpt-future",
      effort: "max",
      speedMode: "fast",
      catalogRevision: "codexCli-r1",
      setupGeneration: 1,
    })).not.toThrow();
    expect(() => service.validateSelection("codexCli", {
      model: "gpt-future",
      effort: "max",
      speedMode: "turbo" as never,
      catalogRevision: "codexCli-r1",
      setupGeneration: 1,
    })).toThrowError(expect.objectContaining({ code: "invalidSelection" }));

    const refreshed = await service.inspect("codexCli");
    expect(refreshed).toMatchObject({ setupGeneration: 2, catalog: { revision: "codexCli-r1" } });
    expect(() => service.validateSelection("codexCli", {
      model: "gpt-future",
      effort: "future-depth",
      speedMode: "standard",
      catalogRevision: "codexCli-r1",
      setupGeneration: 1,
    })).toThrowError(expect.objectContaining({ code: "invalidSelection" }));
  });

  it("invalidates a ready catalog when the executable reports a different version", async () => {
    const codex = new FakeProvider("codexCli", [readyInspection("codexCli")]);
    codex.currentVersion.mockResolvedValue("1.2.4");
    const service = serviceWith(codex);
    await service.inspect("codexCli");

    await expect(service.assertCurrentVersion("codexCli", {
      model: "gpt-future",
      effort: "max",
      speedMode: "standard",
      catalogRevision: "codexCli-r1",
      setupGeneration: 1,
    }, new AbortController().signal)).rejects.toMatchObject({ code: "invalidSelection" });
    expect(service.getSnapshots().codexCli).toMatchObject({ phase: "failed", failureReason: "cliVersionChanged" });
    expect(service.getSnapshots().codexCli.catalog).toBeUndefined();
  });

  it("uses a short-lived one-time nonce and re-inspects after a confirmed managed update", async () => {
    const updateRequired: AiCliProviderInspection = {
      installed: true,
      cliVersion: "0.1.0",
      managed: true,
      compatibility: "updateRequired",
      authenticated: false,
      message: "update required",
    };
    const codex = new FakeProvider("codexCli", [updateRequired, readyInspection("codexCli", "codexCli-r2")]);
    const service = serviceWith(codex, undefined, { randomNonce: () => "nonce-1", now: () => new Date(NOW) });

    await service.inspect("codexCli");
    const inspectedGeneration = service.getSetupGeneration("codexCli");
    const prepared = service.prepareUpdate("codexCli");
    expect(prepared.update).toMatchObject({ state: "confirmationRequired", nonce: "nonce-1" });
    expect(prepared.setupGeneration).toBeGreaterThan(inspectedGeneration);
    expect(prepared.setupGeneration).toBe(service.getSetupGeneration("codexCli"));
    await expect(service.confirmUpdate("codexCli", "wrong")).rejects.toMatchObject({ code: "confirmationInvalid" });
    const completed = await service.confirmUpdate("codexCli", "nonce-1");
    expect(codex.update).toHaveBeenCalledOnce();
    expect(codex.inspect).toHaveBeenCalledTimes(2);
    expect(completed).toMatchObject({ phase: "ready", update: { state: "succeeded" }, catalog: { revision: "codexCli-r2" } });
    await expect(service.confirmUpdate("codexCli", "nonce-1")).rejects.toBeInstanceOf(AiCliSetupError);
  });

  it("uses a distinct confirmation for an explicit latest-release check on a compatible managed CLI", async () => {
    const codex = new FakeProvider("codexCli", [
      readyInspection("codexCli", "codexCli-r1"),
      readyInspection("codexCli", "codexCli-r2"),
    ]);
    const service = serviceWith(codex, undefined, { randomNonce: () => "latest-nonce", now: () => new Date(NOW) });

    const inspected = await service.inspect("codexCli");
    expect(inspected).toMatchObject({
      phase: "ready",
      compatibility: "compatible",
      managedUpdateSupported: true,
    });
    const prepared = service.prepareUpdate("codexCli");
    expect(prepared).toMatchObject({
      phase: "ready",
      update: { state: "confirmationRequired", kind: "latest", nonce: "latest-nonce" },
    });
    expect(() => service.validateSelection("codexCli", {
      model: "gpt-future",
      effort: "max",
      speedMode: "standard",
      catalogRevision: "codexCli-r1",
      setupGeneration: prepared.setupGeneration,
    })).toThrowError(expect.objectContaining({ code: "invalidSelection" }));

    const completed = await service.confirmUpdate("codexCli", "latest-nonce");
    expect(codex.update).toHaveBeenCalledOnce();
    expect(codex.inspect).toHaveBeenCalledTimes(2);
    expect(completed).toMatchObject({
      phase: "ready",
      compatibility: "compatible",
      update: { state: "succeeded", kind: "latest" },
      catalog: { revision: "codexCli-r2" },
    });
  });

  it("rejects latest-release checks for unmanaged CLIs and fails closed after an updater error", async () => {
    const unmanaged = new FakeProvider("codexCli", [{ ...readyInspection("codexCli"), managed: false }]);
    const unmanagedService = serviceWith(unmanaged);
    const unmanagedSnapshot = await unmanagedService.inspect("codexCli");
    expect(unmanagedSnapshot.managedUpdateSupported).toBe(false);
    expect(() => unmanagedService.prepareUpdate("codexCli")).toThrowError(expect.objectContaining({ code: "updateNotAllowed" }));

    const managed = new FakeProvider("codexCli", [readyInspection("codexCli")]);
    managed.update.mockRejectedValueOnce(new Error("registry unavailable"));
    const managedService = serviceWith(managed, undefined, { randomNonce: () => "latest-failure", now: () => new Date(NOW) });
    await managedService.inspect("codexCli");
    managedService.prepareUpdate("codexCli");
    const failed = await managedService.confirmUpdate("codexCli", "latest-failure");
    expect(failed).toMatchObject({
      phase: "failed",
      compatibility: "unknown",
      failureReason: "updateFailed",
      update: { state: "failed", kind: "latest", message: "The CLI operation failed. Inspect the CLI and try again." },
    });
    expect(failed.catalog).toBeUndefined();
  });

  it("does not restore a stale catalog when authentication changes during post-update inspection", async () => {
    const updateRequired: AiCliProviderInspection = {
      installed: true,
      cliVersion: "0.1.0",
      managed: true,
      compatibility: "updateRequired",
      authenticated: false,
      message: "update required",
    };
    let releaseInspection!: (inspection: AiCliProviderInspection) => void;
    let markInspectionStarted!: () => void;
    const inspectionStarted = new Promise<void>((resolve) => { markInspectionStarted = resolve; });
    const codex = new FakeProvider("codexCli", [updateRequired]);
    let inspectionCalls = 0;
    codex.inspect.mockImplementation(async () => {
      inspectionCalls += 1;
      if (inspectionCalls === 1) return updateRequired;
      markInspectionStarted();
      return new Promise<AiCliProviderInspection>((resolve) => { releaseInspection = resolve; });
    });
    const service = serviceWith(codex, undefined, { randomNonce: () => "nonce-auth-race", now: () => new Date(NOW) });
    await service.inspect("codexCli");
    service.prepareUpdate("codexCli");

    const update = service.confirmUpdate("codexCli", "nonce-auth-race");
    await inspectionStarted;
    codex.emit({ type: "authenticationInvalidated", message: "Authentication changed during update inspection." });
    releaseInspection(readyInspection("codexCli", "stale-post-update"));

    await expect(update).resolves.toMatchObject({
      phase: "loginRequired",
      failureReason: "authenticationChanged",
    });
    expect(service.getSnapshots().codexCli.catalog).toBeUndefined();
  });

  it("expires update confirmations without invoking the provider and rejects unmanaged updates", async () => {
    let clock = Date.parse(NOW);
    const updateRequired: AiCliProviderInspection = {
      installed: true,
      cliVersion: "0.1.0",
      managed: true,
      compatibility: "updateRequired",
      authenticated: false,
      message: "update required",
    };
    const codex = new FakeProvider("codexCli", [updateRequired]);
    const service = serviceWith(codex, undefined, {
      randomNonce: () => "nonce-expiring",
      now: () => new Date(clock),
      nonceTtlMs: 1_000,
    });
    await service.inspect("codexCli");
    const prepared = service.prepareUpdate("codexCli");
    clock += 1_000;
    await expect(service.confirmUpdate("codexCli", "nonce-expiring")).rejects.toMatchObject({ code: "confirmationExpired" });
    expect(service.getSetupGeneration("codexCli")).toBeGreaterThan(prepared.setupGeneration);
    expect(service.getSnapshots().codexCli.setupGeneration).toBe(service.getSetupGeneration("codexCli"));
    expect(codex.update).not.toHaveBeenCalled();

    const unmanaged = new FakeProvider("codexCli", [{ ...updateRequired, managed: false }]);
    const unmanagedService = serviceWith(unmanaged);
    const unmanagedSnapshot = await unmanagedService.inspect("codexCli");
    expect(unmanagedSnapshot.phase).toBe("updateRequired");
    expect(() => unmanagedService.prepareUpdate("codexCli")).toThrowError(expect.objectContaining({ code: "updateNotAllowed" }));
  });

  it("enforces a single operation, aborts it during shutdown, and shuts every provider down once", async () => {
    let release!: (value: AiCliProviderInspection) => void;
    let observedSignal: AbortSignal | undefined;
    const codex = new FakeProvider("codexCli", [readyInspection("codexCli")]);
    codex.inspect.mockImplementation((signal) => {
      observedSignal = signal;
      return new Promise<AiCliProviderInspection>((resolve) => { release = resolve; });
    });
    const claude = new FakeProvider("claudeCli", [readyInspection("claudeCli")]);
    const service = serviceWith(codex, claude);
    const inspection = service.inspect("codexCli");
    expect(service.isBusy()).toBe(true);
    await expect(service.inspect("claudeCli")).rejects.toMatchObject({ code: "busy" });

    const shutdown = service.shutdown();
    expect(observedSignal?.aborted).toBe(true);
    release(readyInspection("codexCli"));
    await inspection;
    await shutdown;
    expect(codex.shutdown).toHaveBeenCalledOnce();
    expect(claude.shutdown).toHaveBeenCalledOnce();
    expect(service.getSnapshots().codexCli.phase).toBe("unavailable");
    await expect(service.inspect("codexCli")).rejects.toMatchObject({ code: "shuttingDown" });
  });

  it("attempts every provider shutdown and propagates cleanup failures", async () => {
    const failure = new Error("process group remained alive");
    const codex = new FakeProvider("codexCli", [readyInspection("codexCli")]);
    const claude = new FakeProvider("claudeCli", [readyInspection("claudeCli")]);
    codex.shutdown.mockRejectedValue(failure);
    const service = serviceWith(codex, claude);

    await expect(service.shutdown()).rejects.toBe(failure);

    expect(codex.shutdown).toHaveBeenCalledOnce();
    expect(claude.shutdown).toHaveBeenCalledOnce();
    expect(service.getSnapshots()).toMatchObject({
      codexCli: { phase: "unavailable" },
      claudeCli: { phase: "unavailable" },
    });
  });

  it("tracks authentication waiting/cancel states without issuing model calls", async () => {
    const loginRequired: AiCliProviderInspection = {
      installed: true,
      cliVersion: "1.2.3",
      managed: true,
      compatibility: "compatible",
      authenticated: false,
      message: "login required",
    };
    const codex = new FakeProvider("codexCli", [loginRequired]);
    const service = serviceWith(codex);
    await service.inspect("codexCli");
    const waiting = await service.startAuthentication("codexCli");
    expect(waiting).toMatchObject({
      phase: "authenticating",
      authentication: { state: "waiting", verificationUrl: "https://example.test/login", userCode: "ABCD" },
    });
    expect(waiting.setupGeneration).toBe(service.getSetupGeneration("codexCli"));
    expect(service.isBusy()).toBe(true);
    await expect(service.inspect("claudeCli")).rejects.toMatchObject({ code: "busy" });
    const canceled = await service.cancelAuthentication("codexCli");
    expect(canceled).toMatchObject({ phase: "loginRequired", authentication: { state: "idle" } });
    expect(canceled.setupGeneration).toBe(service.getSetupGeneration("codexCli"));
    expect(codex.cancelAuthentication).toHaveBeenCalledOnce();
    expect(service.isBusy()).toBe(false);
  });

  it("revalidates the inspected executable lease before starting authentication", async () => {
    const loginRequired: AiCliProviderInspection = {
      installed: true,
      cliVersion: "1.2.3",
      managed: true,
      compatibility: "compatible",
      authenticated: false,
      message: "login required",
    };
    const codex = new FakeProvider("codexCli", [loginRequired]);
    const service = serviceWith(codex);
    await service.inspect("codexCli");
    codex.currentExecution.mockRejectedValue(new Error("managed payload changed"));

    await expect(service.startAuthentication("codexCli")).rejects.toMatchObject({ code: "invalidSelection" });
    expect(codex.startAuthentication).not.toHaveBeenCalled();
    expect(service.getSnapshots().codexCli).toMatchObject({ phase: "failed", failureReason: "cliVersionChanged" });
  });

  it("refreshes one provider catalog while another provider authentication is waiting", async () => {
    const loginRequired: AiCliProviderInspection = {
      installed: true,
      cliVersion: "1.2.3",
      managed: true,
      compatibility: "compatible",
      authenticated: false,
      message: "login required",
    };
    const codex = new FakeProvider("codexCli", [loginRequired]);
    const claude = new FakeProvider("claudeCli", [loginRequired, readyInspection("claudeCli")]);
    const service = serviceWith(codex, claude);
    await service.inspect("codexCli");
    await service.inspect("claudeCli");
    await service.startAuthentication("codexCli");

    claude.emit({ type: "authenticationSucceeded", message: "Claude sign-in completed externally." });

    await vi.waitFor(() => expect(service.getSnapshots().claudeCli.phase).toBe("ready"));
    expect(service.getSnapshots().codexCli.phase).toBe("authenticating");
    expect(claude.inspect).toHaveBeenCalledTimes(2);
    await service.cancelAuthentication("codexCli");
    expect(service.getSnapshots().codexCli.phase).toBe("loginRequired");
  });

  it("serializes simultaneous provider catalog refresh events without dropping either pending refresh", async () => {
    const loginRequired: AiCliProviderInspection = {
      installed: true,
      cliVersion: "1.2.3",
      managed: true,
      compatibility: "compatible",
      authenticated: false,
      message: "login required",
    };
    const codex = new FakeProvider("codexCli", [loginRequired, readyInspection("codexCli")]);
    const claude = new FakeProvider("claudeCli", [loginRequired, readyInspection("claudeCli")]);
    const service = serviceWith(codex, claude);
    await service.inspect("codexCli");
    await service.inspect("claudeCli");

    claude.emit({ type: "authenticationSucceeded", message: "Claude signed in." });
    codex.emit({ type: "authenticationSucceeded", message: "Codex signed in." });

    await vi.waitFor(() => expect(service.getSnapshots()).toMatchObject({
      codexCli: { phase: "ready" },
      claudeCli: { phase: "ready" },
    }));
    expect(codex.inspect).toHaveBeenCalledTimes(2);
    expect(claude.inspect).toHaveBeenCalledTimes(2);
  });

  it("propagates an unverified process-tree failure while canceling authentication", async () => {
    const loginRequired: AiCliProviderInspection = {
      installed: true,
      cliVersion: "1.2.3",
      managed: true,
      compatibility: "compatible",
      authenticated: false,
      message: "login required",
    };
    const failure = new HttpError(502, "process tree unverified", { processTreeUnverified: true });
    const codex = new FakeProvider("codexCli", [loginRequired]);
    codex.cancelAuthentication.mockRejectedValue(failure);
    const service = serviceWith(codex);
    await service.inspect("codexCli");
    await service.startAuthentication("codexCli");

    await expect(service.cancelAuthentication("codexCli")).rejects.toBe(failure);
    expect(service.getSnapshots().codexCli).toMatchObject({
      phase: "unavailable",
      authentication: { state: "failed" },
      failureReason: "processTreeUnverified",
    });
    expect(service.isBusy()).toBe(true);
    await expect(service.cancelAuthentication("codexCli")).rejects.toBe(failure);
    await expect(service.inspect("claudeCli")).rejects.toBe(failure);
    expect(codex.cancelAuthentication).toHaveBeenCalledOnce();
    await expect(service.shutdown()).rejects.toBe(failure);
  });

  it("prioritizes a retained fatal provider event even when the active operation resolves", async () => {
    const loginRequired: AiCliProviderInspection = {
      installed: true,
      cliVersion: "1.2.3",
      managed: true,
      compatibility: "compatible",
      authenticated: false,
      message: "login required",
    };
    const failure = new HttpError(502, "process tree unverified", { processTreeUnverified: true });
    const codex = new FakeProvider("codexCli", [loginRequired]);
    const claude = new FakeProvider("claudeCli", [readyInspection("claudeCli")]);
    codex.cancelAuthentication.mockImplementation(async () => {
      codex.emit({ type: "processTreeUnverified", error: failure });
    });
    const service = serviceWith(codex, claude);
    await service.inspect("codexCli");
    await service.startAuthentication("codexCli");

    await expect(service.cancelAuthentication("codexCli")).rejects.toBe(failure);
    expect(service.getSnapshots()).toMatchObject({
      codexCli: { phase: "unavailable", failureReason: "processTreeUnverified" },
      claudeCli: { phase: "unavailable", failureReason: "processTreeUnverified" },
    });
    await expect(service.shutdown()).rejects.toBe(failure);
  });

  it("notifies active observers immediately when any setup process tree becomes unverified", async () => {
    const service = serviceWith(new FakeProvider("codexCli", [readyInspection("codexCli")]));
    const activeObserver = vi.fn();
    const removedObserver = vi.fn();
    service.onUnverifiedProcessTree(activeObserver);
    const unsubscribe = service.onUnverifiedProcessTree(removedObserver);
    unsubscribe();
    const failure = new HttpError(502, "process tree unverified", { processTreeUnverified: true });

    service.reportUnverifiedProcessTree("codexCli", failure);

    expect(activeObserver).toHaveBeenCalledOnce();
    expect(removedObserver).not.toHaveBeenCalled();
    const lateObserver = vi.fn();
    service.onUnverifiedProcessTree(lateObserver);
    expect(lateObserver).toHaveBeenCalledOnce();
    await expect(service.shutdown()).rejects.toBe(failure);
  });

  it("aborts active setup, stops both providers, and invalidates both catalogs after a fatal process-tree failure", async () => {
    const codex = new FakeProvider("codexCli", [readyInspection("codexCli")]);
    const claude = new FakeProvider("claudeCli", [readyInspection("claudeCli")]);
    let observedSignal: AbortSignal | undefined;
    let markInspectionStarted!: () => void;
    const inspectionStarted = new Promise<void>((resolve) => { markInspectionStarted = resolve; });
    claude.inspect.mockImplementation((signal) => {
      observedSignal = signal;
      markInspectionStarted();
      return new Promise<AiCliProviderInspection>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("mock setup aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    });
    const service = serviceWith(codex, claude);
    await service.inspect("codexCli");
    const activeInspection = service.inspect("claudeCli");
    await inspectionStarted;
    const failure = new HttpError(502, "process tree unverified", { processTreeUnverified: true });

    service.reportUnverifiedProcessTree("codexCli", failure);

    expect(observedSignal?.aborted).toBe(true);
    await expect(activeInspection).rejects.toBe(failure);
    await vi.waitFor(() => {
      expect(codex.shutdown).toHaveBeenCalledOnce();
      expect(claude.shutdown).toHaveBeenCalledOnce();
    });
    expect(service.getSnapshots()).toMatchObject({
      codexCli: { phase: "unavailable", failureReason: "processTreeUnverified", catalog: undefined },
      claudeCli: { phase: "unavailable", failureReason: "processTreeUnverified", catalog: undefined },
    });

    codex.emit({ type: "authenticationSucceeded", message: "late success" });
    expect(service.getSnapshots().codexCli).toMatchObject({ phase: "unavailable", failureReason: "processTreeUnverified" });
    await expect(service.shutdown()).rejects.toBe(failure);
    expect(codex.shutdown).toHaveBeenCalledOnce();
    expect(claude.shutdown).toHaveBeenCalledOnce();
  });

  it("latches an unverified process tree from a compatibility update", async () => {
    const updateRequired: AiCliProviderInspection = {
      installed: true,
      cliVersion: "0.1.0",
      managed: true,
      compatibility: "updateRequired",
      authenticated: false,
      message: "update required",
    };
    const failure = new HttpError(502, "process tree unverified", { processTreeUnverified: true });
    const codex = new FakeProvider("codexCli", [updateRequired]);
    codex.update.mockRejectedValue(failure);
    const service = serviceWith(codex, undefined, { randomNonce: () => "fatal-update-nonce", now: () => new Date(NOW) });
    await service.inspect("codexCli");
    service.prepareUpdate("codexCli");

    await expect(service.confirmUpdate("codexCli", "fatal-update-nonce")).rejects.toBe(failure);
    expect(service.getSnapshots().codexCli).toMatchObject({ phase: "unavailable", failureReason: "processTreeUnverified" });
    expect(service.isBusy()).toBe(true);
  });

  it("latches an unverified process tree while rechecking the selected CLI version", async () => {
    const failure = new HttpError(502, "process tree unverified", { processTreeUnverified: true });
    const codex = new FakeProvider("codexCli", [readyInspection("codexCli")]);
    codex.currentVersion.mockRejectedValue(failure);
    const service = serviceWith(codex);
    await service.inspect("codexCli");

    await expect(service.assertCurrentVersion("codexCli", {
      model: "gpt-future",
      effort: "max",
      speedMode: "standard",
      catalogRevision: "codexCli-r1",
      setupGeneration: 1,
    }, new AbortController().signal)).rejects.toBe(failure);
    expect(service.getSnapshots().codexCli).toMatchObject({ phase: "unavailable", failureReason: "processTreeUnverified" });
    expect(service.isBusy()).toBe(true);
  });

  it("allows the provider-owned authentication completion event to refresh the catalog", async () => {
    const loginRequired: AiCliProviderInspection = {
      installed: true,
      cliVersion: "1.2.3",
      managed: true,
      compatibility: "compatible",
      authenticated: false,
      message: "login required",
    };
    const codex = new FakeProvider("codexCli", [loginRequired, readyInspection("codexCli")]);
    const service = serviceWith(codex);
    await service.inspect("codexCli");
    await service.startAuthentication("codexCli");

    codex.emit({ type: "authenticationSucceeded", message: "signed in" });

    await vi.waitFor(() => expect(service.getSnapshots().codexCli.phase).toBe("ready"));
    expect(codex.inspect).toHaveBeenCalledTimes(2);
    expect(service.isBusy()).toBe(false);
  });

  it("does not overwrite an authentication failure event delivered while sign-in starts", async () => {
    const loginRequired: AiCliProviderInspection = {
      installed: true,
      cliVersion: "1.2.3",
      managed: true,
      compatibility: "compatible",
      authenticated: false,
      message: "login required",
    };
    const codex = new FakeProvider("codexCli", [loginRequired]);
    const service = serviceWith(codex);
    codex.startAuthentication.mockImplementation(async () => {
      codex.emit({ type: "authenticationFailed", message: "sign-in failed immediately" });
      return { state: "waiting", verificationUrl: "https://example.test/login", userCode: "ABCD", message: "waiting" };
    });
    await service.inspect("codexCli");

    await expect(service.startAuthentication("codexCli")).resolves.toMatchObject({
      phase: "loginRequired",
      authentication: { state: "failed", message: "sign-in failed immediately" },
    });
    expect(service.isBusy()).toBe(false);
  });

  it("does not overwrite authentication invalidation delivered while sign-in starts", async () => {
    const loginRequired: AiCliProviderInspection = {
      installed: true,
      cliVersion: "1.2.3",
      managed: true,
      compatibility: "compatible",
      authenticated: false,
      message: "login required",
    };
    const codex = new FakeProvider("codexCli", [loginRequired]);
    const service = serviceWith(codex);
    codex.startAuthentication.mockImplementation(async () => {
      codex.emit({ type: "authenticationInvalidated", message: "Account changed during sign-in." });
      return { state: "waiting", verificationUrl: "https://example.test/stale", userCode: "STALE", message: "stale launch response" };
    });
    await service.inspect("codexCli");

    await expect(service.startAuthentication("codexCli")).resolves.toMatchObject({
      phase: "loginRequired",
      failureReason: "authenticationChanged",
    });
  });

  it("preserves an authentication completion event delivered while cancellation is pending", async () => {
    const loginRequired: AiCliProviderInspection = {
      installed: true,
      cliVersion: "1.2.3",
      managed: true,
      compatibility: "compatible",
      authenticated: false,
      message: "login required",
    };
    const codex = new FakeProvider("codexCli", [loginRequired, readyInspection("codexCli")]);
    const service = serviceWith(codex);
    await service.inspect("codexCli");
    await service.startAuthentication("codexCli");
    codex.cancelAuthentication.mockImplementation(async () => {
      codex.emit({ type: "authenticationSucceeded", message: "Sign-in completed while cancellation was pending." });
    });

    const canceled = await service.cancelAuthentication("codexCli");
    expect(canceled.phase).not.toBe("loginRequired");
    await vi.waitFor(() => expect(service.getSnapshots().codexCli.phase).toBe("ready"));
  });
});

describe("CLI provider normalization and lazy defaults", () => {
  it("maps the Codex model name to the public model id and preserves unknown efforts", () => {
    const source: CodexModelCatalog = {
      cliVersion: "codex-cli 1.2.3",
      revision: "revision-1",
      fetchedAt: NOW,
      models: [{
        id: "internal-picker-id",
        model: "gpt-future",
        displayName: "GPT Future",
        description: "",
        isDefault: true,
        defaultReasoningEffort: "ultra",
        supportedReasoningEfforts: [
          { reasoningEffort: "ultra", description: "Provider ultra" },
          { reasoningEffort: "future-depth", description: "" },
        ],
      }],
    };
    expect(codexCatalogToAiCli(source)).toMatchObject({
      entry: "codexCli",
      models: [{
        id: "gpt-future",
        defaultEffort: "ultra",
        efforts: [{ id: "ultra", isDefault: true }, { id: "future-depth", isDefault: false }],
      }],
    });
  });

  it("normalizes Claude auth status strictly", () => {
    expect(parseClaudeAuthenticationStatus('{"loggedIn":true}')).toBe(true);
    expect(parseClaudeAuthenticationStatus('{"authenticated":false}')).toBe(false);
    expect(() => parseClaudeAuthenticationStatus('{"status":"yes"}')).toThrow(/boolean login state/u);
    expect(() => parseClaudeAuthenticationStatus("not-json")).toThrow(/invalid authentication status/u);
  });

  it("treats Claude auth status exit code 1 with loggedIn false as login required", async () => {
    const executable: ResolvedAiCliExecutable = { binary: "/mock/bin/claude", argvPrefix: [], identityPath: "/mock/bin/claude" };
    const loadClaudeCatalog = vi.fn(async () => { throw new Error("Catalog must not load while Claude is logged out."); });
    const runner = vi.fn(async (_binary: string, args: string[], options: AICommandOptions) => {
      if (args.includes("--version")) {
        expect(options.allowedExitCodes).toBeUndefined();
        return { stdout: "2.1.207\n", stderr: "" };
      }
      if (args.includes("--help")) {
        expect(options.allowedExitCodes).toBeUndefined();
        return { stdout: "Usage: claude --effort", stderr: "" };
      }
      if (args.includes("status")) {
        expect(args).toEqual(["auth", "status", "--json"]);
        expect(options.allowedExitCodes).toEqual([0, 1]);
        return { stdout: '{"loggedIn":false}\n', stderr: "" };
      }
      throw new Error("Unexpected Claude setup command.");
    });
    const claude = createClaudeAiCliSetupProvider("/tmp/reader-wiki", {
      runner,
      locateExecutable: vi.fn(async () => executable),
      inspectManagedExecutable: vi.fn(async () => mockManagedIdentity("claudeCli", executable)),
      loadClaudeCatalog,
    });
    const inspection = await claude.inspect(new AbortController().signal);
    expect(inspection.authenticated).toBe(false);
    expect(inspection.catalog).toBeUndefined();
    expect(loadClaudeCatalog).not.toHaveBeenCalled();

    const service = new AiCliSetupService({
      providers: { codexCli: new FakeProvider("codexCli", [readyInspection("codexCli")]), claudeCli: claude },
    });

    await expect(service.inspect("claudeCli")).resolves.toMatchObject({
      phase: "loginRequired",
      authentication: { state: "idle" },
      catalog: undefined,
    });
    expect(loadClaudeCatalog).not.toHaveBeenCalled();
    await service.shutdown();
  });

  it("constructs default providers without invoking CLI, SDK, app-server, or network seams", async () => {
    const runner = vi.fn();
    const locateExecutable = vi.fn();
    const inspectManagedExecutable = vi.fn();
    const spawnCodexConnection = vi.fn();
    const loadCodexCatalog = vi.fn();
    const loadClaudeCatalog = vi.fn();
    const service = createDefaultAiCliSetupService("/tmp/reader-wiki", {
      runner,
      locateExecutable,
      inspectManagedExecutable,
      spawnCodexConnection,
      loadCodexCatalog,
      loadClaudeCatalog,
    });
    expect(service.getSnapshots()).toMatchObject({ codexCli: { phase: "idle" }, claudeCli: { phase: "idle", foundationOnly: true } });
    expect(runner).not.toHaveBeenCalled();
    expect(locateExecutable).not.toHaveBeenCalled();
    expect(spawnCodexConnection).not.toHaveBeenCalled();
    expect(loadClaudeCatalog).not.toHaveBeenCalled();
    await service.shutdown();
  });

  it("rejects an unmanaged executable descriptor swap before returning an execution lease", async () => {
    const inspected: ResolvedAiCliExecutable = { binary: "/trusted/claude", argvPrefix: [], identityPath: "/trusted/claude" };
    let located = inspected;
    const runner = vi.fn(async (_binary: string, args: string[]) => {
      if (args.includes("--version")) return { stdout: "2.1.207\n", stderr: "" };
      if (args.includes("--help")) return { stdout: "Usage: claude --effort", stderr: "" };
      if (args.includes("status")) return { stdout: '{"loggedIn":true}\n', stderr: "" };
      throw new Error("Unexpected Claude setup command.");
    });
    const claude = createClaudeAiCliSetupProvider("/tmp/reader-wiki", {
      runner,
      locateExecutable: vi.fn(async () => located),
      inspectManagedExecutable: vi.fn(async () => null),
      inspectUnmanagedExecutable: vi.fn(async (_entry, current) => mockUnmanagedIdentity("claudeCli", current)),
      loadClaudeCatalog: vi.fn(async () => ({ ...catalog("claudeCli"), cliVersion: "2.1.207" })),
    });
    const service = new AiCliSetupService({
      providers: { codexCli: new FakeProvider("codexCli", [readyInspection("codexCli")]), claudeCli: claude },
    });
    await service.inspect("claudeCli");
    located = { binary: "/swapped/node", argvPrefix: ["/swapped/claude.js"], identityPath: inspected.identityPath };

    await expect(service.assertCurrentExecution("claudeCli", {
      model: "claude-future",
      effort: "max",
      speedMode: "standard",
      catalogRevision: "claudeCli-r1",
      setupGeneration: 1,
    }, new AbortController().signal)).rejects.toMatchObject({ code: "invalidSelection" });
    expect(service.getSnapshots().claudeCli).toMatchObject({ phase: "failed", failureReason: "cliVersionChanged" });
    expect(runner.mock.calls.filter(([, args]) => (args as string[]).includes("--version"))).toHaveLength(1);
  });

  it("loads the Claude Agent SDK catalog through the pinned launcher path for a managed Node npm layout", async () => {
    const located: ResolvedAiCliExecutable = { binary: "/usr/local/bin/claude", argvPrefix: [], identityPath: "/opt/claude/cli.js" };
    const managedExecution: ResolvedAiCliExecutable = { binary: "/trusted/node", argvPrefix: [located.identityPath], identityPath: located.identityPath };
    const managedIdentity: AiCliManagedRuntimeIdentity = {
      ...mockManagedIdentity("claudeCli", managedExecution),
      layout: "claudeNpmNode",
      execution: managedExecution,
    };
    const loadClaudeCatalog = vi.fn(async (options: LoadClaudeAgentSdkCatalogOptions) => ({
      ...catalog("claudeCli"),
      cliVersion: options.cliVersion,
    }));
    const claude = createClaudeAiCliSetupProvider("/tmp/reader-wiki", {
      runner: vi.fn(async (_binary, args) => {
        if (args.includes("--version")) return { stdout: "2.1.207\n", stderr: "" };
        if (args.includes("--help")) return { stdout: "Usage: claude --effort", stderr: "" };
        if (args.includes("status")) return { stdout: '{"loggedIn":true}\n', stderr: "" };
        throw new Error("Unexpected Claude setup command.");
      }),
      locateExecutable: vi.fn(async () => located),
      inspectManagedExecutable: vi.fn(async () => managedIdentity),
      loadClaudeCatalog,
    });

    await expect(claude.inspect(new AbortController().signal)).resolves.toMatchObject({
      authenticated: true,
      catalog: { revision: "claudeCli-r1" },
    });
    expect(loadClaudeCatalog).toHaveBeenCalledWith(expect.objectContaining({ execution: managedExecution }));
  });

  it("fails closed on native Windows before any Codex or Claude setup process can spawn", async () => {
    const executable: ResolvedAiCliExecutable = { binary: "/mock/bin/cli", argvPrefix: [], identityPath: "/mock/bin/cli" };
    const codexRunner = vi.fn();
    const claudeRunner = vi.fn();
    const locateCodex = vi.fn(async () => executable);
    const locateClaude = vi.fn(async () => executable);
    const spawnCodexConnection = vi.fn();
    const loadClaudeCatalog = vi.fn();
    const codex = createCodexAiCliSetupProvider("/tmp/reader-wiki", {
      platform: "win32",
      runner: codexRunner,
      locateExecutable: locateCodex,
      inspectManagedExecutable: vi.fn(async () => mockManagedIdentity("codexCli", executable)),
      spawnCodexConnection,
    });
    const claude = createClaudeAiCliSetupProvider("/tmp/reader-wiki", {
      platform: "win32",
      runner: claudeRunner,
      locateExecutable: locateClaude,
      inspectManagedExecutable: vi.fn(async () => mockManagedIdentity("claudeCli", executable)),
      loadClaudeCatalog,
    });
    const signal = new AbortController().signal;

    await expect(codex.inspect(signal)).rejects.toMatchObject({ code: "unsupportedPlatform" });
    await expect(codex.startAuthentication(signal, executable)).rejects.toMatchObject({ code: "unsupportedPlatform" });
    await expect(codex.update(signal)).rejects.toMatchObject({ code: "unsupportedPlatform" });
    await expect(claude.inspect(signal)).rejects.toMatchObject({ code: "unsupportedPlatform" });
    await expect(claude.startAuthentication(signal, executable)).rejects.toMatchObject({ code: "unsupportedPlatform" });
    await expect(claude.update(signal)).rejects.toMatchObject({ code: "unsupportedPlatform" });

    expect(codexRunner).not.toHaveBeenCalled();
    expect(claudeRunner).not.toHaveBeenCalled();
    expect(locateCodex).not.toHaveBeenCalled();
    expect(locateClaude).not.toHaveBeenCalled();
    expect(spawnCodexConnection).not.toHaveBeenCalled();
    expect(loadClaudeCatalog).not.toHaveBeenCalled();
    await codex.shutdown();
    await claude.shutdown();
  });

  it("does not start Claude authentication after its operation signal is already aborted", async () => {
    const executable: ResolvedAiCliExecutable = { binary: "/mock/bin/claude", argvPrefix: [], identityPath: "/mock/bin/claude" };
    const runner = vi.fn();
    const claude = createClaudeAiCliSetupProvider("/tmp/reader-wiki", { runner });
    const controller = new AbortController();
    controller.abort();

    await expect(claude.startAuthentication(controller.signal, executable)).rejects.toMatchObject({ name: "AbortError" });
    expect(runner).not.toHaveBeenCalled();
  });

  it.each([
    [true, "updateRequired"],
    [false, "unavailable"],
  ] as const)("classifies a missing Codex app-server command for managed=%s", async (managed, expectedPhase) => {
    const { connection } = mockCodexConnection(async () => ({}));
    const dependencies = codexProviderDependencies(connection, managed);
    const runner = vi.fn(async (_binary: string, args: string[]) => {
      if (args.includes("--version")) return { stdout: "codex-cli 1.2.3\n", stderr: "" };
      throw new HttpError(502, "Codex CLI request failed.", { cliFailureKind: "missingCapability" });
    });
    const spawnCodexConnection = vi.fn(() => connection);
    const codex = createCodexAiCliSetupProvider("/tmp/reader-wiki", {
      ...dependencies,
      runner,
      spawnCodexConnection,
    });
    const service = new AiCliSetupService({
      providers: { codexCli: codex, claudeCli: new FakeProvider("claudeCli", [readyInspection("claudeCli")]) },
    });

    await expect(service.inspect("codexCli")).resolves.toMatchObject({
      phase: expectedPhase,
      compatibility: managed ? "updateRequired" : "unmanaged",
      failureReason: "compatibilityUpdateRequired",
    });
    expect(spawnCodexConnection).not.toHaveBeenCalled();
    await service.shutdown();
  });

  it("classifies a sanitized missing Claude auth option as a compatibility update", async () => {
    const executable: ResolvedAiCliExecutable = { binary: "/mock/bin/claude", argvPrefix: [], identityPath: "/mock/bin/claude" };
    const claude = createClaudeAiCliSetupProvider("/tmp/reader-wiki", {
      runner: vi.fn(async (_binary, args) => {
        if (args.includes("--version")) return { stdout: "2.1.207\n", stderr: "" };
        if (args.includes("--help")) return { stdout: "Usage: claude --effort", stderr: "" };
        throw new HttpError(502, "Claude CLI request failed.", { cliFailureKind: "missingCapability" });
      }),
      locateExecutable: vi.fn(async () => executable),
      inspectManagedExecutable: vi.fn(async () => mockManagedIdentity("claudeCli", executable)),
      loadClaudeCatalog: vi.fn(async () => { throw new Error("Catalog must not load without auth status support."); }),
    });
    const service = new AiCliSetupService({
      providers: { codexCli: new FakeProvider("codexCli", [readyInspection("codexCli")]), claudeCli: claude },
    });

    await expect(service.inspect("claudeCli")).resolves.toMatchObject({
      phase: "updateRequired",
      compatibility: "updateRequired",
      foundationOnly: true,
      failureReason: "compatibilityUpdateRequired",
    });
    await service.shutdown();
  });

  it("restarts the retained Codex app-server when a new CLI version is inspected", async () => {
    const first = mockCodexConnection(async (method) => method === "account/read" ? { account: { type: "chatgpt" } } : {});
    const second = mockCodexConnection(async (method) => method === "account/read" ? { account: { type: "chatgpt" } } : {});
    let version = "codex-cli 1.2.3";
    const spawnCodexConnection = vi.fn()
      .mockReturnValueOnce(first.connection)
      .mockReturnValueOnce(second.connection);
    const codex = createCodexAiCliSetupProvider("/tmp/reader-wiki", codexProviderDependencies(first.connection, true, {
      runner: vi.fn(async (_binary, args) => args.includes("--version")
        ? { stdout: `${version}\n`, stderr: "" }
        : { stdout: "Codex app-server help\n", stderr: "" }),
      spawnCodexConnection,
      loadCodexCatalog: vi.fn(async (_client, options) => ({
        cliVersion: options.cliVersion,
        revision: `catalog-${options.cliVersion}`,
        fetchedAt: NOW,
        models: [],
      })),
    }));
    const service = new AiCliSetupService({
      providers: { codexCli: codex, claudeCli: new FakeProvider("claudeCli", [readyInspection("claudeCli")]) },
    });

    await expect(service.inspect("codexCli")).resolves.toMatchObject({ cliVersion: "codex-cli 1.2.3" });
    version = "codex-cli 1.2.4";
    await expect(service.inspect("codexCli")).resolves.toMatchObject({
      phase: "ready",
      cliVersion: "codex-cli 1.2.4",
      catalog: { cliVersion: "codex-cli 1.2.4", revision: "catalog-codex-cli 1.2.4" },
    });

    expect(spawnCodexConnection).toHaveBeenCalledTimes(2);
    expect(first.connection.shutdown).toHaveBeenCalledOnce();
    await service.shutdown();
  });

  it("restarts the retained Codex app-server when managed package identity changes at the same version", async () => {
    const executable: ResolvedAiCliExecutable = { binary: "/mock/bin/codex", argvPrefix: [], identityPath: "/mock/bin/codex" };
    const first = mockCodexConnection(async (method) => method === "account/read" ? { account: { type: "chatgpt" } } : {});
    const second = mockCodexConnection(async (method) => method === "account/read" ? { account: { type: "chatgpt" } } : {});
    let identityHash = "a".repeat(64);
    const spawnCodexConnection = vi.fn().mockReturnValueOnce(first.connection).mockReturnValueOnce(second.connection);
    const codex = createCodexAiCliSetupProvider("/tmp/reader-wiki", {
      ...codexProviderDependencies(first.connection, true),
      locateExecutable: vi.fn(async () => executable),
      inspectManagedExecutable: vi.fn(async () => mockManagedIdentity("codexCli", executable, identityHash)),
      spawnCodexConnection,
    });
    const service = new AiCliSetupService({
      providers: { codexCli: codex, claudeCli: new FakeProvider("claudeCli", [readyInspection("claudeCli")]) },
    });

    await service.inspect("codexCli");
    identityHash = "b".repeat(64);
    await service.inspect("codexCli");

    expect(spawnCodexConnection).toHaveBeenCalledTimes(2);
    expect(first.connection.shutdown).toHaveBeenCalledOnce();
    await service.shutdown();
  });

  it("restarts the retained Codex app-server when an unmanaged runtime identity changes at the same version", async () => {
    const executable: ResolvedAiCliExecutable = { binary: "/mock/bin/codex", argvPrefix: [], identityPath: "/mock/bin/codex" };
    const first = mockCodexConnection(async (method) => method === "account/read" ? { account: { type: "chatgpt" } } : {});
    const second = mockCodexConnection(async (method) => method === "account/read" ? { account: { type: "chatgpt" } } : {});
    let identityHash = "a".repeat(64);
    const spawnCodexConnection = vi.fn().mockReturnValueOnce(first.connection).mockReturnValueOnce(second.connection);
    const codex = createCodexAiCliSetupProvider("/tmp/reader-wiki", {
      ...codexProviderDependencies(first.connection, false),
      locateExecutable: vi.fn(async () => executable),
      inspectManagedExecutable: vi.fn(async () => null),
      inspectUnmanagedExecutable: vi.fn(async () => mockUnmanagedIdentity("codexCli", executable, identityHash)),
      spawnCodexConnection,
    });
    const service = new AiCliSetupService({
      providers: { codexCli: codex, claudeCli: new FakeProvider("claudeCli", [readyInspection("claudeCli")]) },
    });

    await service.inspect("codexCli");
    identityHash = "b".repeat(64);
    await service.inspect("codexCli");

    expect(spawnCodexConnection).toHaveBeenCalledTimes(2);
    expect(first.connection.shutdown).toHaveBeenCalledOnce();
    await service.shutdown();
  });

  it("invalidates a ready catalog when the retained Codex app-server exits cleanly", async () => {
    const { connection, client } = mockCodexConnection(async (method) => method === "account/read"
      ? { account: { type: "chatgpt" } }
      : {});
    const codex = createCodexAiCliSetupProvider("/tmp/reader-wiki", codexProviderDependencies(connection, true));
    const service = new AiCliSetupService({
      providers: { codexCli: codex, claudeCli: new FakeProvider("claudeCli", [readyInspection("claudeCli")]) },
    });
    await expect(service.inspect("codexCli")).resolves.toMatchObject({ phase: "ready", catalog: { revision: "codex-test" } });

    client.emit("closed");

    expect(service.getSnapshots().codexCli).toMatchObject({
      phase: "failed",
      failureReason: "providerConnectionClosed",
    });
    expect(service.getSnapshots().codexCli.catalog).toBeUndefined();
    await service.shutdown();
  });

  it("clears a stale Codex login id after an unexpected app-server exit", async () => {
    const first = mockCodexConnection(async (method) => {
      if (method === "account/read") return { account: null };
      if (method === "account/login/start") return { loginId: "login-1", authUrl: "https://example.test/one" };
      return {};
    });
    const second = mockCodexConnection(async (method) => {
      if (method === "account/read") return { account: null };
      if (method === "account/login/start") return { loginId: "login-2", authUrl: "https://example.test/two" };
      if (method === "account/login/cancel") throw new Error("A stale login id must not be canceled on the new connection.");
      return {};
    });
    const spawnCodexConnection = vi.fn()
      .mockReturnValueOnce(first.connection)
      .mockReturnValueOnce(second.connection);
    const codex = createCodexAiCliSetupProvider("/tmp/reader-wiki", codexProviderDependencies(first.connection, true, { spawnCodexConnection }));
    const service = new AiCliSetupService({
      providers: { codexCli: codex, claudeCli: new FakeProvider("claudeCli", [readyInspection("claudeCli")]) },
    });
    await service.inspect("codexCli");
    await service.startAuthentication("codexCli");

    first.client.emit("closed");
    await expect(service.inspect("codexCli")).resolves.toMatchObject({ phase: "loginRequired" });
    await expect(service.startAuthentication("codexCli")).resolves.toMatchObject({
      phase: "authenticating",
      authentication: { verificationUrl: "https://example.test/two" },
    });

    expect(second.client.request).not.toHaveBeenCalledWith("account/login/cancel", expect.anything(), expect.anything());
    await service.shutdown();
  });

  it("does not restore a stale catalog when authentication is invalidated during inspection", async () => {
    let releaseInspection!: (inspection: AiCliProviderInspection) => void;
    const codex = new FakeProvider("codexCli", [readyInspection("codexCli")]);
    codex.inspect.mockImplementation(() => new Promise((resolve) => { releaseInspection = resolve; }));
    const service = serviceWith(codex);
    const inspection = service.inspect("codexCli");

    codex.emit({ type: "authenticationInvalidated", message: "ChatGPT signed out." });
    releaseInspection(readyInspection("codexCli"));

    await expect(inspection).resolves.toMatchObject({
      phase: "loginRequired",
      failureReason: "authenticationChanged",
    });
    expect(service.getSnapshots().codexCli.catalog).toBeUndefined();
    await service.shutdown();
  });

  it("does not misclassify an unrelated Codex app-server probe failure as a compatibility update", async () => {
    const { connection } = mockCodexConnection(async () => ({}));
    const dependencies = codexProviderDependencies(connection, true);
    const runner = vi.fn(async (_binary: string, args: string[]) => {
      if (args.includes("--version")) return { stdout: "codex-cli 1.2.3\n", stderr: "" };
      throw new HttpError(502, "Codex CLI request failed.");
    });
    const spawnCodexConnection = vi.fn(() => connection);
    const codex = createCodexAiCliSetupProvider("/tmp/reader-wiki", {
      ...dependencies,
      runner,
      spawnCodexConnection,
    });
    const service = new AiCliSetupService({
      providers: { codexCli: codex, claudeCli: new FakeProvider("claudeCli", [readyInspection("claudeCli")]) },
    });

    await expect(service.inspect("codexCli")).resolves.toMatchObject({
      phase: "failed",
      compatibility: "unknown",
    });
    expect(spawnCodexConnection).not.toHaveBeenCalled();
    await service.shutdown();
  });

  it("classifies missing Codex account/read and model/list RPC capabilities as compatibility updates", async () => {
    const accountConnection = mockCodexConnection(async (method) => {
      if (method === "account/read") {
        throw new JsonRpcRemoteError(method, { code: -32601, message: "Method not found" });
      }
      return {};
    });
    const accountProvider = createCodexAiCliSetupProvider(
      "/tmp/reader-wiki",
      codexProviderDependencies(accountConnection.connection, true),
    );
    await expect(accountProvider.inspect(new AbortController().signal)).resolves.toMatchObject({
      compatibility: "updateRequired",
      failureReason: "compatibilityUpdateRequired",
    });
    await accountProvider.shutdown();

    const modelConnection = mockCodexConnection(async (method) => method === "account/read"
      ? { account: { type: "chatgpt" } }
      : {});
    const modelProvider = createCodexAiCliSetupProvider("/tmp/reader-wiki", codexProviderDependencies(
      modelConnection.connection,
      true,
      {
        loadCodexCatalog: vi.fn(async () => {
          throw new JsonRpcRemoteError("model/list", { code: -32601, message: "Method not found" });
        }),
      },
    ));
    await expect(modelProvider.inspect(new AbortController().signal)).resolves.toMatchObject({
      compatibility: "updateRequired",
      failureReason: "compatibilityUpdateRequired",
    });
    await modelProvider.shutdown();
  });

  it.each([
    [true, "updateRequired"],
    [false, "unavailable"],
  ] as const)("classifies missing account/login/start for managed=%s", async (managed, expectedPhase) => {
    const { connection } = mockCodexConnection(async (method) => {
      if (method === "account/read") return { account: null };
      if (method === "account/login/start") {
        throw new JsonRpcRemoteError(method, { code: -32601, message: "Method not found" });
      }
      return {};
    });
    const codex = createCodexAiCliSetupProvider("/tmp/reader-wiki", codexProviderDependencies(connection, managed));
    const service = new AiCliSetupService({
      providers: { codexCli: codex, claudeCli: new FakeProvider("claudeCli", [readyInspection("claudeCli")]) },
    });
    await expect(service.inspect("codexCli")).resolves.toMatchObject({ phase: "loginRequired" });

    await expect(service.startAuthentication("codexCli")).resolves.toMatchObject({
      phase: expectedPhase,
      compatibility: managed ? "updateRequired" : "unmanaged",
      authentication: { state: "idle" },
      failureReason: "compatibilityUpdateRequired",
    });
    await service.shutdown();
  });

  it("accepts account/login/completed only for the exact active login id", async () => {
    let loginSequence = 0;
    let signedIn = false;
    const { connection, client } = mockCodexConnection(async (method) => {
      if (method === "account/read") return { account: signedIn ? { type: "chatgpt" } : null };
      if (method === "account/login/start") {
        loginSequence += 1;
        return { loginId: `login-${loginSequence}`, authUrl: "https://example.test/codex" };
      }
      if (method === "account/login/cancel") return {};
      return {};
    });
    const codex = createCodexAiCliSetupProvider("/tmp/reader-wiki", codexProviderDependencies(connection, true));
    const service = new AiCliSetupService({
      providers: { codexCli: codex, claudeCli: new FakeProvider("claudeCli", [readyInspection("claudeCli")]) },
    });
    await service.inspect("codexCli");
    await service.startAuthentication("codexCli");
    await service.cancelAuthentication("codexCli");

    client.emit("notification", { method: "account/login/completed", params: { success: true } });
    client.emit("notification", { method: "account/login/completed", params: { loginId: "login-1", success: true } });
    await Promise.resolve();
    expect(service.getSnapshots().codexCli).toMatchObject({ phase: "loginRequired", authentication: { state: "idle" } });

    await service.startAuthentication("codexCli");
    client.emit("notification", { method: "account/login/completed", params: { loginId: "login-1", success: true } });
    client.emit("notification", { method: "account/login/completed", params: { success: true } });
    expect(service.getSnapshots().codexCli.phase).toBe("authenticating");

    signedIn = true;
    client.emit("notification", { method: "account/login/completed", params: { loginId: "login-2", success: true } });
    await vi.waitFor(() => expect(service.getSnapshots().codexCli.phase).toBe("ready"));
    await service.shutdown();
  });

  it.each([
    [null, "logout"],
    ["apiKey", "non-ChatGPT authentication"],
  ] as const)("invalidates a ready Codex catalog after %s account/updated", async (authMode, _label) => {
    const { connection, client } = mockCodexConnection(async (method) => method === "account/read"
      ? { account: { type: "chatgpt" } }
      : {});
    const codex = createCodexAiCliSetupProvider("/tmp/reader-wiki", codexProviderDependencies(connection, true));
    const service = new AiCliSetupService({
      providers: { codexCli: codex, claudeCli: new FakeProvider("claudeCli", [readyInspection("claudeCli")]) },
    });
    await expect(service.inspect("codexCli")).resolves.toMatchObject({ phase: "ready", catalog: { revision: "codex-test" } });

    client.emit("notification", { method: "account/updated", params: { authMode } });

    expect(service.getSnapshots().codexCli).toMatchObject({
      phase: "loginRequired",
      authentication: { state: "idle" },
      failureReason: "authenticationChanged",
    });
    expect(service.getSnapshots().codexCli.catalog).toBeUndefined();
    await service.shutdown();
  });

  it("propagates shutdown into an in-flight Claude SDK catalog controller", async () => {
    const executable: ResolvedAiCliExecutable = { binary: "/mock/bin/claude", argvPrefix: [], identityPath: "/mock/bin/claude" };
    let catalogController: AbortController | undefined;
    let markCatalogStarted!: () => void;
    const catalogStarted = new Promise<void>((resolve) => { markCatalogStarted = resolve; });
    const claude = createClaudeAiCliSetupProvider("/tmp/reader-wiki", {
      runner: vi.fn(async (_binary, args) => {
        if (args.includes("--version")) return { stdout: "2.1.207\n", stderr: "" };
        if (args.includes("--help")) return { stdout: "Usage: claude --effort", stderr: "" };
        if (args.includes("auth")) return { stdout: '{"loggedIn":true}', stderr: "" };
        throw new Error("Unexpected mocked Claude command");
      }),
      locateExecutable: vi.fn(async () => executable),
      inspectManagedExecutable: vi.fn(async () => mockManagedIdentity("claudeCli", executable)),
      loadClaudeCatalog: vi.fn(async (options) => {
        catalogController = options.abortController;
        markCatalogStarted();
        return new Promise<AICliModelCatalog>((_resolve, reject) => {
          options.abortController?.signal.addEventListener("abort", () => {
            const error = new Error("mock catalog aborted");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
      }),
    });
    const service = new AiCliSetupService({
      providers: { codexCli: new FakeProvider("codexCli", [readyInspection("codexCli")]), claudeCli: claude },
    });
    const inspection = service.inspect("claudeCli");
    await catalogStarted;

    await Promise.all([inspection, service.shutdown()]);

    expect(catalogController?.signal.aborted).toBe(true);
    expect(service.getSnapshots().claudeCli.phase).toBe("unavailable");
  });

  it("does not hide a Codex app-server cleanup failure after initialization fails", async () => {
    const executable: ResolvedAiCliExecutable = { binary: "/mock/bin/codex", argvPrefix: [], identityPath: "/mock/bin/codex" };
    const initializationFailure = new Error("initialize failed");
    const cleanupFailure = new Error("process tree remained alive");
    const client = new EventEmitter() as EventEmitter & {
      request: ReturnType<typeof vi.fn>;
      notify: ReturnType<typeof vi.fn>;
      respondError: ReturnType<typeof vi.fn>;
    };
    client.request = vi.fn(async () => { throw initializationFailure; });
    client.notify = vi.fn();
    client.respondError = vi.fn();
    const connection = {
      client,
      shutdown: vi.fn(async () => { throw cleanupFailure; }),
      child: {} as CodexAppServerConnection["child"],
      exited: Promise.resolve({ code: 0, signal: null }),
    } as unknown as CodexAppServerConnection;
    const codex = createCodexAiCliSetupProvider("/tmp/reader-wiki", {
      runner: vi.fn(async () => ({ stdout: "codex-cli 1.2.3\n", stderr: "" })),
      locateExecutable: vi.fn(async () => executable),
      inspectManagedExecutable: vi.fn(async () => mockManagedIdentity("codexCli", executable)),
      spawnCodexConnection: vi.fn(() => connection),
      loadCodexCatalog: vi.fn(async () => { throw new Error("catalog must not load"); }),
    });

    const service = new AiCliSetupService({
      providers: { codexCli: codex, claudeCli: new FakeProvider("claudeCli", [readyInspection("claudeCli")]) },
    });
    const error = await service.inspect("codexCli").catch((reason: unknown) => reason);

    expect(error).toMatchObject({ status: 502, details: { processTreeUnverified: true } });
    expect(error).toHaveProperty("cause", expect.any(AggregateError));
    expect((error as { cause: AggregateError }).cause.errors).toEqual([initializationFailure, cleanupFailure]);
    expect(service.getSnapshots().codexCli).toMatchObject({ phase: "unavailable", failureReason: "processTreeUnverified" });
    expect(service.isBusy()).toBe(true);
    await expect(service.inspect("claudeCli")).rejects.toBe(error);
    expect(connection.shutdown).toHaveBeenCalledOnce();
    await expect(service.shutdown()).rejects.toBe(error);
  });

  it("awaits and retains an unexpected Codex termination failure during service shutdown", async () => {
    const executable: ResolvedAiCliExecutable = { binary: "/mock/bin/codex", argvPrefix: [], identityPath: "/mock/bin/codex" };
    const cleanupFailure = new Error("unexpected Codex process group remained alive");
    let rejectTermination!: (reason: unknown) => void;
    const termination = new Promise<void>((_resolve, reject) => { rejectTermination = reject; });
    const client = new EventEmitter() as EventEmitter & {
      request: ReturnType<typeof vi.fn>;
      notify: ReturnType<typeof vi.fn>;
      respondError: ReturnType<typeof vi.fn>;
    };
    client.request = vi.fn(async (method: string) => method === "account/read" ? { account: { type: "chatgpt" } } : {});
    client.notify = vi.fn();
    client.respondError = vi.fn();
    const shutdownConnection = vi.fn(() => termination);
    const connection = {
      client,
      shutdown: shutdownConnection,
      termination,
      child: {} as CodexAppServerConnection["child"],
      exited: Promise.resolve({ code: 0, signal: null }),
    } as unknown as CodexAppServerConnection;
    const codex = createCodexAiCliSetupProvider("/tmp/reader-wiki", {
      runner: vi.fn(async () => ({ stdout: "codex-cli 1.2.3\n", stderr: "" })),
      locateExecutable: vi.fn(async () => executable),
      inspectManagedExecutable: vi.fn(async () => mockManagedIdentity("codexCli", executable)),
      spawnCodexConnection: vi.fn(() => connection),
      loadCodexCatalog: vi.fn(async () => ({
        cliVersion: "codex-cli 1.2.3",
        revision: "codex-race",
        fetchedAt: NOW,
        models: [{
          id: "picker-id",
          model: "gpt-future",
          displayName: "GPT Future",
          description: "",
          isDefault: true,
          defaultReasoningEffort: "max",
          supportedReasoningEfforts: [{ reasoningEffort: "max", description: "" }],
        }],
      })),
    });
    const service = new AiCliSetupService({
      providers: { codexCli: codex, claudeCli: new FakeProvider("claudeCli", [readyInspection("claudeCli")]) },
    });
    await expect(service.inspect("codexCli")).resolves.toMatchObject({ phase: "ready" });

    client.emit("closed", new Error("unexpected client close"));
    void connection.shutdown().catch(() => undefined);
    const closing = service.shutdown();
    let closingSettled = false;
    void closing.finally(() => { closingSettled = true; }).catch(() => undefined);
    await vi.waitFor(() => expect(shutdownConnection).toHaveBeenCalledTimes(2));
    expect(closingSettled).toBe(false);

    rejectTermination(cleanupFailure);
    const error = await closing.catch((reason: unknown) => reason);
    expect(error).toMatchObject({ status: 502, details: { processTreeUnverified: true } });
    expect(error).toHaveProperty("cause", cleanupFailure);
    expect(service.getSnapshots().codexCli).toMatchObject({
      phase: "unavailable",
      failureReason: "processTreeUnverified",
    });
    await expect(service.shutdown()).rejects.toBe(error);
  });

  it("latches an unverified background Claude authentication process tree until restart", async () => {
    const executable: ResolvedAiCliExecutable = { binary: "/mock/bin/claude", argvPrefix: [], identityPath: "/mock/bin/claude" };
    const failure = new HttpError(502, "process tree unverified", { processTreeUnverified: true });
    let rejectAuthentication!: (reason: unknown) => void;
    const claude = createClaudeAiCliSetupProvider("/tmp/reader-wiki", {
      runner: vi.fn(async (_binary, args) => {
        if (args.includes("--version")) return { stdout: "2.1.207\n", stderr: "" };
        if (args.includes("--help")) return { stdout: "Usage: claude --effort", stderr: "" };
        if (args.includes("auth") && args.includes("status")) return { stdout: '{"loggedIn":false}', stderr: "" };
        if (args.includes("auth") && args.includes("login")) {
          return new Promise<{ stdout: string; stderr: string }>((_resolve, reject) => { rejectAuthentication = reject; });
        }
        throw new Error("Unexpected mocked Claude command");
      }),
      locateExecutable: vi.fn(async () => executable),
      inspectManagedExecutable: vi.fn(async () => mockManagedIdentity("claudeCli", executable)),
      loadClaudeCatalog: vi.fn(async () => { throw new Error("catalog must not load"); }),
    });
    const service = new AiCliSetupService({
      providers: { codexCli: new FakeProvider("codexCli", [readyInspection("codexCli")]), claudeCli: claude },
    });
    await expect(service.inspect("claudeCli")).resolves.toMatchObject({ phase: "loginRequired" });
    await expect(service.startAuthentication("claudeCli")).resolves.toMatchObject({ phase: "authenticating" });

    rejectAuthentication(failure);
    await vi.waitFor(() => expect(service.getSnapshots().claudeCli).toMatchObject({
      phase: "unavailable",
      authentication: { state: "failed" },
      failureReason: "processTreeUnverified",
    }));
    expect(service.isBusy()).toBe(true);
    await expect(service.cancelAuthentication("claudeCli")).rejects.toBe(failure);
    await expect(service.inspect("codexCli")).rejects.toBe(failure);
    await expect(service.shutdown()).rejects.toBe(failure);
    await expect(service.shutdown()).rejects.toBe(failure);
  });

  it("reports an incompatible unmanaged default provider as manual-update unavailable", async () => {
    const executable: ResolvedAiCliExecutable = { binary: "/mock/bin/claude", argvPrefix: [], identityPath: "/mock/custom/claude" };
    const provider = createClaudeAiCliSetupProvider("/tmp/reader-wiki", {
      runner: vi.fn(async (_binary, args) => args.includes("--version")
        ? { stdout: "2.0.0\n", stderr: "" }
        : { stdout: "Usage: claude", stderr: "" }),
      locateExecutable: vi.fn(async () => executable),
      inspectManagedExecutable: vi.fn(async () => null),
      inspectUnmanagedExecutable: vi.fn(async () => mockUnmanagedIdentity("claudeCli", executable)),
      loadClaudeCatalog: vi.fn(async () => { throw new Error("must not load catalog"); }),
    });
    const codex = new FakeProvider("codexCli", [readyInspection("codexCli")]);
    const service = new AiCliSetupService({ providers: { codexCli: codex, claudeCli: provider } });
    const snapshot = await service.inspect("claudeCli");
    expect(snapshot).toMatchObject({ phase: "unavailable", compatibility: "unmanaged", failureReason: "compatibilityUpdateRequired" });
    expect(() => service.prepareUpdate("claudeCli")).toThrowError(expect.objectContaining({ code: "updateNotAllowed" }));
    await service.shutdown();
  });

  it("rejects package-name and path-substring spoof layouts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-spoof-layout-"));
    try {
      const codexLauncher = path.join(root, "node_modules", "@openai", "codex", "bin", "codex.js");
      await mkdir(path.dirname(codexLauncher), { recursive: true });
      await writeFile(codexLauncher, "#!/usr/bin/env node\n");
      await chmod(codexLauncher, 0o755);
      await writeFile(path.join(root, "node_modules", "@openai", "codex", "package.json"), JSON.stringify({
        name: "@openai/codex",
        version: "1.2.3",
        // Deliberately missing the exact bin and platform package contract.
      }));
      await expect(inspectManagedAiCliExecutable("codexCli", {
        binary: codexLauncher,
        argvPrefix: [],
        identityPath: codexLauncher,
      })).resolves.toBeNull();

      const claudeLauncher = path.join(root, ".local", "share", "not-claude", "node_modules", "@anthropic-ai", "claude-code", "claude");
      await mkdir(path.dirname(claudeLauncher), { recursive: true });
      await writeFile(claudeLauncher, nativeHeader("spoof"));
      await chmod(claudeLauncher, 0o755);
      await writeFile(path.join(path.dirname(claudeLauncher), "package.json"), JSON.stringify({
        name: "@anthropic-ai/claude-code",
        version: "2.1.207",
        bin: { claude: "different-file" },
      }));
      await expect(inspectManagedAiCliExecutable("claudeCli", {
        binary: claudeLauncher,
        argvPrefix: [],
        identityPath: claudeLauncher,
      })).resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pins every required Codex npm runtime member and its canonical execution path", async () => {
    const fixture = await createCodexNpmFixture();
    if (!fixture) return;
    try {
      const identity = await inspectManagedAiCliExecutable("codexCli", fixture.executable);
      expect(identity).not.toBeNull();
      expect(identity?.layout).toBe("codexNpm");
      expect(identity?.members.map((member) => member.role)).toEqual([
        "launcher",
        "packageManifest",
        "platformPackageManifest",
        "runtimeManifest",
        "payload",
        "nodeInterpreter",
      ]);
      expect(identity?.members.every((member) => member.file.sha256.match(/^[a-f0-9]{64}$/u))).toBe(true);
      expect(path.isAbsolute(identity?.execution.binary || "")).toBe(true);
      expect(identity?.execution.argvPrefix).toEqual([identity?.members[0]?.file.path]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("detects a same-path launcher replacement by regular-file identity and content hash", async () => {
    const fixture = await createClaudeNpmFixture("one");
    try {
      const first = await inspectManagedAiCliExecutable("claudeCli", fixture.executable);
      expect(first).toMatchObject({ layout: "claudeNpmNative", members: [{ role: "launcher" }, { role: "packageManifest" }] });
      await writeFile(fixture.executable.identityPath, nativeHeader("two"));
      await chmod(fixture.executable.identityPath, 0o755);
      const second = await inspectManagedAiCliExecutable("claudeCli", fixture.executable);
      expect(second).not.toBeNull();
      if (!first || !second) throw new Error("Expected strict Claude npm identities.");
      expect(first.members[0]?.file.path).toBe(second.members[0]?.file.path);
      expect(first.members[0]?.file.sha256).not.toBe(second.members[0]?.file.sha256);
      expect(sameManagedRuntimeIdentity(first, second)).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a same-path custom native launcher replacement before returning an execution lease", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-custom-native-"));
    const launcher = path.join(root, "claude");
    try {
      await writeFile(launcher, nativeHeader("one"));
      await chmod(launcher, 0o755);
      const executable: ResolvedAiCliExecutable = { binary: launcher, argvPrefix: [], identityPath: launcher };
      const runner = vi.fn(async (_binary: string, args: string[]) => {
        if (args.includes("--version")) return { stdout: "2.1.207\n", stderr: "" };
        if (args.includes("--help")) return { stdout: "Usage: claude --effort", stderr: "" };
        if (args.includes("status")) return { stdout: '{"loggedIn":false}\n', stderr: "" };
        throw new Error("Unexpected custom native setup command.");
      });
      const provider = createClaudeAiCliSetupProvider(root, {
        runner,
        locateExecutable: vi.fn(async () => executable),
      });
      await expect(provider.inspect(new AbortController().signal)).resolves.toMatchObject({ authenticated: false, managed: false });
      const callsBeforeReplacement = runner.mock.calls.length;

      await writeFile(launcher, nativeHeader("two"));
      await chmod(launcher, 0o755);

      await expect(provider.currentExecution(new AbortController().signal)).rejects.toThrow(/unmanaged CLI runtime changed/u);
      expect(runner).toHaveBeenCalledTimes(callsBeforeReplacement);
      await provider.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a custom runtime that changes during version lease revalidation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-custom-version-race-"));
    const launcher = path.join(root, "claude");
    try {
      await writeFile(launcher, nativeHeader("one"));
      await chmod(launcher, 0o755);
      const executable: ResolvedAiCliExecutable = { binary: launcher, argvPrefix: [], identityPath: launcher };
      let versionCalls = 0;
      const runner = vi.fn(async (_binary: string, args: string[]) => {
        if (args.includes("--version")) {
          versionCalls += 1;
          if (versionCalls === 2) {
            await writeFile(launcher, nativeHeader("two"));
            await chmod(launcher, 0o755);
          }
          return { stdout: "2.1.207\n", stderr: "" };
        }
        if (args.includes("--help")) return { stdout: "Usage: claude --effort", stderr: "" };
        if (args.includes("status")) return { stdout: '{"loggedIn":false}\n', stderr: "" };
        throw new Error("Unexpected custom runtime setup command.");
      });
      const provider = createClaudeAiCliSetupProvider(root, {
        runner,
        locateExecutable: vi.fn(async () => executable),
      });
      await expect(provider.inspect(new AbortController().signal)).resolves.toMatchObject({ authenticated: false, managed: false });

      await expect(provider.currentExecution(new AbortController().signal)).rejects.toThrow(/unmanaged CLI runtime changed/u);
      expect(versionCalls).toBe(2);
      await provider.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves a process-tree failure when identity validation also fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-custom-process-tree-race-"));
    const launcher = path.join(root, "claude");
    try {
      await writeFile(launcher, nativeHeader("one"));
      await chmod(launcher, 0o755);
      const executable: ResolvedAiCliExecutable = { binary: launcher, argvPrefix: [], identityPath: launcher };
      let failVersion = false;
      const processTreeFailure = new HttpError(502, "CLI process tree could not be verified.", { processTreeUnverified: true });
      const runner = vi.fn(async (_binary: string, args: string[]) => {
        if (args.includes("--version")) {
          if (failVersion) {
            await writeFile(launcher, nativeHeader("two"));
            await chmod(launcher, 0o755);
            throw processTreeFailure;
          }
          return { stdout: "2.1.207\n", stderr: "" };
        }
        if (args.includes("--help")) return { stdout: "Usage: claude --effort", stderr: "" };
        if (args.includes("status")) return { stdout: '{"loggedIn":false}\n', stderr: "" };
        throw new Error("Unexpected process-tree race setup command.");
      });
      const provider = createClaudeAiCliSetupProvider(root, {
        runner,
        locateExecutable: vi.fn(async () => executable),
      });
      await expect(provider.inspect(new AbortController().signal)).resolves.toMatchObject({ authenticated: false });
      failVersion = true;

      await expect(provider.currentExecution(new AbortController().signal)).rejects.toBe(processTreeFailure);
      await provider.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a custom runtime that changes during setup inspection before authentication or catalog loading", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-custom-inspect-race-"));
    const launcher = path.join(root, "claude");
    try {
      await writeFile(launcher, nativeHeader("one"));
      await chmod(launcher, 0o755);
      const executable: ResolvedAiCliExecutable = { binary: launcher, argvPrefix: [], identityPath: launcher };
      const runner = vi.fn(async (_binary: string, args: string[]) => {
        if (args.includes("--version")) return { stdout: "2.1.207\n", stderr: "" };
        if (args.includes("--help")) {
          await writeFile(launcher, nativeHeader("two"));
          await chmod(launcher, 0o755);
          return { stdout: "Usage: claude --effort", stderr: "" };
        }
        throw new Error("Authentication inspection must not start after the runtime changes.");
      });
      const loadClaudeCatalog = vi.fn();
      const provider = createClaudeAiCliSetupProvider(root, {
        runner,
        locateExecutable: vi.fn(async () => executable),
        loadClaudeCatalog,
      });

      await expect(provider.inspect(new AbortController().signal)).rejects.toThrow(/unmanaged CLI runtime changed/u);
      expect(runner.mock.calls.some(([, args]) => (args as string[]).includes("status"))).toBe(false);
      expect(loadClaudeCatalog).not.toHaveBeenCalled();
      await provider.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prioritizes an identity mismatch when a failing setup command changes the runtime", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-custom-failed-command-race-"));
    const launcher = path.join(root, "claude");
    try {
      await writeFile(launcher, nativeHeader("one"));
      await chmod(launcher, 0o755);
      const executable: ResolvedAiCliExecutable = { binary: launcher, argvPrefix: [], identityPath: launcher };
      const runner = vi.fn(async (_binary: string, args: string[]) => {
        if (args.includes("--version")) return { stdout: "2.1.207\n", stderr: "" };
        if (args.includes("--help")) return { stdout: "Usage: claude --effort", stderr: "" };
        if (args.includes("status")) {
          await writeFile(launcher, nativeHeader("two"));
          await chmod(launcher, 0o755);
          throw new HttpError(502, "unknown option auth status", { cliFailureKind: "missingCapability" });
        }
        throw new Error("Unexpected failed-command race setup command.");
      });
      const provider = createClaudeAiCliSetupProvider(root, {
        runner,
        locateExecutable: vi.fn(async () => executable),
      });

      await expect(provider.inspect(new AbortController().signal)).rejects.toThrow(/unmanaged CLI runtime changed/u);
      await provider.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a custom runtime that changes while SDK catalog metadata is loading", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-custom-catalog-race-"));
    const launcher = path.join(root, "claude");
    try {
      await writeFile(launcher, nativeHeader("one"));
      await chmod(launcher, 0o755);
      const executable: ResolvedAiCliExecutable = { binary: launcher, argvPrefix: [], identityPath: launcher };
      const runner = vi.fn(async (_binary: string, args: string[]) => {
        if (args.includes("--version")) return { stdout: "2.1.207\n", stderr: "" };
        if (args.includes("--help")) return { stdout: "Usage: claude --effort", stderr: "" };
        if (args.includes("status")) return { stdout: '{"loggedIn":true}\n', stderr: "" };
        throw new Error("Unexpected custom catalog setup command.");
      });
      const loadClaudeCatalog = vi.fn(async () => {
        await writeFile(launcher, nativeHeader("two"));
        await chmod(launcher, 0o755);
        throw new Error("Mock SDK worker failed after the runtime changed.");
      });
      const provider = createClaudeAiCliSetupProvider(root, {
        runner,
        locateExecutable: vi.fn(async () => executable),
        loadClaudeCatalog,
      });

      await expect(provider.inspect(new AbortController().signal)).rejects.toThrow(/unmanaged CLI runtime changed/u);
      expect(loadClaudeCatalog).toHaveBeenCalledOnce();
      await provider.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pins a custom script launcher and native interpreter and rejects an interpreter replacement", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-custom-script-"));
    const interpreter = path.join(root, "runtime");
    const launcher = path.join(root, "claude");
    try {
      await writeFile(interpreter, nativeHeader("one"));
      await chmod(interpreter, 0o755);
      await writeFile(launcher, `#!${interpreter}\n`);
      await chmod(launcher, 0o755);
      const executable: ResolvedAiCliExecutable = { binary: launcher, argvPrefix: [], identityPath: launcher };
      const runner = vi.fn(async (_binary: string, args: string[]) => {
        if (args.includes("--version")) return { stdout: "2.1.207\n", stderr: "" };
        if (args.includes("--help")) return { stdout: "Usage: claude --effort", stderr: "" };
        if (args.includes("status")) return { stdout: '{"loggedIn":false}\n', stderr: "" };
        throw new Error("Unexpected custom script setup command.");
      });
      const provider = createClaudeAiCliSetupProvider(root, {
        runner,
        locateExecutable: vi.fn(async () => executable),
      });
      await expect(provider.inspect(new AbortController().signal)).resolves.toMatchObject({ authenticated: false, managed: false });
      expect(runner.mock.calls[0]?.[0]).toBe(await realpath(interpreter));
      expect(runner.mock.calls[0]?.[1]?.[0]).toBe(await realpath(launcher));
      const callsBeforeReplacement = runner.mock.calls.length;

      await writeFile(interpreter, nativeHeader("two"));
      await chmod(interpreter, 0o755);

      await expect(provider.currentExecution(new AbortController().signal)).rejects.toThrow(/unmanaged CLI runtime changed/u);
      expect(runner).toHaveBeenCalledTimes(callsBeforeReplacement);
      await provider.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unsupported custom shebangs before spawning a setup command", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-custom-shebang-"));
    const launcher = path.join(root, "claude");
    try {
      await writeFile(launcher, "#!/usr/bin/env -S node --no-warnings\n");
      await chmod(launcher, 0o755);
      const runner = vi.fn();
      const provider = createClaudeAiCliSetupProvider(root, {
        runner,
        locateExecutable: vi.fn(async () => ({ binary: launcher, argvPrefix: [], identityPath: launcher })),
      });

      await expect(provider.inspect(new AbortController().signal)).rejects.toThrow(/one absolute path or a bounded/u);
      expect(runner).not.toHaveBeenCalled();
      await provider.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("revalidates the pinned identity immediately before update and blocks replacement", async () => {
    const executable: ResolvedAiCliExecutable = { binary: "/mock/bin/claude", argvPrefix: [], identityPath: "/mock/bin/claude" };
    let identityHash = "a".repeat(64);
    const runner = vi.fn(async (_binary: string, args: string[]) => {
      if (args.includes("--version")) return { stdout: "2.0.0\n", stderr: "" };
      if (args.includes("--help")) return { stdout: "Usage: claude", stderr: "" };
      throw new Error("update must not run after identity replacement");
    });
    const claude = createClaudeAiCliSetupProvider("/tmp/reader-wiki", {
      runner,
      locateExecutable: vi.fn(async () => executable),
      inspectManagedExecutable: vi.fn(async () => mockManagedIdentity(
        "claudeCli",
        executable,
        identityHash,
      )),
      loadClaudeCatalog: vi.fn(async () => { throw new Error("catalog must not load"); }),
    });
    const codex = new FakeProvider("codexCli", [readyInspection("codexCli")]);
    const service = new AiCliSetupService({
      providers: { codexCli: codex, claudeCli: claude },
      randomNonce: () => "identity-nonce",
      now: () => new Date(NOW),
    });
    expect(await service.inspect("claudeCli")).toMatchObject({ phase: "updateRequired", compatibility: "updateRequired" });
    service.prepareUpdate("claudeCli");
    identityHash = "b".repeat(64);
    const result = await service.confirmUpdate("claudeCli", "identity-nonce");
    expect(result).toMatchObject({ phase: "updateRequired", update: { state: "failed" }, failureReason: "updateFailed" });
    expect(runner.mock.calls.some(([, args]) => (args as string[]).includes("update"))).toBe(false);
    await service.shutdown();
  });

  it("normalizes Codex and Claude through injected default-provider seams only", async () => {
    const packageRoot = path.resolve("/tmp/reader-wiki");
    const executable: ResolvedAiCliExecutable = { binary: "/mock/bin/cli", argvPrefix: [], identityPath: "/mock/pkg/cli.js" };
    const client = new EventEmitter() as EventEmitter & {
      request: ReturnType<typeof vi.fn>;
      notify: ReturnType<typeof vi.fn>;
      respondError: ReturnType<typeof vi.fn>;
    };
    client.request = vi.fn(async (method: string) => method === "account/read" ? { account: { type: "chatgpt" } } : {});
    client.notify = vi.fn();
    client.respondError = vi.fn();
    const connection = {
      client,
      shutdown: vi.fn(async () => undefined),
      child: {} as CodexAppServerConnection["child"],
      exited: Promise.resolve({ code: 0, signal: null }),
    } as unknown as CodexAppServerConnection;
    const codexCatalog: CodexModelCatalog = {
      cliVersion: "codex-cli 1.2.3",
      revision: "codex-revision",
      fetchedAt: NOW,
      models: [{
        id: "picker-id",
        model: "gpt-future",
        displayName: "GPT Future",
        description: "Future",
        isDefault: true,
        defaultReasoningEffort: "max",
        supportedReasoningEfforts: [{ reasoningEffort: "max", description: "Max" }],
      }],
    };
    const codexRunner = vi.fn(async () => ({ stdout: "codex-cli 1.2.3\n", stderr: "" }));
    const codexProvider = createCodexAiCliSetupProvider(packageRoot, {
      runner: codexRunner,
      locateExecutable: vi.fn(async () => executable),
      inspectManagedExecutable: vi.fn(async () => mockManagedIdentity("codexCli", executable)),
      spawnCodexConnection: vi.fn(() => connection),
      loadCodexCatalog: vi.fn(async () => codexCatalog),
      now: () => new Date(NOW),
    });
    const codex = await codexProvider.inspect(new AbortController().signal);
    expect(codex.catalog?.models[0]).toMatchObject({ id: "gpt-future", defaultEffort: "max" });
    expect(codexRunner).toHaveBeenCalledWith("/mock/bin/cli", ["--version"], expect.objectContaining({ cwd: packageRoot }));

    const claudeCatalog = catalog("claudeCli");
    const claudeRunner = vi.fn(async (_binary: string, args: string[]) => {
      if (args.includes("--version")) return { stdout: "2.1.0\n", stderr: "" };
      if (args.includes("--help")) return { stdout: "Usage: claude --effort <level>", stderr: "" };
      return { stdout: '{"loggedIn":true}', stderr: "" };
    });
    const claudeProvider = createClaudeAiCliSetupProvider(packageRoot, {
      runner: claudeRunner,
      locateExecutable: vi.fn(async () => executable),
      inspectManagedExecutable: vi.fn(async () => mockManagedIdentity("claudeCli", executable)),
      loadClaudeCatalog: vi.fn(async (options) => {
        expect(options).toMatchObject({ execution: executable, cwd: packageRoot, cliVersion: "2.1.0" });
        return claudeCatalog;
      }),
      now: () => new Date(NOW),
    });
    const claude = await claudeProvider.inspect(new AbortController().signal);
    expect(claude).toMatchObject({ authenticated: true, foundationOnly: true, catalog: { revision: "claudeCli-r1" } });
    await codexProvider.shutdown();
    await claudeProvider.shutdown();
  });
});
