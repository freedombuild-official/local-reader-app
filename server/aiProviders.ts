import { lookup } from "node:dns/promises";
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { HttpError } from "./errors.js";
import { GUARDED_EDIT_RESPONSE_FORMAT } from "./guardedEditProtocol.js";
import { buildAIChatRuntimePrompt } from "./aiPromptPolicy.js";
import type { AIChatAttachment, AIChatContext, AIChatMessage, AIConnectionStatus, AIModelBehavior, AIProviderSettings } from "./types.js";

type ProviderRequest = {
  provider: AIProviderSettings;
  messages?: AIChatMessage[];
  context?: AIChatContext;
  attachments?: AIChatAttachment[];
  modelBehavior?: AIModelBehavior;
  systemPrompt?: string;
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
const PROVIDER_RESPONSE_MAX_BYTES = 1024 * 1024;
const PROVIDER_STREAM_MAX_BYTES = 2 * 1024 * 1024;
const PROVIDER_MAX_REDIRECTS = 3;
const PROVIDER_CONNECTION_TIMEOUT_MS = 15_000;
const PROVIDER_CHAT_TIMEOUT_MS = 60_000;

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

class ProviderPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderPolicyError";
  }
}

class ProviderResponseTooLargeError extends Error {
  constructor() {
    super("Provider response exceeded the Reader-Wiki byte limit.");
    this.name = "ProviderResponseTooLargeError";
  }
}

class ProviderProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderProtocolError";
  }
}

export async function testAIConnection(provider: AIProviderSettings, signal?: AbortSignal): Promise<AIConnectionStatus> {
  const readiness = providerReadiness(provider);
  if (readiness.state !== "ready") return readiness;
  try {
    return await withTimeout(signal, PROVIDER_CONNECTION_TIMEOUT_MS, async (timeoutSignal) => {
      const modelVisibility = await testModelVisibility(provider, timeoutSignal);
      if (modelVisibility) return modelVisibility;
      const content = await requestProviderText({
        provider,
        messages: [{ role: "user", content: "Reply with Reader-Wiki ready." }],
        signal: timeoutSignal,
      });
      assertProviderContent(content);
      return status("ready", "success", "success", "Connected.", "This provider endpoint is reachable. Run AI Entry readiness to confirm the selected access policy.");
    });
  } catch (error) {
    return safeProviderErrorStatus(error);
  }
}

export async function requestAIChatCompletion(request: ProviderRequest): Promise<{ content: string; status: AIConnectionStatus }> {
  const readiness = providerReadiness(request.provider);
  if (readiness.state !== "ready") throw new HttpError(400, readiness.message);
  try {
    const content = await withTimeout(request.signal, PROVIDER_CHAT_TIMEOUT_MS, (signal) => requestProviderText({ ...request, signal }));
    assertProviderContent(content);
    return { content, status: status("ready", "success", "success", "Response received.", "Continue the conversation or test again if the endpoint changes.") };
  } catch (error) {
    const failed = safeProviderErrorStatus(error);
    if (request.signal?.aborted) throw new HttpError(499, "AI provider request was canceled.");
    if (failed.code === "timeout_or_abort") throw new HttpError(504, failed.message);
    throw new HttpError(502, failed.message);
  }
}

export async function requestAIChatCompletionStream(request: ProviderRequest, onDelta: (content: string) => void): Promise<{ content: string; status: AIConnectionStatus }> {
  const readiness = providerReadiness(request.provider);
  if (readiness.state !== "ready") throw new HttpError(400, readiness.message);
  try {
    const content = await withTimeout(request.signal, PROVIDER_CHAT_TIMEOUT_MS, async (signal) => {
      const baseUrl = providerBaseUrl(request.provider).replace(/\/+$/, "");
      const next = request.provider.apiFormat === "openaiCompatible" || request.provider.provider === "openaiCompatible" || request.provider.provider === "openai" || request.provider.entry === "localAi"
        ? await requestOpenAICompatibleTextStream(baseUrl, request.provider, request.messages || [], request.context, request.attachments || [], request.modelBehavior, signal, onDelta)
        : await requestProviderText({ ...request, signal });
      if (!(request.provider.apiFormat === "openaiCompatible" || request.provider.provider === "openaiCompatible" || request.provider.provider === "openai" || request.provider.entry === "localAi")) onDelta(next);
      return next;
    });
    assertProviderContent(content);
    return { content, status: status("ready", "success", "success", "Response received.", "Continue the conversation or test again if the endpoint changes.") };
  } catch (error) {
    const failed = safeProviderErrorStatus(error);
    if (request.signal?.aborted) throw new HttpError(499, "AI provider request was canceled.");
    if (failed.code === "timeout_or_abort") throw new HttpError(504, failed.message);
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
    validateProviderUrlSyntax(provider, new URL(baseUrl));
  } catch {
    return status("failed", "invalid_endpoint", "error", "Endpoint URL is blocked or invalid for this AI Entry.", "Remote AI APIs require HTTPS. Local AI requires an explicit loopback host and port.");
  }
  return status("ready", "needs_test", "info", "Connection can be tested.", "Run AI Entry readiness before using this entry.");
}

async function requestProviderText({ provider, messages = [], context, attachments = [], modelBehavior, systemPrompt, signal }: ProviderRequest): Promise<string> {
  const baseUrl = providerBaseUrl(provider).replace(/\/+$/, "");
  if (provider.apiFormat === "anthropic" || provider.provider === "anthropic") {
    return requestAnthropicText(baseUrl, provider, messages, context, attachments, modelBehavior, systemPrompt, signal);
  }
  if (provider.apiFormat === "google" || provider.provider === "google") {
    return requestGoogleText(baseUrl, provider, messages, context, attachments, modelBehavior, systemPrompt, signal);
  }
  return requestOpenAICompatibleText(baseUrl, provider, messages, context, attachments, modelBehavior, systemPrompt, signal);
}

async function requestOpenAICompatibleText(
  baseUrl: string,
  provider: AIProviderSettings,
  messages: AIChatMessage[],
  context: AIChatContext | undefined,
  attachments: AIChatAttachment[],
  modelBehavior: AIModelBehavior | undefined,
  systemPrompt: string | undefined,
  signal: AbortSignal | undefined,
): Promise<string> {
  const response = await providerFetch(provider, `${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(provider.credential ? { Authorization: `Bearer ${provider.credential}` } : {}),
    },
    body: JSON.stringify({
      model: provider.model,
      ...(systemPrompt ? { temperature: 0, response_format: GUARDED_EDIT_RESPONSE_FORMAT } : {}),
      messages: buildOpenAIMessages(messages, context, attachments, modelBehavior, systemPrompt),
    }),
    signal,
  });
  const data = await readProviderJson<{ choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } }>(response);
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
  const response = await providerFetch(provider, `${baseUrl}/chat/completions`, {
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
    const data = await readProviderJson<{ choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } }>(response);
    const text = data.choices?.[0]?.message?.content || "";
    if (text) onDelta(text);
    return text;
  }
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let receivedBytes = 0;
  while (true) {
    const { value, done } = await reader.read();
    receivedBytes += value?.byteLength || 0;
    if (receivedBytes > PROVIDER_STREAM_MAX_BYTES) {
      await reader.cancel();
      throw new ProviderResponseTooLargeError();
    }
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
  systemPrompt: string | undefined,
  signal: AbortSignal | undefined,
): Promise<string> {
  const runtime = context ? buildAIChatRuntimePrompt(context, attachments, modelBehavior) : null;
  const effectiveSystemPrompt = [systemPrompt, runtime?.systemPrompt].filter(Boolean).join("\n\n");
  const response = await providerFetch(provider, `${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": provider.credential || "",
    },
    body: JSON.stringify({
      model: provider.model,
      ...(systemPrompt ? { temperature: 0 } : {}),
      ...(effectiveSystemPrompt ? { system: effectiveSystemPrompt } : {}),
      messages: buildAnthropicMessages(messages, runtime?.contextPrompt || ""),
    }),
    signal,
  });
  const data = await readProviderJson<{ content?: Array<{ text?: string }>; error?: { message?: string } }>(response);
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
  systemPrompt: string | undefined,
  signal: AbortSignal | undefined,
): Promise<string> {
  const runtime = context ? buildAIChatRuntimePrompt(context, attachments, modelBehavior) : null;
  const effectiveSystemPrompt = [systemPrompt, runtime?.systemPrompt].filter(Boolean).join("\n\n");
  const url = new URL(`${baseUrl}/v1beta/models/${encodeURIComponent(provider.model)}:generateContent`);
  if (provider.credential) url.searchParams.set("key", provider.credential);
  const response = await providerFetch(provider, url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(effectiveSystemPrompt ? { systemInstruction: { parts: [{ text: effectiveSystemPrompt }] } } : {}),
      ...(systemPrompt ? { generationConfig: { temperature: 0 } } : {}),
      contents: buildGoogleMessages(messages, runtime?.contextPrompt || ""),
    }),
    signal,
  });
  const data = await readProviderJson<{ candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; error?: { message?: string } }>(response);
  if (!response.ok) throw new ProviderHttpError(response.status);
  return data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("\n").trim() || "";
}

function buildOpenAIMessages(messages: AIChatMessage[], context: AIChatContext | undefined, attachments: AIChatAttachment[], modelBehavior: AIModelBehavior | undefined, systemPrompt?: string): ProviderChatMessage[] {
  const runtime = context ? buildAIChatRuntimePrompt(context, attachments, modelBehavior) : null;
  const effectiveSystemPrompt = [systemPrompt, runtime?.systemPrompt].filter(Boolean).join("\n\n");
  return [
    ...(effectiveSystemPrompt ? [{ role: "system" as const, content: effectiveSystemPrompt }] : []),
    ...(runtime?.contextPrompt ? [{ role: "user" as const, content: runtime.contextPrompt }] : []),
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

async function providerFetch(provider: AIProviderSettings, input: string | URL, init: RequestInit): Promise<Response> {
  let current = new URL(input);
  const allowedOrigin = current.origin;
  let requestInit: RequestInit = { ...init, redirect: "manual" };
  for (let redirectCount = 0; redirectCount <= PROVIDER_MAX_REDIRECTS; redirectCount += 1) {
    const pinnedAddress = await resolveProviderAddress(provider, current, requestInit.signal || undefined);
    const response = await requestPinnedProvider(current, requestInit, pinnedAddress);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    if (redirectCount === PROVIDER_MAX_REDIRECTS) {
      await response.body?.cancel();
      throw new ProviderPolicyError("Provider redirected too many times.");
    }
    const next = new URL(location, current);
    if (next.origin !== allowedOrigin) {
      await response.body?.cancel();
      throw new ProviderPolicyError("Provider redirects must stay on the exact configured origin.");
    }
    await response.body?.cancel();
    if (response.status === 303) {
      const headers = new Headers(requestInit.headers);
      headers.delete("content-type");
      requestInit = { ...requestInit, method: "GET", body: undefined, headers };
    }
    current = next;
  }
  throw new ProviderPolicyError("Provider redirect policy failed.");
}

async function resolveProviderAddress(provider: AIProviderSettings, url: URL, signal?: AbortSignal): Promise<string> {
  validateProviderUrlSyntax(provider, url);
  const hostname = normalizeUrlHostname(url.hostname);
  const addresses = isIP(hostname)
    ? [hostname]
    : (await waitForProviderAbort(lookup(hostname, { all: true, verbatim: true }), signal)).map((entry) => entry.address);
  if (!addresses.length) throw new ProviderPolicyError("Provider hostname did not resolve to an address.");
  if (provider.entry === "localAi") {
    if (addresses.some((address) => !isLoopbackAddress(address))) {
      throw new ProviderPolicyError("Local AI hostname resolved outside loopback.");
    }
    return addresses[0];
  }
  if (addresses.some(isBlockedAddress)) {
    throw new ProviderPolicyError("Remote AI API resolved to a private, loopback, link-local, or reserved address.");
  }
  return addresses[0];
}

async function waitForProviderAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) throw new ProviderAbortError();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new ProviderAbortError());
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function requestPinnedProvider(url: URL, init: RequestInit, address: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const body = requestBodyBytes(init.body);
    const headers = new Headers(init.headers);
    if (body && !headers.has("content-length")) headers.set("content-length", String(body.byteLength));
    const family = isIP(address);
    const request = (url.protocol === "https:" ? requestHttps : requestHttp)({
      protocol: url.protocol,
      hostname: normalizeUrlHostname(url.hostname),
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: init.method || "GET",
      headers: Object.fromEntries(headers.entries()),
      signal: init.signal || undefined,
      servername: url.protocol === "https:" && !isIP(normalizeUrlHostname(url.hostname)) ? normalizeUrlHostname(url.hostname) : undefined,
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      },
    }, (incoming) => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
        else responseHeaders.set(name, value);
      }
      const bodyAllowed = init.method !== "HEAD" && incoming.statusCode !== 204 && incoming.statusCode !== 304;
      const responseBody = bodyAllowed ? Readable.toWeb(incoming) as ReadableStream<Uint8Array> : null;
      resolve(new Response(responseBody, {
        status: incoming.statusCode || 500,
        statusText: incoming.statusMessage || "",
        headers: responseHeaders,
      }));
    });
    request.once("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

function requestBodyBytes(body: RequestInit["body"]): Buffer | null {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  throw new ProviderPolicyError("Provider request body type is not supported.");
}

function validateProviderUrlSyntax(provider: AIProviderSettings, url: URL): void {
  if (url.username || url.password) throw new ProviderPolicyError("Endpoint URLs must not contain credentials.");
  const hostname = normalizeUrlHostname(url.hostname);
  if (provider.entry === "localAi") {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ProviderPolicyError("Local AI endpoints require HTTP or HTTPS.");
    }
    if (!url.port || !isLoopbackHostname(hostname)) {
      throw new ProviderPolicyError("Local AI endpoints require an explicit loopback host and port.");
    }
    return;
  }
  if (url.protocol !== "https:") {
    throw new ProviderPolicyError("Remote AI API endpoints require HTTPS.");
  }
}

function normalizeUrlHostname(hostname: string): string {
  const normalized = hostname.toLowerCase();
  return normalized.startsWith("[") && normalized.endsWith("]") ? normalized.slice(1, -1) : normalized;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function isLoopbackAddress(address: string): boolean {
  const normalized = normalizeUrlHostname(address);
  if (normalized === "::1") return true;
  if (isIP(normalized) === 4) return normalized.startsWith("127.");
  const bytes = parseIPv6(normalized);
  return Boolean(bytes && bytes.slice(0, 15).every((value) => value === 0) && bytes[15] === 1);
}

function isBlockedAddress(address: string): boolean {
  const normalized = normalizeUrlHostname(address);
  if (isIP(normalized) === 6) return isBlockedIPv6(normalized);
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 2)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51)
    || (a === 203 && b === 0)
    || a >= 224;
}

function isBlockedIPv6(address: string): boolean {
  const bytes = parseIPv6(address);
  if (!bytes) return true;
  const mapped = bytes.slice(0, 10).every((value) => value === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped) return isBlockedAddress(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  if (bytes.slice(0, 12).every((value) => value === 0)) return true;
  if ((bytes[0] & 0xfe) === 0xfc) return true;
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0) return true;
  if (bytes[0] === 0xff) return true;
  if ((bytes[0] >> 4) !== 2 && (bytes[0] >> 4) !== 3) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return true;
  return false;
}

function parseIPv6(address: string): number[] | null {
  const zoneIndex = address.indexOf("%");
  const normalized = (zoneIndex >= 0 ? address.slice(0, zoneIndex) : address).toLowerCase();
  const pieces = normalized.split("::");
  if (pieces.length > 2) return null;
  const parseSide = (value: string): number[] | null => {
    if (!value) return [];
    const segments = value.split(":");
    const parsed: number[] = [];
    for (const segment of segments) {
      if (segment.includes(".")) {
        const ipv4 = segment.split(".").map(Number);
        if (ipv4.length !== 4 || ipv4.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) return null;
        parsed.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(segment)) return null;
        parsed.push(Number.parseInt(segment, 16));
      }
    }
    return parsed;
  };
  const left = parseSide(pieces[0]);
  const right = parseSide(pieces[1] || "");
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if ((pieces.length === 1 && missing !== 0) || (pieces.length === 2 && missing < 1)) return null;
  const words = [...left, ...Array(Math.max(0, missing)).fill(0), ...right];
  if (words.length !== 8) return null;
  return words.flatMap((word) => [(word >> 8) & 0xff, word & 0xff]);
}

async function readProviderJson<T>(response: Response): Promise<T> {
  if (!response.body) return {} as T;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      byteLength += value.byteLength;
      if (byteLength > PROVIDER_RESPONSE_MAX_BYTES) {
        await reader.cancel();
        throw new ProviderResponseTooLargeError();
      }
      chunks.push(value);
    }
    if (done) break;
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (!bytes.byteLength) return {} as T;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return {} as T;
  }
}

async function testModelVisibility(provider: AIProviderSettings, signal: AbortSignal | undefined): Promise<AIConnectionStatus | null> {
  if (provider.apiFormat !== "openaiCompatible" && provider.provider !== "openaiCompatible" && provider.entry !== "localAi") return null;
  const baseUrl = providerBaseUrl(provider).replace(/\/+$/, "");
  const response = await providerFetch(provider, `${baseUrl}/models`, {
    method: "GET",
    headers: {
      ...(provider.credential ? { Authorization: `Bearer ${provider.credential}` } : {}),
    },
    signal,
  });
  if (response.status === 404 || response.status === 405) return null;
  if (!response.ok) throw new ProviderHttpError(response.status);
  const data = await readProviderJson<{ data?: Array<{ id?: string }> }>(response);
  const ids = (data.data || []).map((item) => item.id || "").filter(Boolean);
  if (ids.length && !ids.includes(provider.model)) {
    return status("failed", "model_missing", "warning", "Model is not visible at this endpoint.", "Check the model name or load it in your local runtime outside Reader-Wiki.");
  }
  return null;
}

async function withTimeout<T>(inputSignal: AbortSignal | undefined, timeoutMs: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (inputSignal?.aborted) throw new ProviderAbortError();
  const controller = new AbortController();
  const abort = () => controller.abort(new ProviderAbortError("Connection test was canceled."));
  const timeout = setTimeout(() => controller.abort(new ProviderAbortError()), timeoutMs);
  inputSignal?.addEventListener("abort", abort, { once: true });
  try {
    return await work(controller.signal);
  } finally {
    clearTimeout(timeout);
    inputSignal?.removeEventListener("abort", abort);
  }
}

function assertProviderContent(content: string): void {
  if (!content.trim()) throw new ProviderProtocolError("Provider returned an empty or unsupported response.");
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
  if (error instanceof ProviderPolicyError) {
    return status("failed", "invalid_endpoint", "error", error.message, "Use HTTPS for remote AI APIs or an explicit loopback endpoint for Local AI.");
  }
  if (error instanceof ProviderResponseTooLargeError) {
    return status("failed", "provider_http_error", "error", "Provider response exceeded the Reader-Wiki byte limit.", "Reduce the response size or choose a smaller model output.");
  }
  if (error instanceof ProviderProtocolError) {
    return status("failed", "provider_http_error", "error", error.message, "Check the provider API format and model response shape.");
  }
  if (error instanceof TypeError) {
    return status("failed", "endpoint_unreachable", "error", "Endpoint is unreachable.", "Check that the server is running and the endpoint URL is correct.");
  }
  return status("failed", "provider_http_error", "error", "Provider request failed.", "Check endpoint settings and test again.");
}
