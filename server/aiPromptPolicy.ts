import { readFileSync } from "node:fs";
import path from "node:path";
import type { AIChatAttachment, AIChatContext, AIChatContextItem, AIChatMessage, AIModelBehavior } from "./types.js";

export type AIChatSystemPrompt = {
  version: string;
  body: string;
};

export type AIChatRuntimePrompt = {
  systemPrompt: string;
  systemPromptVersion: string;
  contextPrompt: string;
};

const DEFAULT_PROMPT_PATH = path.join(process.cwd(), "prompts", "ai-chat-system.md");
const DEFAULT_PROMPT_VERSION = "2.2.0";
const MAX_ATTACHMENT_CONTEXT_CHARS = 12000;

export function loadAIChatSystemPrompt(): AIChatSystemPrompt {
  const customPromptPath = process.env.READER_WIKI_AI_CHAT_SYSTEM_PROMPT;
  const promptPath = aiChatSystemPromptPath();
  const raw = readFileSync(promptPath, "utf8");
  return parseMarkdownPrompt(raw, promptPath, customPromptPath ? undefined : DEFAULT_PROMPT_VERSION);
}

export function aiChatSystemPromptPath(): string {
  return process.env.READER_WIKI_AI_CHAT_SYSTEM_PROMPT || DEFAULT_PROMPT_PATH;
}

export function buildAIChatRuntimePrompt(
  context: AIChatContext,
  attachments: AIChatAttachment[] = [],
  modelBehavior: AIModelBehavior | undefined = undefined,
): AIChatRuntimePrompt {
  const system = loadAIChatSystemPrompt();
  return {
    systemPrompt: system.body,
    systemPromptVersion: system.version,
    contextPrompt: [
      formatContextGroup("Repository rules", context.ruleItems),
      formatContextGroup("Selected paths", context.primaryItems),
      modelBehaviorPrompt(modelBehavior),
      attachmentsPrompt(attachments),
    ].filter(Boolean).join("\n\n"),
  };
}

export function buildConversationTranscript(messages: AIChatMessage[]): string {
  return messages.map((message) => `${message.role === "assistant" ? "Assistant" : "User"}: ${message.content}`).join("\n\n");
}

function parseMarkdownPrompt(raw: string, promptPath: string, fallbackVersion?: string): AIChatSystemPrompt {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    const body = raw.trim();
    if (fallbackVersion && body) return { version: fallbackVersion, body };
    throw new Error(`AI Chat system prompt is missing frontmatter: ${promptPath}`);
  }
  const frontmatter = match[1];
  const body = match[2].trim();
  const versionMatch = frontmatter.match(/^version:\s*['"]?([^'"\n]+)['"]?\s*$/m);
  const version = versionMatch?.[1]?.trim() || "";
  if (!version) throw new Error(`AI Chat system prompt frontmatter is missing version: ${promptPath}`);
  if (!body) throw new Error(`AI Chat system prompt body is empty: ${promptPath}`);
  return { version, body };
}

function formatContextGroup(title: string, items: AIChatContextItem[]): string {
  if (!items.length) return "";
  return `${title}:\n${items.map((item, index) => formatContextItem(item, index)).join("\n\n")}`;
}

function formatContextItem(item: AIChatContextItem, index: number): string {
  const metadata = [
    `Item ${index + 1}`,
    `Repository ID: ${item.repoId}`,
    `Repository-relative path: ${item.path}`,
    `Context role: ${item.role}`,
    `Context source: ${item.source}`,
    `Path kind: ${item.kind}`,
    item.fileKind ? `File kind: ${item.fileKind}` : "",
    `Viewer status: ${item.viewerStatus}`,
    `Line count: ${item.lineCount}`,
    `Byte length: ${item.byteLength}`,
    `Content included: ${item.contentIncluded ? "yes" : "no"}`,
  ].filter(Boolean).join("\n");
  if (!item.contentIncluded) return metadata;
  const label = item.kind === "directory" ? "Direct child listing" : "Content";
  return `${metadata}\n${label}:\n${item.content}`;
}

function modelBehaviorPrompt(modelBehavior: AIModelBehavior | undefined): string {
  if (!modelBehavior || modelBehavior.kind === "none") return "";
  if (modelBehavior.kind === "intelligence") return `Requested response depth: ${modelBehavior.level}.`;
  return `Thinking mode: ${modelBehavior.enabled ? "enabled" : "disabled"}. Do not reveal hidden reasoning; provide only the final answer.`;
}

function attachmentsPrompt(attachments: AIChatAttachment[]): string {
  const items = attachments.slice(0, 5).map((attachment, index) => {
    const metadata = `Attachment ${index + 1}: ${attachment.name} (${attachment.mimeType || "unknown"}, ${attachment.sizeBytes} bytes, ${attachment.contentIncluded ? "content included" : "metadata only"})`;
    if (!attachment.contentIncluded) return metadata;
    return `${metadata}\n${attachment.content.slice(0, MAX_ATTACHMENT_CONTEXT_CHARS)}`;
  });
  return items.length ? `Session-only attachments:\n${items.join("\n\n")}` : "";
}
