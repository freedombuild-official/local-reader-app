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

class ProviderHttpError extends Error {
  constructor(readonly responseStatus: number) {
    super(`Provider HTTP ${responseStatus}`);
    this.name = "ProviderHttpError";
  }
}

class ProviderAbortError extends Error {
  constructor(message = "Connection timed out or was canceled.") {
    super(message);
    this.name = "ProviderAbortError";
  }
}

export async function testAIConnection(provider: AIProviderSettings, signal?: AbortSignal): Promise<AIConnectionStatus> {
  const readiness = providerReadiness(provider);
  if (readiness.state !== "ready") return readiness;
  try {
    return await withTimeout(signal, async (timeoutSignal) => {
      const modelVisibility = await testModelVisibility(provider, timeoutSignal);
      if (modelVisibility) return modelVisibility;
      await requestProviderText({
        provider,
        messages: [{ role: "user", content: "Reply with Reader-Wiki ready." }],
        signal: timeoutSignal,
      });
      return status("ready", "success", "success", "Connected.", "This entry is ready for read-only AI Chat.");
    });
  } catch (error) {
    return safeProviderErrorStatus(error);
  }
}

export async function requestAIChatCompletion(request: ProviderRequest): Promise<{ content: string; status: AIConnectionStatus }> {
  const readiness = providerReadiness(request.provider);
  if (readiness.state !== "ready") throw new HttpError(400, readiness.message);
  try {
    const content = await requestProviderText(request);
    return { content, status: status("ready", "success", "success", "Response received.", "Continue the conversation or test again if the endpoint changes.") };
  } catch (error) {
    const failed = safeProviderErrorStatus(error);
    throw new HttpError(502, failed.message);
  }
}

export function providerReadiness(provider: AIProviderSettings): AIConnectionStatus {
  if (!provider.entry) return status("notConfigured", "not_configured", "info", "Select an AI entry.", "Choose an AI Entry.");
  if (!provider.model.trim()) return status("notConfigured", "not_configured", "warning", "Model is required.", "Enter the model name shown by your provider.");
  if (provider.entry === "aiApi" && !provider.credential?.trim()) {
    return status("notConfigured", "credential_required", "warning", "API credential is required.", "Enter the provider credential, then test the connection.");
  }
  const baseUrl = providerBaseUrl(provider);
  if (!baseUrl) return status("notConfigured", "not_configured", "warning", "Endpoint is required.", "Enter the endpoint URL.");
  try {
    new URL(baseUrl);
  } catch {
    return status("failed", "invalid_endpoint", "error", "Endpoint URL is invalid.", "Check the endpoint URL format.");
  }
  return status("ready", "needs_test", "info", "Connection can be tested.", "Run Test connection before using this entry.");
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
  if (!response.ok) throw new ProviderHttpError(response.status);
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
  if (!response.ok) throw new ProviderHttpError(response.status);
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
  if (!response.ok) throw new ProviderHttpError(response.status);
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

async function testModelVisibility(provider: AIProviderSettings, signal: AbortSignal | undefined): Promise<AIConnectionStatus | null> {
  if (provider.apiFormat !== "openaiCompatible" && provider.provider !== "openaiCompatible" && provider.entry !== "localAi") return null;
  const baseUrl = providerBaseUrl(provider).replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/models`, {
    method: "GET",
    headers: {
      ...(provider.credential ? { Authorization: `Bearer ${provider.credential}` } : {}),
    },
    signal,
  });
  if (response.status === 404 || response.status === 405) return null;
  if (!response.ok) throw new ProviderHttpError(response.status);
  const data = (await response.json().catch(() => ({}))) as { data?: Array<{ id?: string }> };
  const ids = (data.data || []).map((item) => item.id || "").filter(Boolean);
  if (ids.length && !ids.includes(provider.model)) {
    return status("failed", "model_missing", "warning", "Model is not visible at this endpoint.", "Check the model name or load it in your local runtime outside Reader-Wiki.");
  }
  return null;
}

async function withTimeout<T>(inputSignal: AbortSignal | undefined, work: (signal: AbortSignal | undefined) => Promise<T>): Promise<T> {
  if (inputSignal?.aborted) throw new ProviderAbortError();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new ProviderAbortError()), 15_000);
  });
  const abortPromise = new Promise<never>((_, reject) => {
    abort = () => reject(new ProviderAbortError("Connection test was canceled."));
    inputSignal?.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([work(inputSignal), timeoutPromise, abortPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (abort) inputSignal?.removeEventListener("abort", abort);
  }
}

function status(
  state: AIConnectionStatus["state"],
  code: NonNullable<AIConnectionStatus["code"]>,
  severity: NonNullable<AIConnectionStatus["severity"]>,
  message: string,
  nextAction: string,
): AIConnectionStatus {
  return { state, code, severity, message, nextAction, checkedAt: new Date().toISOString() };
}

function safeProviderErrorStatus(error: unknown): AIConnectionStatus {
  if (error instanceof ProviderAbortError || (error instanceof Error && error.name === "AbortError")) {
    return status("failed", "timeout_or_abort", "warning", "Connection timed out or was canceled.", "Check that the endpoint is reachable, then test again.");
  }
  if (error instanceof ProviderHttpError) {
    if (error.responseStatus === 401 || error.responseStatus === 403) {
      return status("failed", "credential_required", "warning", "Provider rejected the credential.", "Check the provider credential and access for this model.");
    }
    if (error.responseStatus === 404) {
      return status("failed", "model_missing", "warning", "Model or endpoint was not found.", "Check the endpoint URL and model name.");
    }
    return status("failed", "provider_http_error", "error", `Provider returned HTTP ${error.responseStatus}.`, "Check provider status, endpoint settings, and model access.");
  }
  if (error instanceof TypeError) {
    return status("failed", "endpoint_unreachable", "error", "Endpoint is unreachable.", "Check that the server is running and the endpoint URL is correct.");
  }
  return status("failed", "provider_http_error", "error", "Provider request failed.", "Check endpoint settings and test again.");
}
