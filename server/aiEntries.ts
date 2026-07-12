import { access, constants } from "node:fs/promises";
import { HttpError } from "./errors.js";
import {
  claudeAuthenticationProbeArgs,
  claudeCurrentRepoSandboxSupported,
  codexCurrentRepoArgs,
  ensureSafeCwd,
  probeCodexProjectMcpServers,
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
  platform?: NodeJS.Platform;
};

export async function probeAIEntryReadiness(entry: AIEntryKind, options: ProbeOptions = {}): Promise<AIEntryReadiness> {
  if (entry === "codexCli") return probeCxReadiness(options.runner || runAICommand, options.repo, options.signal);
  if (entry === "claudeCli") return probeClaudeReadiness(options.runner || runAICommand, options.repo, options.signal, options.platform || process.platform);
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
  const help = await runProbe(runner, "codex", ["exec", ...codexCurrentRepoArgs(), "--help"], probeCwd, "codexCli", signal);
  const mcpList = await runCodexMcpProbe(runner, workspace.cwd, signal);
  const helpText = probeCapabilityText(help);
  const binaryReady = version.ok;
  const authReady = login.ok && codexAuthConfigured(probeText(login));
  const wrapperReady = help.ok && codexHelpSupportsRepoWrite(helpText);
  const mcpIsolationReady = mcpList.ok;
  const workspaceReady = workspace.ready && workspace.repoScoped && workspace.writable;
  const checks = [
    check("binary", "Binary", binaryReady, binaryReady ? probeText(version).split(/\r?\n/)[0] || "Installed." : version.error),
    check("auth", "Existing CLI auth", authReady, authReady ? "Existing CLI auth is configured." : login.ok ? "Existing CLI auth was not confirmed." : login.error),
    check("wrapper", "Current repo CLI execution", wrapperReady, wrapperReady ? "Codex non-interactive Current repo permission-profile flags are available." : help.ok ? "Required Codex non-interactive workspace flags were not confirmed." : help.error),
    check("mcp-isolation", "Project MCP isolation", mcpIsolationReady, mcpIsolationReady ? "Project MCP servers can be enumerated and disabled for the Codex run." : mcpList.error),
    check("workspace", "Workspace", workspaceReady, workspace.repoScoped ? workspace.message : "Select a Current repo before checking CLI readiness."),
    check("execution-policy", "Readiness execution policy", true, "Readiness inspects binary, existing auth, flags, and Current repo without running an AI request or editing files."),
  ];
  return cliReadinessResult("codexCli", "codex", binaryReady ? probeText(version).split(/\r?\n/)[0] || "" : "", authReady, checks);
}

async function probeClaudeReadiness(runner: AICommandRunner, repo: RepositoryConfig | undefined, signal: AbortSignal | undefined, platform: NodeJS.Platform): Promise<AIEntryReadiness> {
  const workspace = await readinessWorkspace(repo);
  const probeCwd = await ensureSafeCwd();
  const version = await runProbe(runner, "claude", ["--version"], probeCwd, "claudeCli", signal);
  const auth = await runProbe(runner, "claude", ["auth", "status"], probeCwd, "claudeCli", signal);
  const help = await runProbe(runner, "claude", ["-p", "--help"], probeCwd, "claudeCli", signal);
  const helpText = probeCapabilityText(help);
  const binaryReady = version.ok;
  const authConfigured = auth.ok && claudeAuthConfigured(probeText(auth));
  const sandboxSupported = claudeCurrentRepoSandboxSupported(platform);
  const wrapperFlagsReady = help.ok && claudeHelpSupportsRepoWrite(helpText);
  const wrapperReady = wrapperFlagsReady && sandboxSupported;
  const workspaceReady = workspace.ready && workspace.repoScoped && workspace.writable;
  const shouldValidateAuthentication = authConfigured && wrapperReady && workspaceReady;
  const authExecution = shouldValidateAuthentication
    ? await runClaudeAuthenticationProbe(runner, workspace.cwd, signal)
    : null;
  const authReady = authConfigured && (!shouldValidateAuthentication || authExecution?.ok === true);
  const authMessage = !authConfigured
    ? auth.ok ? "Existing CLI auth was not confirmed." : auth.error
    : !shouldValidateAuthentication
      ? "Existing CLI auth is reported configured; model validation waits for the Current repo execution boundary to be ready."
      : authExecution?.ok
        ? "Existing CLI auth completed a no-tool model request."
        : authExecution?.error || "Claude Code authentication probe failed.";
  const wrapperMessage = !sandboxSupported
    ? "Native Windows is not enabled for Claude Code CLI because its Bash sandbox cannot enforce the Current repo-only write boundary. Use macOS, Linux, or Claude Code in WSL2."
    : wrapperFlagsReady
      ? "Claude Code native repository tools, isolated settings, acceptEdits, and fail-closed sandbox flags are available."
      : help.ok ? "Required Claude Code non-interactive edit flags were not confirmed." : help.error;
  const checks = [
    check("binary", "Binary", binaryReady, binaryReady ? probeText(version).split(/\r?\n/)[0] || "Installed." : version.error),
    check("auth", "Existing CLI auth", authReady, authMessage),
    check("wrapper", "Current repo CLI execution", wrapperReady, wrapperMessage),
    check("workspace", "Workspace", workspaceReady, workspace.repoScoped ? workspace.message : "Select a Current repo before checking CLI readiness."),
    check("execution-policy", "Readiness execution policy", true, "Readiness sends one no-tool authentication prompt but cannot edit repository files."),
  ];
  return cliReadinessResult("claudeCli", "claude", binaryReady ? probeText(version).split(/\r?\n/)[0] || "" : "", authReady, checks);
}

async function runClaudeAuthenticationProbe(runner: AICommandRunner, cwd: string, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const result = await runner("claude", claudeAuthenticationProbeArgs(), {
      cwd,
      env: safeCliEnv("claudeCli"),
      input: "Reply with exactly READY. Do not use tools.",
      timeoutMs: 30_000,
      maxBuffer: 256 * 1024,
      signal,
    });
    const data = JSON.parse(result.stdout || "{}") as { is_error?: boolean; result?: unknown };
    if (data.is_error || typeof data.result !== "string" || !data.result.trim()) {
      return { ok: false, error: "Claude Code authentication probe did not return a model response." };
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: sanitizeCliText(message) || "Claude Code authentication probe failed." };
  }
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

async function readinessWorkspace(repo: RepositoryConfig | undefined): Promise<{ cwd: string; ready: boolean; message: string; repoScoped: boolean; writable: boolean }> {
  if (!repo) {
    return { cwd: await ensureSafeCwd(), ready: true, message: "Readiness checked without a selected repository.", repoScoped: false, writable: false };
  }
  try {
    const workspace = await resolveAIWorkspace(repo);
    await access(workspace.root, constants.W_OK);
    return { cwd: workspace.root, ready: true, message: "Active repository root is available and writable by the Reader-Wiki process.", repoScoped: true, writable: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { cwd: await ensureSafeCwd(), ready: false, message: sanitizeCliText(message), repoScoped: false, writable: false };
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

function probeCapabilityText(result: { stdout: string; stderr: string }): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function codexHelpSupportsRepoWrite(help: string): boolean {
  return help.includes("--strict-config")
    && help.includes("--disable")
    && help.includes("--config")
    && help.includes("--cd")
    && help.includes("--ignore-user-config")
    && help.includes("--skip-git-repo-check")
    && help.includes("--ephemeral")
    && help.includes("--json");
}

async function runCodexMcpProbe(runner: AICommandRunner, cwd: string, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await probeCodexProjectMcpServers(runner, cwd, signal);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: sanitizeCliText(message) };
  }
}

function claudeHelpSupportsRepoWrite(help: string): boolean {
  return help.includes("--print")
    && help.includes("--output-format")
    && help.includes("--tools")
    && help.includes("--permission-mode")
    && help.includes("--safe-mode")
    && help.includes("--no-chrome")
    && help.includes("--disable-slash-commands")
    && help.includes("--strict-mcp-config")
    && help.includes("--mcp-config")
    && help.includes("--setting-sources")
    && help.includes("--settings")
    && help.includes("--no-session-persistence");
}

function claudeAuthConfigured(stdout: string): boolean {
  try {
    const data = JSON.parse(stdout) as { loggedIn?: boolean };
    return data.loggedIn === true;
  } catch {
    const normalized = stdout.trim();
    if (/\bnot\s+logged\s+in\b/i.test(normalized) || /\blogged\s+out\b/i.test(normalized)) return false;
    return /\blogged.?in\b/i.test(normalized);
  }
}

function codexAuthConfigured(stdout: string): boolean {
  const normalized = stdout.trim();
  if (/\bnot\s+logged\s+in\b/i.test(normalized) || /\blogged\s+out\b/i.test(normalized)) return false;
  return /\blogged\s+in\b/i.test(normalized);
}

function cliReadinessResult(entry: AICliEntryKind, binaryName: "codex" | "claude", version: string, authReady: boolean, checks: Check[]): AIEntryReadiness {
  const ready = checks.every((item) => item.status === "ready");
  const status = readinessStatus(ready, checks, ready ? `${entryLabel(entry)} Current repo execution is ready.` : firstError(checks));
  const settings: CliAIEntrySettings = {
    entry,
    binaryName,
    version,
    authState: authReady ? "configured" : "notConfigured",
    readOnlyWrapperState: ready ? "ready" : "notReady",
    executionMode: ready ? "repoWrite" : "unknown",
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
    ? "Complete persistent sign-in or correct the CLI authentication environment outside Reader-Wiki, then check readiness again. Reader-Wiki does not display or store credential values."
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
