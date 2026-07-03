import { HttpError } from "./errors.js";
import type { AIChatContext, AIChatMessage, AIConnectionStatus, AIProviderSettings } from "./types.js";

type ProviderRequest = {
  provider: AIProviderSettings;
  messages?: AIChatMessage[];
  context?: AIChatContext;
  signal?: AbortSignal;
};

const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com",
  ollama: "http://127.0.0.1:11434/v1",
  lmStudio: "http://127.0.0.1:1234/v1",
  openaiLocal: "http://127.0.0.1:8000/v1",
};

export async function testAIConnection(provider: AIProviderSettings, signal?: AbortSignal): Promise<AIConnectionStatus> {
  const readiness = providerReadiness(provider);
  if (readiness.state !== "ready") return readiness;
  try {
    await requestProviderText({
      provider,
      messages: [{ role: "user", content: "Reply with Reader-Wiki ready." }],
      signal,
    });
    return status("ready", "Connection test completed.");
  } catch (error) {
    return status("failed", safeProviderError(error));
  }
}

export async function requestAIChatCompletion(request: ProviderRequest): Promise<{ content: string; status: AIConnectionStatus }> {
  const readiness = providerReadiness(request.provider);
  if (readiness.state !== "ready") throw new HttpError(400, readiness.message);
  const content = await requestProviderText(request);
  return { content, status: status("ready", "Response received.") };
}

export function providerReadiness(provider: AIProviderSettings): AIConnectionStatus {
  if (!provider.entry) return status("notConfigured", "Select an AI entry.");
  if (!provider.model.trim()) return status("notConfigured", "Model is required.");
  if (provider.entry === "aiApi" && !provider.credential?.trim()) {
    return status("notConfigured", "API key is required for AI API.");
  }
  const baseUrl = providerBaseUrl(provider);
  if (!baseUrl) return status("notConfigured", "Endpoint is required.");
  try {
    new URL(baseUrl);
  } catch {
    return status("failed", "Endpoint URL is invalid.");
  }
  return status("ready", "Provider settings are ready.");
}

async function requestProviderText({ provider, messages = [], context, signal }: ProviderRequest): Promise<string> {
  const baseUrl = providerBaseUrl(provider).replace(/\/+$/, "");
  if (provider.apiFormat === "anthropic" || provider.provider === "anthropic") {
    return requestAnthropicText(baseUrl, provider, messages, context, signal);
  }
  if (provider.apiFormat === "google" || provider.provider === "google") {
    return requestGoogleText(baseUrl, provider, messages, context, signal);
  }
  return requestOpenAICompatibleText(baseUrl, provider, messages, context, signal);
}

async function requestOpenAICompatibleText(
  baseUrl: string,
  provider: AIProviderSettings,
  messages: AIChatMessage[],
  context: AIChatContext | undefined,
  signal: AbortSignal | undefined,
): Promise<string> {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(provider.credential ? { Authorization: `Bearer ${provider.credential}` } : {}),
    },
    body: JSON.stringify({
      model: provider.model,
      messages: buildOpenAIMessages(messages, context),
    }),
    signal,
  });
  const data = (await response.json().catch(() => ({}))) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
  if (!response.ok) throw new Error(data.error?.message || `Provider returned HTTP ${response.status}.`);
  return data.choices?.[0]?.message?.content || "";
}

async function requestAnthropicText(
  baseUrl: string,
  provider: AIProviderSettings,
  messages: AIChatMessage[],
  context: AIChatContext | undefined,
  signal: AbortSignal | undefined,
): Promise<string> {
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": provider.credential || "",
    },
    body: JSON.stringify({
      model: provider.model,
      messages: buildAnthropicMessages(messages, context),
    }),
    signal,
  });
  const data = (await response.json().catch(() => ({}))) as { content?: Array<{ text?: string }>; error?: { message?: string } };
  if (!response.ok) throw new Error(data.error?.message || `Provider returned HTTP ${response.status}.`);
  return data.content?.map((item) => item.text || "").join("\n").trim() || "";
}

async function requestGoogleText(
  baseUrl: string,
  provider: AIProviderSettings,
  messages: AIChatMessage[],
  context: AIChatContext | undefined,
  signal: AbortSignal | undefined,
): Promise<string> {
  const url = new URL(`${baseUrl}/v1beta/models/${encodeURIComponent(provider.model)}:generateContent`);
  if (provider.credential) url.searchParams.set("key", provider.credential);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: buildGoogleMessages(messages, context),
    }),
    signal,
  });
  const data = (await response.json().catch(() => ({}))) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; error?: { message?: string } };
  if (!response.ok) throw new Error(data.error?.message || `Provider returned HTTP ${response.status}.`);
  return data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("\n").trim() || "";
}

function buildOpenAIMessages(messages: AIChatMessage[], context: AIChatContext | undefined): AIChatMessage[] {
  return [
    { role: "user", content: systemContextPrompt(context) },
    ...messages,
  ];
}

function buildAnthropicMessages(messages: AIChatMessage[], context: AIChatContext | undefined): Array<{ role: "user" | "assistant"; content: string }> {
  return [
    { role: "user", content: systemContextPrompt(context) },
    ...messages,
  ];
}

function buildGoogleMessages(messages: AIChatMessage[], context: AIChatContext | undefined): Array<{ role: string; parts: Array<{ text: string }> }> {
  return [
    { role: "user", parts: [{ text: systemContextPrompt(context) }] },
    ...messages.map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] })),
  ];
}

function systemContextPrompt(context: AIChatContext | undefined): string {
  if (!context) return "You are helping with a local Reader-Wiki file. Do not request shell access or file changes.";
  const metadata = [
    `Repository: ${context.repoId}`,
    `Path: ${context.path}`,
    `Kind: ${context.fileKind}`,
    `Viewer status: ${context.viewerStatus}`,
    `Lines: ${context.lineCount}`,
    `Bytes: ${context.byteLength}`,
  ].join("\n");
  if (!context.contentIncluded) {
    return `${metadata}\n\nThe file content is not included. Use only the metadata above. Do not request shell access or file changes.`;
  }
  return `${metadata}\n\nFile content:\n${context.content}\n\nAnswer from this read-only context. Do not request shell access or file changes.`;
}

function providerBaseUrl(provider: AIProviderSettings): string {
  if (provider.baseUrl.trim()) return provider.baseUrl.trim();
  if (provider.entry === "localAi" && provider.runtime) return DEFAULT_BASE_URLS[provider.runtime] || "";
  if (provider.provider) return DEFAULT_BASE_URLS[provider.provider] || "";
  return "";
}

function status(state: AIConnectionStatus["state"], message: string): AIConnectionStatus {
  return { state, message, checkedAt: new Date().toISOString() };
}

function safeProviderError(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "Connection test was canceled.";
  if (error instanceof Error && error.message) return error.message;
  return "Provider request failed.";
}
