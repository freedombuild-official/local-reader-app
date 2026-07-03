import type { RepositoryRegistry } from "./repositoryRegistry.js";
import { readRepoFile } from "./repoFiles.js";
import type { AIChatContext, AIChatContextRequest } from "./types.js";

const TEXT_CONTEXT_KINDS = new Set(["markdown", "code", "text", "html"]);
const MAX_CONTEXT_CHARS = 16000;

export async function buildAIChatContext(registry: RepositoryRegistry, request: AIChatContextRequest): Promise<AIChatContext> {
  const repo = await registry.findRepository(request.repoId);
  const file = await readRepoFile(repo, request.path);
  const canIncludeContent =
    request.includeContent !== false &&
    TEXT_CONTEXT_KINDS.has(file.kind) &&
    file.fileInfo.viewerStatus === "displayable" &&
    file.content.length > 0;
  const content = canIncludeContent ? truncateContext(file.content) : "";
  return {
    repoId: file.repoId,
    path: file.path,
    fileName: file.name,
    fileKind: file.kind,
    viewerStatus: file.fileInfo.viewerStatus,
    lineCount: file.lineCount,
    byteLength: file.fileInfo.byteLength,
    contentIncluded: Boolean(content),
    content,
  };
}

function truncateContext(content: string): string {
  if (content.length <= MAX_CONTEXT_CHARS) return content;
  return `${content.slice(0, MAX_CONTEXT_CHARS)}\n\n[Reader-Wiki omitted the rest of this large file.]`;
}
