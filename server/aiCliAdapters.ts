import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HttpError } from "./errors.js";
import type { AIChatContext, AIChatMessage, AIConnectionStatus, AICliEntryKind } from "./types.js";

type CliChatRequest = {
  entry: AICliEntryKind;
  messages: AIChatMessage[];
  context: AIChatContext;
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

const CLI_TIMEOUT_MS = 90_000;
const CLI_MAX_BUFFER = 1024 * 1024;

export async function requestCliAIChatCompletion(request: CliChatRequest): Promise<{ content: string; status: AIConnectionStatus }> {
  const runner = request.runner || runAICommand;
  const cwd = await ensureSafeCwd();
  const prompt = buildCliPrompt(request.context, request.messages);
  try {
    const result = request.entry === "codexCli"
      ? await runCxChat(runner, cwd, prompt)
      : await runClaudeChat(runner, cwd, prompt);
    const content = sanitizeCliText(result).trim();
    if (!content) throw new HttpError(502, "CLI adapter returned an empty response.");
    return { content, status: status("ready", "CLI response received.") };
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

export function safeCliEnv(_entry: AICliEntryKind): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "HOME",
    "PATH",
    "LANG",
    "LC_ALL",
    "TERM",
    "CODEX_HOME",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.READER_WIKI_AI_CLI = "1";
  return env;
}

function buildCliPrompt(context: AIChatContext, messages: AIChatMessage[]): string {
  const transcript = messages.map((message) => `${message.role === "assistant" ? "Assistant" : "User"}: ${message.content}`).join("\n\n");
  const metadata = [
    "You are answering inside Reader-Wiki AI Chat.",
    "Use only the read-only context below.",
    "Do not run shell commands, edit files, request external browser actions, or ask for credentials.",
    "Do not infer local absolute paths.",
    `Repository ID: ${context.repoId}`,
    `Repository-relative path: ${context.path}`,
    `File name: ${context.fileName}`,
    `File kind: ${context.fileKind}`,
    `Viewer status: ${context.viewerStatus}`,
    `Line count: ${context.lineCount}`,
    `Byte length: ${context.byteLength}`,
  ].join("\n");
  const content = context.contentIncluded ? context.content : "File content was not included.";
  return `${metadata}\n\nFile content:\n${content}\n\nConversation:\n${transcript}\n\nAnswer concisely from the file context.`;
}

async function runCxChat(runner: AICommandRunner, cwd: string, prompt: string): Promise<string> {
  const result = await runner("codex", [
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
  ], {
    cwd,
    env: safeCliEnv("codexCli"),
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
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .slice(0, 12000);
}

function status(state: AIConnectionStatus["state"], message: string): AIConnectionStatus {
  return { state, message, checkedAt: new Date().toISOString() };
}
