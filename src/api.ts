import type { FileResponse, HttpDeliveryStatus, RepoListItem, RepoOpenResponse, TreeNode } from "./types";

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

export async function stopHttpDelivery(sessionId: string): Promise<HttpDeliveryStatus> {
  return requestJson<HttpDeliveryStatus>("/api/http-delivery/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
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
