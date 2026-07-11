import { HttpError } from "./errors.js";
import {
  ensureSafeCwd,
  resolveAIWorkspace,
  type AICommandRunner,
  runAICommand,
  safeCliEnv,
  sanitizeCliText,
} from "./aiCliAdapters.js";
import { probeGuardedRepoWriteCapability, type GuardedProviderRequester } from "./guardedRepoEdits.js";
import { providerReadiness, testAIConnection } from "./aiProviders.js";
import type { AIConnectionStatus, AIEntryKind, AIEntryReadiness, AIProviderSettings, AICliEntryKind, CliAIEntrySettings, RepositoryConfig } from "./types.js";

type Check = AIEntryReadiness["checks"][number];

type ProbeOptions = {
  provider?: AIProviderSettings;
  repo?: RepositoryConfig;
  runner?: AICommandRunner;
  providerRequester?: GuardedProviderRequester;
  signal?: AbortSignal;
};

export async function probeAIEntryReadiness(entry: AIEntryKind, options: ProbeOptions = {}): Promise<AIEntryReadiness> {
  if (entry === "codexCli") return probeCxReadiness(options.runner || runAICommand, options.repo, options.signal);
  if (entry === "claudeCli") return probeClaudeReadiness(options.runner || runAICommand, options.repo, options.signal);
  if (entry === "aiApi") return probeProviderReadiness(options.provider, options.repo, options.signal, options.providerRequester);
  if (entry === "localAi") return probeLocalReadiness(options.provider, options.repo, options.signal, options.providerRequester);
  throw new HttpError(400, "Unknown AI entry.");
}

export async function probeCliEntryReadiness(entry: AICliEntryKind, runner: AICommandRunner = runAICommand): Promise<AIEntryReadiness> {
  return probeAIEntryReadiness(entry, { runner });
}

async function probeCxReadiness(runner: AICommandRunner, repo?: RepositoryConfig, signal?: AbortSignal): Promise<AIEntryReadiness> {
  const workspace = await readinessWorkspace(repo);
  const probeCwd = await ensureSafeCwd();
  const version = await runProbe(runner, "codex", ["--version"], probeCwd, "codexCli", signal);
  const login = await runProbe(runner, "codex", ["login", "status"], probeCwd, "codexCli", signal);
  const help = await runProbe(runner, "codex", ["exec", "--help"], probeCwd, "codexCli", signal);
  const binaryReady = version.ok;
  const authReady = login.ok && codexAuthConfigured(probeText(login));
  const wrapperReady = false;
  const workspaceReady = workspace.ready;
  const checks = [
    check("binary", "Binary", binaryReady, binaryReady ? probeText(version).split(/\r?\n/)[0] || "Installed." : version.error),
    check("auth", "Existing CLI auth", authReady, authReady ? "Existing CLI auth is configured." : login.ok ? "Existing CLI auth was not confirmed." : login.error),
    check("wrapper", "Current repo-only write boundary", wrapperReady, help.ok ? "Codex CLI Current repo write is fail-closed. The tested macOS Codex 0.144.1 :minimal runtime grants shared system temp read/write access, and Reader-Wiki has not proven an equivalent Current repo-only boundary on every supported platform." : help.error),
    check("workspace", "Workspace", workspaceReady, workspace.message),
    check("execution-policy", "Readiness execution policy", true, "Readiness inspects binary, auth, flags, and workspace without running an AI edit. It does not enable CLI write while the Current repo-only boundary is unprovable."),
  ];
  return cliReadinessResult("codexCli", "codex", binaryReady ? probeText(version).split(/\r?\n/)[0] || "" : "", authReady, checks);
}

async function probeClaudeReadiness(runner: AICommandRunner, repo?: RepositoryConfig, signal?: AbortSignal): Promise<AIEntryReadiness> {
  const workspace = await readinessWorkspace(repo);
  const probeCwd = await ensureSafeCwd();
  const version = await runProbe(runner, "claude", ["--version"], probeCwd, "claudeCli", signal);
  const auth = await runProbe(runner, "claude", ["auth", "status"], probeCwd, "claudeCli", signal);
  const help = await runProbe(runner, "claude", ["-p", "--help"], probeCwd, "claudeCli", signal);
  const helpText = probeText(help);
  const binaryReady = version.ok;
  const authReady = auth.ok && claudeAuthConfigured(probeText(auth));
  const capabilityPresent = help.ok && claudeHelpSupportsRepoWrite(helpText);
  const wrapperReady = false;
  const workspaceReady = workspace.ready;
  const checks = [
    check("binary", "Binary", binaryReady, binaryReady ? probeText(version).split(/\r?\n/)[0] || "Installed." : version.error),
    check("auth", "Existing CLI auth", authReady, authReady ? "Existing CLI auth is configured." : auth.ok ? "Existing CLI auth was not confirmed." : auth.error),
    check("wrapper", "Repo-scoped write wrapper", wrapperReady, capabilityPresent ? "Claude Code CLI Current repo write remains unavailable because Reader-Wiki cannot prove repo-outside read and protected-path write confinement." : help.ok ? "Tool-restricted print flags were not confirmed." : help.error),
    check("workspace", "Workspace", workspaceReady, workspace.message),
    check("execution-policy", "Readiness execution policy", true, "Readiness does not run an AI edit and fails closed when Current repo confinement cannot be proven."),
  ];
  return cliReadinessResult("claudeCli", "claude", binaryReady ? probeText(version).split(/\r?\n/)[0] || "" : "", authReady, checks);
}

async function probeProviderReadiness(provider: AIProviderSettings | undefined, repo?: RepositoryConfig, signal?: AbortSignal, requester?: GuardedProviderRequester): Promise<AIEntryReadiness> {
  const providerCheck = provider ? providerReadiness(provider) : missingProviderStatus("AI API settings are required.");
  const mode = providerExecutionMode(provider);
  const connection = provider && providerCheck.state === "ready" && mode === "readOnly" ? await testAIConnection(provider, signal) : providerCheck;
  if (mode === "readOnly") {
    return providerReadinessResult("aiApi", provider, [
      check("provider", "Provider settings", providerCheck.state === "ready", providerCheck.message),
      check("endpoint", "Endpoint reachable", connection.state === "ready" && connection.code === "success", connection.message),
      check("execution-policy", "Execution policy", true, "Context-only provider execution is ready and cannot write repository files."),
    ]);
  }

  const workspace = await readinessWorkspace(repo);
  const capability = provider && providerCheck.state === "ready"
    ? await probeGuardedRepoWriteCapability(provider, signal, requester)
    : { ok: false, message: providerCheck.message, status: undefined };
  const endpointReady = capability.status?.state === "ready" && capability.status.code === "success";
  const checks = [
    check("provider", "Provider settings", providerCheck.state === "ready", providerCheck.message),
    check("endpoint", "Endpoint reachable", endpointReady, endpointReady ? "The configured endpoint returned a model response." : capability.message),
    check("protocol", "Guarded edit protocol", capability.ok, capability.message),
    check("workspace", "Workspace", workspace.ready && workspace.repoScoped, workspace.repoScoped ? workspace.message : "Current repo write requires a selected repository workspace."),
    check("execution-policy", "Execution policy", true, "The provider receives bounded repository-relative context but no filesystem or shell access. Reader-Wiki alone validates and applies text operations inside the Current repo."),
  ];
  return providerReadinessResult("aiApi", provider, checks);
}

async function probeLocalReadiness(provider: AIProviderSettings | undefined, repo?: RepositoryConfig, signal?: AbortSignal, requester?: GuardedProviderRequester): Promise<AIEntryReadiness> {
  const providerCheck = provider ? providerReadiness(provider) : missingProviderStatus("Local AI settings are required.");
  const mode = providerExecutionMode(provider);
  const connection = provider && providerCheck.state === "ready" && mode === "readOnly"
    ? await testAIConnection(provider, signal)
    : providerCheck;
  if (mode === "readOnly") {
    return providerReadinessResult("localAi", provider, [
      check("provider", "Local settings", providerCheck.state === "ready", providerCheck.message),
      check("local-provider", "Local provider", providerCheck.state === "ready", providerCheck.state === "ready" ? "A direct loopback provider is configured for Context-only execution." : providerCheck.message),
      check("endpoint", "Endpoint reachable", connection.state === "ready" && connection.code === "success", connection.message),
      check("execution-policy", "Execution policy", true, "Context-only local execution is ready and cannot write repository files."),
    ]);
  }

  const workspace = await readinessWorkspace(repo);
  const capability = provider && providerCheck.state === "ready"
    ? await probeGuardedRepoWriteCapability(provider, signal, requester)
    : { ok: false, message: providerCheck.message, status: undefined };
  const endpointReady = capability.status?.state === "ready" && capability.status.code === "success";
  const checks = [
    check("provider", "Local settings", providerCheck.state === "ready", providerCheck.message),
    check("endpoint", "Endpoint reachable", endpointReady, endpointReady ? "The loopback endpoint returned a model response." : capability.message),
    check("protocol", "Guarded edit protocol", capability.ok, capability.message),
    check("workspace", "Workspace", workspace.ready && workspace.repoScoped, workspace.repoScoped ? workspace.message : "Current repo write requires a selected repository workspace."),
    check("execution-policy", "Execution policy", true, "The local model receives bounded repository-relative context but no filesystem or shell access. Reader-Wiki alone validates and applies text operations inside the Current repo."),
  ];
  return providerReadinessResult("localAi", provider, checks);
}

async function readinessWorkspace(repo: RepositoryConfig | undefined): Promise<{ cwd: string; ready: boolean; message: string; repoScoped: boolean }> {
  if (!repo) {
    return { cwd: await ensureSafeCwd(), ready: true, message: "Readiness checked without a selected repository.", repoScoped: false };
  }
  try {
    const workspace = await resolveAIWorkspace(repo);
    return { cwd: workspace.root, ready: true, message: "Active repository root is available.", repoScoped: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { cwd: await ensureSafeCwd(), ready: false, message: sanitizeCliText(message), repoScoped: false };
  }
}

async function runProbe(runner: AICommandRunner, binary: string, args: string[], cwd: string, entry: AIEntryKind, signal?: AbortSignal): Promise<{ ok: true; stdout: string; stderr: string } | { ok: false; stdout: string; stderr: string; error: string }> {
  try {
    const result = await runner(binary, args, {
      cwd,
      env: safeCliEnv(entry),
      timeoutMs: 30_000,
      maxBuffer: 256 * 1024,
      signal,
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, stdout: "", stderr: "", error: sanitizeCliText(message) };
  }
}

function probeText(result: { stdout: string; stderr: string }): string {
  return sanitizeCliText([result.stdout, result.stderr].filter(Boolean).join("\n"));
}

function claudeHelpSupportsRepoWrite(help: string): boolean {
  return help.includes("--print") && help.includes("--output-format") && help.includes("--tools") && help.includes("--permission-mode") && help.includes("--safe-mode") && help.includes("--no-session-persistence");
}

function claudeAuthConfigured(stdout: string): boolean {
  try {
    const data = JSON.parse(stdout) as { loggedIn?: boolean };
    return data.loggedIn === true;
  } catch {
    return /logged.?in/i.test(stdout);
  }
}

function codexAuthConfigured(stdout: string): boolean {
  const normalized = stdout.trim();
  if (/\bnot\s+logged\s+in\b/i.test(normalized) || /\blogged\s+out\b/i.test(normalized)) return false;
  return /\blogged\s+in\b/i.test(normalized);
}

function cliReadinessResult(entry: AICliEntryKind, binaryName: "codex" | "claude", version: string, authReady: boolean, checks: Check[]): AIEntryReadiness {
  const ready = false;
  const status = readinessStatus(false, checks, firstError(checks));
  const settings: CliAIEntrySettings = {
    entry,
    binaryName,
    version,
    authState: authReady ? "configured" : "notConfigured",
    readOnlyWrapperState: "notReady",
    executionMode: "unknown",
    lastCheckedAt: status.checkedAt,
    readinessMessage: status.message,
  };
  return { entry, settings, status, ready, checks };
}

function providerReadinessResult(entry: "aiApi" | "localAi", provider: AIProviderSettings | undefined, checks: Check[]): AIEntryReadiness {
  const ready = checks.every((item) => item.status === "ready");
  const mode = providerExecutionMode(provider);
  const status = readinessStatus(ready, checks, ready ? `${entryLabel(entry)} ${mode === "repoWrite" ? "repo-wide Current repo write" : "context-only execution"} is ready.` : firstError(checks));
  const publicProvider = provider
    ? omitProviderCredential(provider)
    : { entry, model: "", baseUrl: "", apiFormat: "openaiCompatible" as const };
  return {
    entry,
    settings: { ...publicProvider, entry, executionMode: mode } as AIProviderSettings,
    status,
    ready,
    checks,
  };
}

function omitProviderCredential(provider: AIProviderSettings): Omit<AIProviderSettings, "credential"> {
  const { credential: _credential, ...publicProvider } = provider;
  return publicProvider;
}

function providerExecutionMode(provider: AIProviderSettings | undefined): "readOnly" | "repoWrite" {
  return provider?.executionMode === "repoWrite" ? "repoWrite" : "readOnly";
}

function check(id: string, label: string, ok: boolean, message: string): Check {
  return { id, label, status: ok ? "ready" : "error", message: sanitizeCliText(message) };
}

function readinessStatus(ready: boolean, checks: Check[], message: string): AIConnectionStatus {
  if (ready) {
    return {
      state: "ready",
      code: "success",
      severity: "success",
      message: sanitizeCliText(message),
      nextAction: "Use this entry for repo-scoped AI Chat or check again.",
      checkedAt: new Date().toISOString(),
    };
  }
  const failed = checks.find((item) => item.status === "error");
  const code = failed?.id === "auth"
    ? "cli_auth_missing"
    : failed?.id === "provider"
      ? "not_configured"
      : failed?.id === "endpoint"
        ? "endpoint_unreachable"
        : failed?.id === "protocol"
          ? "unsupported_provider"
    : failed?.id === "workspace"
      ? "workspace_not_ready"
      : failed?.id === "provider-support" || failed?.id === "local-provider"
        ? "unsupported_provider"
        : failed?.id === "auth-isolation"
          ? "substrate_missing"
          : "wrapper_not_ready";
  const nextAction = failed?.id === "auth"
    ? "Complete persistent sign-in with the CLI outside Reader-Wiki, then check readiness again. Credential-like environment variables are not forwarded."
    : failed?.id === "protocol"
      ? "Choose a model that returns the strict versioned Reader-Wiki JSON protocol, then check readiness again."
    : failed?.id === "workspace"
      ? "Select a registered repository root before sending AI Chat."
      : "Check AI Entry settings and run readiness again.";
  return {
    state: "failed",
    code,
    severity: "warning",
    message: sanitizeCliText(message),
    nextAction,
    checkedAt: new Date().toISOString(),
  };
}

function missingProviderStatus(message: string): AIConnectionStatus {
  return {
    state: "notConfigured",
    code: "not_configured",
    severity: "warning",
    message,
    nextAction: "Complete the entry settings, then run readiness again.",
    checkedAt: new Date().toISOString(),
  };
}

function firstError(checks: Check[]): string {
  return checks.find((item) => item.status === "error")?.message || "AI Entry readiness is not confirmed.";
}

function entryLabel(entry: AIEntryKind): string {
  if (entry === "codexCli") return ["Co", "dex CLI"].join("");
  if (entry === "claudeCli") return "Claude Code CLI";
  if (entry === "localAi") return "Local AI";
  return "AI API";
}
