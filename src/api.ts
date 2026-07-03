import type {
  AIChatRequest,
  AIChatResponse,
  AIConnectionStatus,
  AICliEntryKind,
  AIProviderSettings,
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

export async function fetchRepos(): Promise<RepoListItem[]> {
  const data = await requestJson<{ repositories: RepoListItem[] }>("/api/repos");
  return data.repositories;
}

export async function fetchTree(repoId: string, path: string): Promise<TreeNode[]> {
  const query = new URLSearchParams({ repo: repoId, path });
  const data = await requestJson<{ nodes: TreeNode[] }>(`/api/tree?${query.toString()}`);
  return data.nodes;
}

export async function openRepository(repoId: string): Promise<RepoOpenResponse> {
  return requestJson<RepoOpenResponse>("/api/repo-open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoId }),
  });
}

export async function fetchFile(repoId: string, path: string): Promise<FileResponse> {
  const query = new URLSearchParams({ repo: repoId, path });
  return requestJson<FileResponse>(`/api/file?${query.toString()}`);
}

export async function fetchHttpDeliveryStatus(): Promise<HttpDeliveryStatus> {
  return requestJson<HttpDeliveryStatus>("/api/http-delivery/status");
}

export async function startHttpDelivery(repoId: string, path: string): Promise<HttpDeliveryStatus> {
  return requestJson<HttpDeliveryStatus>("/api/http-delivery/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoId, path }),
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

export async function fetchAIEntryReadiness(entry: AICliEntryKind): Promise<CliAIEntryReadiness> {
  return requestJson<CliAIEntryReadiness>("/api/ai/entry-readiness", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entry }),
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

export function imageFileUrl(repoId: string, path: string, assetVersion = ""): string {
  const query = new URLSearchParams({ repo: repoId, path });
  if (assetVersion) query.set("v", assetVersion);
  return `/api/image?${query.toString()}`;
}

export function pdfFileUrl(repoId: string, path: string, assetVersion = ""): string {
  const query = new URLSearchParams({ repo: repoId, path });
  if (assetVersion) query.set("v", assetVersion);
  return `/api/pdf?${query.toString()}`;
}

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data as T;
}
