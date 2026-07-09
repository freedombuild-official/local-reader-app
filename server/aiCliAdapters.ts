import { execFile } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HttpError } from "./errors.js";
import { buildAIChatRuntimePrompt, buildConversationTranscript } from "./aiPromptPolicy.js";
import type {
  AIChangedPath,
  AIChatAttachment,
  AIChatContext,
  AIChatExecutionTarget,
  AIChatMessage,
  AIChatRunSummary,
  AIConnectionStatus,
  AIEntryKind,
  AIModelBehavior,
  AIProviderSettings,
  GitStatus,
  RepositoryConfig,
} from "./types.js";

type RepoWriteChatRequest = {
  target: AIChatExecutionTarget;
  messages: AIChatMessage[];
  context: AIChatContext;
  repo: RepositoryConfig;
  attachments?: AIChatAttachment[];
  modelBehavior?: AIModelBehavior;
  runner?: AICommandRunner;
};

export type AICommandRunner = (binary: string, args: string[], options: AICommandOptions) => Promise<AICommandResult>;

export type AICommandOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs: number;
  maxBuffer: number;
};

export type AICommandResult = {
  stdout: string;
  stderr: string;
};

export type AIWorkspace = {
  repoId: string;
  root: string;
};

const CLI_TIMEOUT_MS = 120_000;
const CLI_MAX_BUFFER = 1024 * 1024;

export async function requestRepoWriteAIChatCompletion(request: RepoWriteChatRequest): Promise<{ content: string; status: AIConnectionStatus; run: AIChatRunSummary }> {
  const runner = request.runner || runAICommand;
  const workspace = await resolveAIWorkspace(request.repo);
  const before = await collectGitChangedPaths(workspace.root);
  const prompt = buildRepoWritePrompt(request.context, request.messages, request.attachments || [], request.modelBehavior);
  const entry = targetEntry(request.target);
  const substrate = targetSubstrate(request.target);
  try {
    const result = substrate === "codexCli"
      ? await runCodexChat(runner, request.target, workspace.root, prompt)
      : await runClaudeChat(runner, workspace.root, prompt);
    const content = sanitizeCliText(result).trim();
    if (!content) throw new HttpError(502, "CLI adapter returned an empty response.");
    const changedPaths = diffChangedPaths(before, await collectGitChangedPaths(workspace.root));
    return {
      content,
      status: status("ready", "CLI response received."),
      run: {
        accessMode: "repoWrite",
        entry,
        substrate,
        changedPaths,
        warnings: changedPaths.length ? [] : ["No repository changes were detected."],
      },
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpError(502, sanitizeCliText(message) || "CLI adapter failed.");
  }
}

export function runAICommand(binary: string, args: string[], options: AICommandOptions): Promise<AICommandResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(binary, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      maxBuffer: options.maxBuffer,
    }, (error, stdout, stderr) => {
      const result = { stdout: String(stdout || ""), stderr: String(stderr || "") };
      if (error) {
        const output = sanitizeCliText([result.stdout, result.stderr, error.message].filter(Boolean).join("\n"));
        reject(new HttpError(502, output || "CLI adapter failed."));
        return;
      }
      resolve(result);
    });
    if (options.input) {
      child.stdin?.end(options.input);
    }
  });
}

export async function ensureSafeCwd(): Promise<string> {
  const cwd = path.join(tmpdir(), "reader-wiki-ai-cli-cwd");
  await mkdir(cwd, { recursive: true });
  return cwd;
}

export async function resolveAIWorkspace(repo: RepositoryConfig): Promise<AIWorkspace> {
  const root = await realpath(repo.root);
  const inside = await runLocalCommand("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], root).catch((error) => {
    throw new HttpError(409, sanitizeCliText(error instanceof Error ? error.message : String(error)) || "Repository write requires a Git working tree.");
  });
  if (!/^true\s*$/i.test(inside.stdout)) throw new HttpError(409, "Repository write requires a Git working tree.");
  return { repoId: repo.id, root };
}

export function safeCliEnv(entry: AIEntryKind, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "HOME",
    "PATH",
    "LANG",
    "LC_ALL",
    "TERM",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if ((entry === "codexCli" || entry === "claudeCli") && process.env.CODEX_HOME) {
    env.CODEX_HOME = process.env.CODEX_HOME;
  }
  env.READER_WIKI_AI_CLI = "1";
  return { ...env, ...extra };
}

export async function collectGitChangedPaths(cwd: string): Promise<AIChangedPath[]> {
  const result = await runLocalCommand("git", ["-C", cwd, "status", "--porcelain=v1", "-z"], cwd);
  const tokens = result.stdout.split("\0").filter(Boolean);
  const paths: AIChangedPath[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] || "";
    const statusText = token.slice(0, 2);
    const rawPath = token.slice(3);
    if (!rawPath) continue;
    if (statusText.includes("R") || statusText.includes("C")) index += 1;
    paths.push({ path: normalizeGitPath(rawPath), status: gitStatus(statusText) });
  }
  return paths;
}

function buildRepoWritePrompt(context: AIChatContext, messages: AIChatMessage[], attachments: AIChatAttachment[], modelBehavior: AIModelBehavior | undefined): string {
  const runtime = buildAIChatRuntimePrompt(context, attachments, modelBehavior);
  const transcript = buildConversationTranscript(messages);
  return [
    runtime.systemPrompt,
    runtime.contextPrompt,
    transcript ? `Conversation:\n${transcript}` : "Conversation: [no prior messages]",
    [
      "Reader-Wiki execution policy:",
      "- You may edit files only inside the active repository root.",
      "- Do not write outside the repository root, follow symlinks outside it, edit .git internals, or perform Git commit/push/pull/fetch/checkout/merge/reset/rebase/tag/branch operations.",
      "- Report changed repository-relative paths in your final answer.",
      "- Never reveal local absolute filesystem paths.",
    ].join("\n"),
  ].filter(Boolean).join("\n\n");
}

async function runCodexChat(runner: AICommandRunner, target: AIChatExecutionTarget, cwd: string, prompt: string): Promise<string> {
  const substrate = target.kind === "codexBackedProvider" ? await codexProviderSubstrate(target.provider) : target.kind === "codexBackedLocal" ? await codexLocalSubstrate(target.provider) : { args: [], env: safeCliEnv("codexCli") };
  const result = await runner("codex", [
    "exec",
    ...substrate.args,
    "--sandbox",
    "workspace-write",
    "-c",
    "approval_policy=\"never\"",
    "--ephemeral",
    "--json",
    "-C",
    cwd,
    "-",
  ], {
    cwd,
    env: substrate.env,
    input: prompt,
    timeoutMs: CLI_TIMEOUT_MS,
    maxBuffer: CLI_MAX_BUFFER,
  });
  return parseCxJsonl(result.stdout);
}

async function runClaudeChat(runner: AICommandRunner, cwd: string, prompt: string): Promise<string> {
  const result = await runner("claude", [
    "-p",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--safe-mode",
    "--no-chrome",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--mcp-config",
    "{\"mcpServers\":{}}",
    "--tools",
    "Read,Edit,Write",
    "--disallowedTools",
    "Bash",
    "--permission-mode",
    "acceptEdits",
    "--max-budget-usd",
    "0.25",
  ], {
    cwd,
    env: safeCliEnv("claudeCli"),
    input: prompt,
    timeoutMs: CLI_TIMEOUT_MS,
    maxBuffer: CLI_MAX_BUFFER,
  });
  return parseClaudeJson(result.stdout);
}

export async function codexProviderSubstrate(provider: AIProviderSettings): Promise<{ args: string[]; env: NodeJS.ProcessEnv }> {
  const home = await ensureIsolatedCodexHome(provider.entry);
  const envKey = "READER_WIKI_AI_API_KEY";
  const profile = "reader-wiki-ai-api";
  await writeFile(path.join(home, `${profile}.config.toml`), buildCodexProviderProfile(provider, envKey), "utf8");
  return {
    args: ["--profile", profile],
    env: safeCliEnv(provider.entry, { CODEX_HOME: home, [envKey]: provider.credential || "" }),
  };
}

export async function codexLocalSubstrate(provider: AIProviderSettings): Promise<{ args: string[]; env: NodeJS.ProcessEnv }> {
  const localProvider = provider.runtime === "lmStudio" ? "lmstudio" : provider.runtime === "ollama" ? "ollama" : "";
  if (!localProvider) throw new HttpError(400, "Local AI write mode supports Ollama and LM Studio through Codex CLI.");
  const home = await ensureIsolatedCodexHome(provider.entry);
  return {
    args: ["--oss", "--local-provider", localProvider, "--model", provider.model],
    env: safeCliEnv(provider.entry, { CODEX_HOME: home }),
  };
}

async function ensureIsolatedCodexHome(entry: AIEntryKind): Promise<string> {
  const home = path.join(tmpdir(), "reader-wiki-codex-home", entry);
  await mkdir(home, { recursive: true });
  return home;
}

function buildCodexProviderProfile(provider: AIProviderSettings, envKey: string): string {
  const baseUrl = (provider.baseUrl || "").trim().replace(/\/+$/, "");
  const wireApi = provider.apiFormat === "openaiCompatible" || provider.provider === "openaiCompatible" || provider.provider === "openai" ? "chat" : "chat";
  return [
    `model = ${tomlString(provider.model)}`,
    "model_provider = \"reader_wiki_ai_api\"",
    "",
    "[model_providers.reader_wiki_ai_api]",
    "name = \"Reader-Wiki AI API\"",
    `base_url = ${tomlString(baseUrl)}`,
    `env_key = ${tomlString(envKey)}`,
    `wire_api = ${tomlString(wireApi)}`,
    "",
  ].join("\n");
}

function parseCxJsonl(stdout: string): string {
  let last = "";
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string } };
      if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
        last = event.item.text;
      }
    } catch {
      if (!last) last = line;
    }
  }
  return last || stdout;
}

function parseClaudeJson(stdout: string): string {
  const data = JSON.parse(stdout || "{}") as { is_error?: boolean; result?: string };
  if (data.is_error) throw new HttpError(502, sanitizeCliText(data.result || "Claude Code CLI request failed."));
  return data.result || "";
}

function diffChangedPaths(before: AIChangedPath[], after: AIChangedPath[]): AIChangedPath[] {
  const beforeMap = new Map(before.map((item) => [item.path, item.status]));
  return after.filter((item) => beforeMap.get(item.path) !== item.status || !beforeMap.has(item.path));
}

function gitStatus(statusText: string): GitStatus {
  if (statusText.includes("D")) return "deleted";
  if (statusText.includes("?")) return "new";
  if (statusText.includes("A")) return "new";
  return "changed";
}

function normalizeGitPath(rawPath: string): string {
  return rawPath.replace(/^.* -> /, "").replace(/\\/g, "/");
}

function targetEntry(target: AIChatExecutionTarget): AIEntryKind {
  if (target.kind === "codexCli" || target.kind === "claudeCli") return target.entry;
  return target.provider.entry;
}

function targetSubstrate(target: AIChatExecutionTarget): "codexCli" | "claudeCli" {
  return target.kind === "claudeCli" ? "claudeCli" : "codexCli";
}

function runLocalCommand(binary: string, args: string[], cwd: string): Promise<AICommandResult> {
  return runAICommand(binary, args, {
    cwd,
    env: safeCliEnv("codexCli"),
    timeoutMs: 30_000,
    maxBuffer: 256 * 1024,
  });
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function sanitizeCliText(value: string): string {
  return value
    .replace(new RegExp(`"${["sess", "ion_id"].join("")}"\\s*:\\s*"[^"]*"`, "g"), `"${["sess", "ion_id"].join("")}":"[redacted]"`)
    .replace(/"uuid"\s*:\s*"[^"]*"/g, "\"uuid\":\"[redacted]\"")
    .replace(/Command failed: (codex|claude)[^\n]*/g, "Command failed: CLI invocation")
    .replace(new RegExp(["in-process app", "server client"].join("-"), "g"), "CLI runtime client")
    .replace(/\/var\/folders\/[^\s]+/g, "[local-temp]")
    .replace(/\/private\/tmp\/[^\s]+/g, "[local-temp]")
    .replace(/\/Users\/[^/\s]+/g, "[local-home]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/(READER_WIKI_AI_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|CODEX_API_KEY)=\S+/g, "$1=[redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .slice(0, 12000);
}

function status(state: AIConnectionStatus["state"], message: string): AIConnectionStatus {
  return {
    state,
    code: state === "ready" ? "success" : "provider_http_error",
    severity: state === "ready" ? "success" : "error",
    message,
    nextAction: state === "ready" ? "Continue the conversation or check readiness again if CLI settings change." : "Check CLI readiness before trying again.",
    checkedAt: new Date().toISOString(),
  };
}
