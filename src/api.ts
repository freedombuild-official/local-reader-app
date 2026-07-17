import type {
  AIChatRequest,
  AIChatFailureDetails,
  AIChatResponse,
  AIChatStreamEvent,
  AICliEntryKind,
  AICliModelSelection,
  AICliSetupSnapshot,
  AIConnectionStatus,
  AIEntryKind,
  AIProviderSettings,
  AIChatRunSummary,
  CliAIEntryReadiness,
  FileResponse,
  HttpDeliveryStatus,
  RepoListItem,
  RepoOpenResponse,
  RepositoryConfigDraft,
  RepositoryConfigPreview,
  RepositoryConfigState,
  RepositoryConfigValidation,
  TreeNode,
} from "./types";

export type AICliSetupCollection = {
  setups: Record<AICliEntryKind, AICliSetupSnapshot>;
};

export class AIChatRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = "",
    readonly entry?: AIEntryKind,
    readonly details?: AIChatFailureDetails,
  ) {
    super(message);
    this.name = "AIChatRequestError";
  }
}

export async function fetchRepos(): Promise<RepoListItem[]> {
  const data = await requestJson<{ repositories: RepoListItem[] }>("/api/repos");
  return data.repositories;
}

export async function fetchTree(repoId: string, path: string): Promise<{ revision: string; nodes: TreeNode[] }> {
  const query = new URLSearchParams({ repo: repoId, path });
  return requestJson<{ revision: string; nodes: TreeNode[] }>(`/api/tree?${query.toString()}`);
}

export async function openRepository(repoId: string, expectedRevision: string): Promise<RepoOpenResponse> {
  return requestJson<RepoOpenResponse>("/api/repo-open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoId, expectedRevision }),
  });
}

export async function fetchFile(repoId: string, path: string): Promise<FileResponse> {
  const query = new URLSearchParams({ repo: repoId, path });
  return requestJson<FileResponse>(`/api/file?${query.toString()}`);
}

export async function fetchHttpDeliveryStatus(): Promise<HttpDeliveryStatus> {
  return requestJson<HttpDeliveryStatus>("/api/http-delivery/status");
}

export async function startHttpDelivery(repoId: string, path: string, expectedRevision: string): Promise<HttpDeliveryStatus> {
  return requestJson<HttpDeliveryStatus>("/api/http-delivery/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoId, path, expectedRevision }),
  });
}

export async function stopHttpDelivery(deliveryId: string): Promise<HttpDeliveryStatus> {
  return requestJson<HttpDeliveryStatus>("/api/http-delivery/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deliveryId }),
  });
}

export async function fetchRepositoryConfig(): Promise<RepositoryConfigState> {
  return requestJson<RepositoryConfigState>("/api/repository-config");
}

export async function validateRepositoryConfig(draft: RepositoryConfigDraft): Promise<RepositoryConfigValidation> {
  return requestJson<RepositoryConfigValidation>("/api/repository-config/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  });
}

export async function previewRepositoryConfig(draft: RepositoryConfigDraft): Promise<RepositoryConfigPreview> {
  return requestJson<RepositoryConfigPreview>("/api/repository-config/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  });
}

export async function saveRepositoryConfig(draft: RepositoryConfigDraft): Promise<RepositoryConfigState> {
  return requestJson<RepositoryConfigState>("/api/repository-config/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  });
}

export async function testAIProviderConnection(provider: AIProviderSettings): Promise<AIConnectionStatus> {
  return requestJson<AIConnectionStatus>("/api/ai/test-connection", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(provider),
  });
}

export async function fetchAIEntryReadiness(
  entry: AIEntryKind,
  provider?: AIProviderSettings,
  repoId = "",
  expectedRevision = "",
  selection?: AICliModelSelection,
): Promise<CliAIEntryReadiness> {
  return requestJson<CliAIEntryReadiness>("/api/ai/entry-readiness", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entry, provider, repoId, expectedRevision, selection }),
  });
}

export async function fetchAICliSetups(): Promise<AICliSetupCollection> {
  return requestJson<AICliSetupCollection>("/api/ai/cli-setup");
}

export async function inspectAICliSetup(entry: AICliEntryKind): Promise<AICliSetupSnapshot> {
  return mutateAICliSetup("/api/ai/cli-setup/inspect", { entry });
}

export async function startAICliAuthentication(entry: AICliEntryKind): Promise<AICliSetupSnapshot> {
  return mutateAICliSetup("/api/ai/cli-setup/auth/start", { entry });
}

export async function cancelAICliAuthentication(entry: AICliEntryKind): Promise<AICliSetupSnapshot> {
  return mutateAICliSetup("/api/ai/cli-setup/auth/cancel", { entry });
}

export async function prepareAICliUpdate(entry: AICliEntryKind): Promise<AICliSetupSnapshot> {
  return mutateAICliSetup("/api/ai/cli-setup/update/prepare", { entry });
}

export async function confirmAICliUpdate(entry: AICliEntryKind, nonce: string): Promise<AICliSetupSnapshot> {
  return mutateAICliSetup("/api/ai/cli-setup/update/confirm", { entry, nonce });
}

async function mutateAICliSetup(url: string, body: { entry: AICliEntryKind; nonce?: string }): Promise<AICliSetupSnapshot> {
  return requestJson<AICliSetupSnapshot>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function sendAIChatMessage(request: AIChatRequest, signal?: AbortSignal): Promise<AIChatResponse> {
  return requestJson<AIChatResponse>("/api/ai/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
}

export async function cancelAIChatRun(runId: string): Promise<void> {
  await requestJson<{ runId: string; state: "canceling" }>("/api/ai/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runId }),
  });
}

export async function streamAIChatMessage(request: AIChatRequest, onEvent: (event: AIChatStreamEvent) => void, signal?: AbortSignal): Promise<void> {
  const response = await fetch("/api/ai/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Reader-Wiki-Request": "1" },
    body: JSON.stringify(request),
    signal,
    cache: "no-store",
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string; details?: unknown };
    const details = readAIChatRequestErrorDetails(data.details);
    throw new AIChatRequestError(data.error || `HTTP ${response.status}`, response.status, details.code, details.entry, {
      ...(details.code ? { code: details.code } : {}),
      ...(details.entry ? { entry: details.entry } : {}),
      ...(details.rollbackState ? { rollbackState: details.rollbackState } : {}),
      ...(details.run ? { run: details.run } : {}),
      ...(details.processTreeUnverified ? { processTreeUnverified: true } : {}),
    });
  }
  if (!response.body) throw new Error("AI Chat stream is not available in this browser.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      onEvent(JSON.parse(line) as AIChatStreamEvent);
    }
    if (done) break;
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer) as AIChatStreamEvent);
}

function isAIEntryKind(value: unknown): value is AIEntryKind {
  return value === "aiApi" || value === "localAi" || value === "codexCli" || value === "claudeCli";
}

function readAIChatRequestErrorDetails(value: unknown): {
  code: string;
  entry?: AIEntryKind;
  rollbackState: string;
  run?: AIChatRunSummary;
  processTreeUnverified: boolean;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { code: "", rollbackState: "", processTreeUnverified: false };
  }
  const source = value as Record<string, unknown>;
  const run = readAIChatRunSummary(source.run);
  return {
    code: boundedFailureString(source.code, 128),
    ...(isAIEntryKind(source.entry) ? { entry: source.entry } : {}),
    rollbackState: boundedFailureString(source.rollbackState, 128),
    ...(run ? { run } : {}),
    processTreeUnverified: source.processTreeUnverified === true,
  };
}

function readAIChatRunSummary(value: unknown): AIChatRunSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Partial<AIChatRunSummary>;
  if (
    (source.accessMode !== "readOnly" && source.accessMode !== "repoWrite")
    || !isAIEntryKind(source.entry)
    || !["directProvider", "serverEditProtocol", "codexCli", "claudeCli"].includes(String(source.substrate))
    || (source.auditState !== "verified" && source.auditState !== "unverified")
  ) return undefined;
  const changedPaths = Array.isArray(source.changedPaths)
    ? source.changedPaths.slice(0, 100).flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const candidate = item as { path?: unknown; status?: unknown };
      const itemPath = boundedFailureString(candidate.path, 1_024);
      if (!itemPath || !["new", "changed", "deleted"].includes(String(candidate.status))) return [];
      return [{ path: itemPath, status: candidate.status as "new" | "changed" | "deleted" }];
    })
    : [];
  const strings = (items: unknown, limit: number) => Array.isArray(items)
    ? items.slice(0, limit).map((item) => boundedFailureString(item, 1_024)).filter(Boolean)
    : [];
  return {
    accessMode: source.accessMode,
    entry: source.entry,
    substrate: source.substrate as AIChatRunSummary["substrate"],
    auditState: source.auditState,
    changedPaths,
    repairs: strings(source.repairs, 20),
    warnings: strings(source.warnings, 20),
  };
}

function boundedFailureString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

export function imageFileUrl(repoId: string, path: string, revision: string, assetVersion = ""): string {
  const query = new URLSearchParams({ repo: repoId, path, revision });
  if (assetVersion) query.set("v", assetVersion);
  return `/api/image?${query.toString()}`;
}

export function pdfFileUrl(repoId: string, path: string, revision: string, assetVersion = ""): string {
  const query = new URLSearchParams({ repo: repoId, path, revision });
  if (assetVersion) query.set("v", assetVersion);
  return `/api/pdf?${query.toString()}`;
}

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const method = String(init.method || "GET").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) headers.set("X-Reader-Wiki-Request", "1");
  const response = await fetch(url, { ...init, headers, cache: "no-store" });
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data as T;
}
