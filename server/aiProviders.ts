import { HttpError } from "./errors.js";
import { buildAIChatRuntimePrompt } from "./aiPromptPolicy.js";
import type { AIChatAttachment, AIChatContext, AIChatMessage, AIConnectionStatus, AIModelBehavior, AIProviderSettings } from "./types.js";

type ProviderRequest = {
  provider: AIProviderSettings;
  messages?: AIChatMessage[];
  context?: AIChatContext;
  attachments?: AIChatAttachment[];
  modelBehavior?: AIModelBehavior;
  signal?: AbortSignal;
};

type ProviderChatMessage = { role: "system" | "user" | "assistant"; content: string };

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
      return status("ready", "success", "success", "Connected.", "This provider endpoint is reachable. Run AI Entry readiness to confirm Codex-backed write mode.");
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

export async function requestAIChatCompletionStream(request: ProviderRequest, onDelta: (content: string) => void): Promise<{ content: string; status: AIConnectionStatus }> {
  const readiness = providerReadiness(request.provider);
  if (readiness.state !== "ready") throw new HttpError(400, readiness.message);
  try {
    const baseUrl = providerBaseUrl(request.provider).replace(/\/+$/, "");
    const content = request.provider.apiFormat === "openaiCompatible" || request.provider.provider === "openaiCompatible" || request.provider.provider === "openai" || request.provider.entry === "localAi"
      ? await requestOpenAICompatibleTextStream(baseUrl, request.provider, request.messages || [], request.context, request.attachments || [], request.modelBehavior, request.signal, onDelta)
      : await requestProviderText(request);
    if (!(request.provider.apiFormat === "openaiCompatible" || request.provider.provider === "openaiCompatible" || request.provider.provider === "openai" || request.provider.entry === "localAi")) {
      onDelta(content);
    }
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
  return status("ready", "needs_test", "info", "Connection can be tested.", "Run AI Entry readiness before using this entry.");
}

async function requestProviderText({ provider, messages = [], context, attachments = [], modelBehavior, signal }: ProviderRequest): Promise<string> {
  const baseUrl = providerBaseUrl(provider).replace(/\/+$/, "");
  if (provider.apiFormat === "anthropic" || provider.provider === "anthropic") {
    return requestAnthropicText(baseUrl, provider, messages, context, attachments, modelBehavior, signal);
  }
  if (provider.apiFormat === "google" || provider.provider === "google") {
    return requestGoogleText(baseUrl, provider, messages, context, attachments, modelBehavior, signal);
  }
  return requestOpenAICompatibleText(baseUrl, provider, messages, context, attachments, modelBehavior, signal);
}

async function requestOpenAICompatibleText(
  baseUrl: string,
  provider: AIProviderSettings,
  messages: AIChatMessage[],
  context: AIChatContext | undefined,
  attachments: AIChatAttachment[],
  modelBehavior: AIModelBehavior | undefined,
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
      messages: buildOpenAIMessages(messages, context, attachments, modelBehavior),
    }),
    signal,
  });
  const data = (await response.json().catch(() => ({}))) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
  if (!response.ok) throw new ProviderHttpError(response.status);
  return data.choices?.[0]?.message?.content || "";
}

async function requestOpenAICompatibleTextStream(
  baseUrl: string,
  provider: AIProviderSettings,
  messages: AIChatMessage[],
  context: AIChatContext | undefined,
  attachments: AIChatAttachment[],
  modelBehavior: AIModelBehavior | undefined,
  signal: AbortSignal | undefined,
  onDelta: (content: string) => void,
): Promise<string> {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(provider.credential ? { Authorization: `Bearer ${provider.credential}` } : {}),
    },
    body: JSON.stringify({
      model: provider.model,
      messages: buildOpenAIMessages(messages, context, attachments, modelBehavior),
      stream: true,
    }),
    signal,
  });
  if (!response.ok) throw new ProviderHttpError(response.status);
  if ((response.headers.get("content-type") || "").includes("application/json")) {
    const data = (await response.json().catch(() => ({}))) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
    const text = data.choices?.[0]?.message?.content || "";
    if (text) onDelta(text);
    return text;
  }
  if (!response.body) {
    const text = await requestOpenAICompatibleText(baseUrl, provider, messages, context, attachments, modelBehavior, signal);
    onDelta(text);
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      const chunk = parseOpenAIStreamLine(line);
      if (!chunk) continue;
      content += chunk;
      onDelta(chunk);
    }
    if (done) break;
  }
  const lastChunk = parseOpenAIStreamLine(buffer);
  if (lastChunk) {
    content += lastChunk;
    onDelta(lastChunk);
  }
  return content;
}

async function requestAnthropicText(
  baseUrl: string,
  provider: AIProviderSettings,
  messages: AIChatMessage[],
  context: AIChatContext | undefined,
  attachments: AIChatAttachment[],
  modelBehavior: AIModelBehavior | undefined,
  signal: AbortSignal | undefined,
): Promise<string> {
  const runtime = context ? buildAIChatRuntimePrompt(context, attachments, modelBehavior) : null;
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": provider.credential || "",
    },
    body: JSON.stringify({
      model: provider.model,
      ...(runtime ? { system: runtime.systemPrompt } : {}),
      messages: buildAnthropicMessages(messages, runtime?.contextPrompt || ""),
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
  attachments: AIChatAttachment[],
  modelBehavior: AIModelBehavior | undefined,
  signal: AbortSignal | undefined,
): Promise<string> {
  const runtime = context ? buildAIChatRuntimePrompt(context, attachments, modelBehavior) : null;
  const url = new URL(`${baseUrl}/v1beta/models/${encodeURIComponent(provider.model)}:generateContent`);
  if (provider.credential) url.searchParams.set("key", provider.credential);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(runtime ? { systemInstruction: { parts: [{ text: runtime.systemPrompt }] } } : {}),
      contents: buildGoogleMessages(messages, runtime?.contextPrompt || ""),
    }),
    signal,
  });
  const data = (await response.json().catch(() => ({}))) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; error?: { message?: string } };
  if (!response.ok) throw new ProviderHttpError(response.status);
  return data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("\n").trim() || "";
}

function buildOpenAIMessages(messages: AIChatMessage[], context: AIChatContext | undefined, attachments: AIChatAttachment[], modelBehavior: AIModelBehavior | undefined): ProviderChatMessage[] {
  if (!context) return messages;
  const runtime = buildAIChatRuntimePrompt(context, attachments, modelBehavior);
  return [
    { role: "system", content: runtime.systemPrompt },
    ...(runtime.contextPrompt ? [{ role: "user" as const, content: runtime.contextPrompt }] : []),
    ...messages,
  ];
}

function buildAnthropicMessages(messages: AIChatMessage[], contextPrompt: string): Array<{ role: "user" | "assistant"; content: string }> {
  return [
    ...(contextPrompt ? [{ role: "user" as const, content: contextPrompt }] : []),
    ...messages,
  ];
}

function buildGoogleMessages(messages: AIChatMessage[], contextPrompt: string): Array<{ role: string; parts: Array<{ text: string }> }> {
  return [
    ...(contextPrompt ? [{ role: "user", parts: [{ text: contextPrompt }] }] : []),
    ...messages.map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] })),
  ];
}

function parseOpenAIStreamLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("data:")) return "";
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === "[DONE]") return "";
  try {
    const data = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
    return data.choices?.[0]?.delta?.content || "";
  } catch {
    return "";
  }
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
