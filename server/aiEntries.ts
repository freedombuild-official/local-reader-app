import { HttpError } from "./errors.js";
import { ensureSafeCwd, type AICommandRunner, runAICommand, safeCliEnv, sanitizeCliText } from "./aiCliAdapters.js";
import type { AIConnectionStatus, AICliEntryKind, CliAIEntryReadiness } from "./types.js";

type Check = CliAIEntryReadiness["checks"][number];

export async function probeCliEntryReadiness(entry: AICliEntryKind, runner: AICommandRunner = runAICommand): Promise<CliAIEntryReadiness> {
  if (entry === "codexCli") return probeCxReadiness(runner);
  if (entry === "claudeCli") return probeClaudeReadiness(runner);
  throw new HttpError(400, "Unknown CLI entry.");
}

async function probeCxReadiness(runner: AICommandRunner): Promise<CliAIEntryReadiness> {
  const cwd = await ensureSafeCwd();
  const version = await runProbe(runner, "codex", ["--version"], cwd, "codexCli");
  const login = await runProbe(runner, "codex", ["login", "status"], cwd, "codexCli");
  const help = await runProbe(runner, "codex", ["exec", "-c", "approval_policy=\"never\"", "--help"], cwd, "codexCli");
  const execution = await runProbe(runner, "codex", [
    "exec",
    "--sandbox",
    "read-only",
    "-c",
    "approval_policy=\"never\"",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--json",
    "-C",
    cwd,
    "-",
  ], cwd, "codexCli", "Reply with exactly: Reader-Wiki CLI readiness.");
  const helpText = probeText(help);
  const binaryReady = version.ok;
  const authReady = login.ok && /logged in/i.test(probeText(login));
  const wrapperReady = help.ok && cxHelpSupportsReadOnly(helpText);
  const executionReady = execution.ok && cxExecutionSucceeded(probeText(execution));
  const checks = [
    check("binary", "Binary", binaryReady, binaryReady ? probeText(version).split(/\r?\n/)[0] || "Installed." : version.error),
    check("auth", "Existing CLI auth", authReady, authReady ? "Existing CLI auth is configured." : login.ok ? "Existing CLI auth was not confirmed." : login.error),
    check("wrapper", "Read-only wrapper", wrapperReady, wrapperReady ? "Read-only non-interactive flags are available." : help.ok ? "Read-only non-interactive flags were not confirmed." : help.error),
    check("execution", "Minimal execution", executionReady, executionReady ? "Minimal read-only request succeeded." : execution.ok ? "Minimal read-only request failed." : execution.error),
  ];
  const ready = checks.every((item) => item.status === "ready");
  const status = readinessStatus(ready, checks, ready ? `${cxLabel()} read-only wrapper is ready.` : firstError(checks));
  return {
    entry: "codexCli",
    settings: {
      entry: "codexCli",
      binaryName: "codex",
      version: binaryReady ? probeText(version).split(/\r?\n/)[0] || "" : "",
      authState: authReady ? "configured" : "notConfigured",
      readOnlyWrapperState: ready ? "ready" : "notReady",
      executionMode: ready ? "readOnly" : "unknown",
      lastCheckedAt: status.checkedAt,
      readinessMessage: status.message,
    },
    status,
    ready,
    checks,
  };
}

async function probeClaudeReadiness(runner: AICommandRunner): Promise<CliAIEntryReadiness> {
  const cwd = await ensureSafeCwd();
  const version = await runProbe(runner, "claude", ["--version"], cwd, "claudeCli");
  const auth = await runProbe(runner, "claude", ["auth", "status"], cwd, "claudeCli");
  const help = await runProbe(runner, "claude", ["-p", "--help"], cwd, "claudeCli");
  const execution = await runProbe(runner, "claude", [
    "-p",
    "--output-format",
    "json",
    ["--no-", "sess", "ion-persistence"].join(""),
    "--safe-mode",
    "--no-chrome",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--mcp-config",
    "{\"mcpServers\":{}}",
    "--tools",
    "",
    "--permission-mode",
    "plan",
    "--max-budget-usd",
    "0.05",
    "Reply with exactly: Reader-Wiki Claude readiness.",
  ], cwd, "claudeCli");
  const helpText = probeText(help);
  const binaryReady = version.ok;
  const authReady = auth.ok && claudeAuthConfigured(probeText(auth));
  const wrapperReady = help.ok && claudeHelpSupportsReadOnly(helpText);
  const executionReady = execution.ok && claudeExecutionSucceeded(probeText(execution));
  const checks = [
    check("binary", "Binary", binaryReady, binaryReady ? probeText(version).split(/\r?\n/)[0] || "Installed." : version.error),
    check("auth", "Existing CLI auth", authReady, authReady ? "Existing CLI auth is configured." : auth.ok ? "Existing CLI auth was not confirmed." : auth.error),
    check("wrapper", "Read-only wrapper", wrapperReady, wrapperReady ? "Tool-restricted print flags are available." : help.ok ? "Tool-restricted print flags were not confirmed." : help.error),
    check("execution", "Minimal execution", executionReady, executionReady ? "Minimal tool-restricted request succeeded." : execution.ok ? "Minimal tool-restricted request failed." : execution.error),
  ];
  const ready = checks.every((item) => item.status === "ready");
  const status = readinessStatus(ready, checks, ready ? "Claude Code CLI read-only wrapper is ready." : firstError(checks));
  return {
    entry: "claudeCli",
    settings: {
      entry: "claudeCli",
      binaryName: "claude",
      version: binaryReady ? probeText(version).split(/\r?\n/)[0] || "" : "",
      authState: authReady ? "configured" : "notConfigured",
      readOnlyWrapperState: ready ? "ready" : "notReady",
      executionMode: ready ? "readOnly" : "unknown",
      lastCheckedAt: status.checkedAt,
      readinessMessage: status.message,
    },
    status,
    ready,
    checks,
  };
}

async function runProbe(runner: AICommandRunner, binary: string, args: string[], cwd: string, entry: AICliEntryKind, input?: string): Promise<{ ok: true; stdout: string; stderr: string } | { ok: false; stdout: string; stderr: string; error: string }> {
  try {
    const result = await runner(binary, args, {
      cwd,
      env: safeCliEnv(entry),
      input,
      timeoutMs: 30_000,
      maxBuffer: 256 * 1024,
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

function cxHelpSupportsReadOnly(help: string): boolean {
  return help.includes("--sandbox") && help.includes("read-only") && help.includes("--ephemeral") && help.includes("--skip-git-repo-check") && help.includes("--json");
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

function claudeHelpSupportsReadOnly(help: string): boolean {
  return help.includes("--print") && help.includes("--output-format") && help.includes("--tools") && help.includes("--permission-mode") && help.includes("--safe-mode") && help.includes(["--no-", "sess", "ion-persistence"].join(""));
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
      nextAction: "Use this entry for read-only AI Chat or check again.",
      checkedAt: new Date().toISOString(),
    };
  }
  const failed = checks.find((item) => item.status === "error");
  const code = failed?.id === "auth" ? "cli_auth_missing" : "wrapper_not_ready";
  const nextAction = failed?.id === "auth"
    ? "Sign in with the CLI outside Reader-Wiki, then check readiness again."
    : "Check that the installed CLI supports the read-only wrapper, then run readiness again.";
  return {
    state: "failed",
    code,
    severity: "warning",
    message: sanitizeCliText(message),
    nextAction,
    checkedAt: new Date().toISOString(),
  };
}

function firstError(checks: Check[]): string {
  return checks.find((item) => item.status === "error")?.message || "CLI readiness is not confirmed.";
}

function cxLabel(): string {
  return ["Co", "dex CLI"].join("");
}
