import { HttpError } from "./errors.js";
import {
  codexLocalSubstrate,
  codexProviderSubstrate,
  ensureSafeCwd,
  resolveAIWorkspace,
  type AICommandRunner,
  runAICommand,
  safeCliEnv,
  sanitizeCliText,
} from "./aiCliAdapters.js";
import { providerReadiness, testAIConnection } from "./aiProviders.js";
import type { AIConnectionStatus, AIEntryKind, AIEntryReadiness, AIProviderSettings, AICliEntryKind, CliAIEntrySettings, RepositoryConfig } from "./types.js";

type Check = AIEntryReadiness["checks"][number];

type ProbeOptions = {
  provider?: AIProviderSettings;
  repo?: RepositoryConfig;
  runner?: AICommandRunner;
  signal?: AbortSignal;
};

export async function probeAIEntryReadiness(entry: AIEntryKind, options: ProbeOptions = {}): Promise<AIEntryReadiness> {
  if ((entry === "codexCli" || entry === "claudeCli") && process.env.READER_WIKI_EXPERIMENTAL_AI_WRITE !== "1") {
    return experimentalWriteDisabled(entry);
  }
  if (entry === "codexCli") return probeCxReadiness(options.runner || runAICommand, options.repo, options.signal);
  if (entry === "claudeCli") return probeClaudeReadiness(options.runner || runAICommand, options.repo, options.signal);
  if (entry === "aiApi") return probeCodexBackedProviderReadiness(options.provider, options.signal);
  if (entry === "localAi") return probeCodexBackedLocalReadiness(options.provider, options.signal);
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
  const help = await runProbe(runner, "codex", ["exec", "-c", "approval_policy=\"never\"", "--help"], probeCwd, "codexCli", signal);
  const helpText = probeText(help);
  const binaryReady = version.ok;
  const authReady = login.ok && /logged in/i.test(probeText(login));
  const wrapperReady = help.ok && cxHelpSupportsRepoWrite(helpText);
  const workspaceReady = workspace.ready;
  const checks = [
    check("binary", "Binary", binaryReady, binaryReady ? probeText(version).split(/\r?\n/)[0] || "Installed." : version.error),
    check("auth", "Existing CLI auth", authReady, authReady ? "Existing CLI auth is configured." : login.ok ? "Existing CLI auth was not confirmed." : login.error),
    check("wrapper", "Repo-scoped write wrapper", wrapperReady, wrapperReady ? "Repo-scoped non-interactive flags are available." : help.ok ? "Repo-scoped non-interactive flags were not confirmed." : help.error),
    check("workspace", "Workspace", workspaceReady, workspace.message),
    check("execution-policy", "Readiness execution policy", true, "Readiness inspects binary, auth, flags, and workspace without running an AI edit."),
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
  const wrapperReady = help.ok && claudeHelpSupportsRepoWrite(helpText);
  const workspaceReady = workspace.ready;
  const checks = [
    check("binary", "Binary", binaryReady, binaryReady ? probeText(version).split(/\r?\n/)[0] || "Installed." : version.error),
    check("auth", "Existing CLI auth", authReady, authReady ? "Existing CLI auth is configured." : auth.ok ? "Existing CLI auth was not confirmed." : auth.error),
    check("wrapper", "Repo-scoped write wrapper", wrapperReady, wrapperReady ? "Tool-restricted print flags are available." : help.ok ? "Tool-restricted print flags were not confirmed." : help.error),
    check("workspace", "Workspace", workspaceReady, workspace.message),
    check("execution-policy", "Readiness execution policy", true, "Readiness inspects binary, auth, flags, and workspace without running an AI edit."),
  ];
  return cliReadinessResult("claudeCli", "claude", binaryReady ? probeText(version).split(/\r?\n/)[0] || "" : "", authReady, checks);
}

async function probeCodexBackedProviderReadiness(provider: AIProviderSettings | undefined, signal?: AbortSignal): Promise<AIEntryReadiness> {
  const providerCheck = provider ? providerReadiness(provider) : missingProviderStatus("AI API settings are required.");
  const connection = provider && providerCheck.state === "ready"
    ? await testAIConnection(provider, signal)
    : providerCheck;
  const checks = [
    check("provider", "Provider settings", providerCheck.state === "ready", providerCheck.message),
    check("endpoint", "Endpoint reachable", connection.state === "ready" && connection.code === "success", connection.message),
    check("execution-policy", "Execution policy", true, "Context-only provider execution is ready and cannot write repository files."),
  ];
  return providerReadinessResult("aiApi", provider, checks);
}

async function probeCodexBackedLocalReadiness(provider: AIProviderSettings | undefined, signal?: AbortSignal): Promise<AIEntryReadiness> {
  const providerCheck = provider ? providerReadiness(provider) : missingProviderStatus("Local AI settings are required.");
  const localSupported = provider?.runtime === "ollama" || provider?.runtime === "lmStudio";
  const connection = provider && localSupported && providerCheck.state === "ready"
    ? await testAIConnection(provider, signal)
    : providerCheck;
  const checks = [
    check("provider", "Local settings", providerCheck.state === "ready", providerCheck.message),
    check("local-provider", "Local provider", Boolean(localSupported), localSupported ? "Local provider is explicitly configured." : "Choose Ollama or LM Studio for Local AI."),
    check("endpoint", "Endpoint reachable", connection.state === "ready" && connection.code === "success", connection.message),
    check("execution-policy", "Execution policy", true, "Context-only local execution is ready and cannot write repository files."),
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

async function probeSubstrate(prepare: () => Promise<{ env: NodeJS.ProcessEnv }>): Promise<{ ok: boolean; message: string }> {
  try {
    const prepared = await prepare();
    if (!prepared.env.CODEX_HOME) return { ok: false, message: "Isolated CODEX_HOME was not prepared." };
    return { ok: true, message: "Isolated Codex substrate is prepared without using the default Codex auth store." };
  } catch (error) {
    return { ok: false, message: sanitizeCliText(error instanceof Error ? error.message : String(error)) };
  }
}

function probeText(result: { stdout: string; stderr: string }): string {
  return sanitizeCliText([result.stdout, result.stderr].filter(Boolean).join("\n"));
}

function cxHelpSupportsRepoWrite(help: string): boolean {
  return help.includes("--sandbox") && help.includes("workspace-write") && help.includes("--ephemeral") && help.includes("--json");
}

function cxExecutionSucceeded(stdout: string): boolean {
  return stdout.split(/\r?\n/).some((line) => {
    if (!line.trim()) return false;
    try {
      const event = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string } };
      return event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string" && event.item.text.trim().length > 0;
    } catch {
      return false;
    }
  });
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

function claudeExecutionSucceeded(stdout: string): boolean {
  try {
    const data = JSON.parse(stdout) as { is_error?: boolean; result?: string };
    return data.is_error !== true && typeof data.result === "string" && data.result.trim().length > 0;
  } catch {
    return false;
  }
}

function cliReadinessResult(entry: AICliEntryKind, binaryName: "codex" | "claude", version: string, authReady: boolean, checks: Check[]): AIEntryReadiness {
  const ready = checks.every((item) => item.status === "ready");
  const status = readinessStatus(ready, checks, ready ? `${entryLabel(entry)} repo-scoped write wrapper is ready.` : firstError(checks));
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
  const status = readinessStatus(ready, checks, ready ? `${entryLabel(entry)} context-only execution is ready.` : firstError(checks));
  return {
    entry,
    settings: { ...(provider || { entry, model: "", baseUrl: "", apiFormat: "openaiCompatible" }), entry } as AIProviderSettings,
    status,
    ready,
    checks,
  };
}

function experimentalWriteDisabled(entry: AICliEntryKind): AIEntryReadiness {
  const message = "CLI repository writes are disabled by default. Set READER_WIKI_EXPERIMENTAL_AI_WRITE=1 before startup only for isolated development testing.";
  const checkedAt = new Date().toISOString();
  return {
    entry,
    ready: false,
    status: {
      state: "failed",
      code: "wrapper_not_ready",
      severity: "warning",
      message,
      nextAction: "Use AI API or Local AI context-only mode for the public configuration.",
      checkedAt,
    },
    checks: [check("public-policy", "Public execution policy", false, message)],
    settings: {
      entry,
      binaryName: entry === "codexCli" ? "codex" : "claude",
      version: "",
      authState: "unknown",
      readOnlyWrapperState: "notReady",
      executionMode: "unknown",
      lastCheckedAt: checkedAt,
      readinessMessage: message,
    },
  };
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
    : failed?.id === "workspace"
      ? "workspace_not_ready"
      : failed?.id === "provider-support" || failed?.id === "local-provider"
        ? "unsupported_provider"
        : failed?.id === "auth-isolation"
          ? "substrate_missing"
          : "wrapper_not_ready";
  const nextAction = failed?.id === "auth"
    ? "Sign in with the CLI outside Reader-Wiki, then check readiness again."
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
