import { createHash, randomUUID } from "node:crypto";
import { access, constants } from "node:fs/promises";
import path from "node:path";
import { json as expressJson, type NextFunction, type Request, type Response, Router } from "express";
import { HttpError, isHttpError } from "./errors.js";
import { buildAIChatContextForRepository } from "./aiContext.js";
import { requestRepoWriteAIChatCompletion, resolveAIWorkspace, type AICommandRunner } from "./aiCliAdapters.js";
import { probeAIEntryReadiness } from "./aiEntries.js";
import { aiChatSystemPromptPath } from "./aiPromptPolicy.js";
import { assertGuardedRepoContextPaths, buildGuardedRepoPathPolicy, requestGuardedRepoWriteAIChatCompletion, sanitizeGuardedAIChatContext, type GuardedProviderRequester } from "./guardedRepoEdits.js";
import { providerReadiness, requestAIChatCompletion, requestAIChatCompletionStream, testAIConnection } from "./aiProviders.js";
import type { HttpDeliveryService } from "./httpDelivery.js";
import { createRepositoryRegistry, type RepositoryRegistry } from "./repositoryRegistry.js";
import { loadRepositoryConfigState, previewRepositoryConfig, saveRepositoryConfigDraft, validateRepositoryConfigDraft } from "./repositoryConfig.js";
import { assertRepositoryRevision, repositoryRevision } from "./repositoryRevision.js";
import { readGitStatusEntries, readRepoFile, readTree, readTreeSnapshot, resolveRepoImage, resolveRepoPdf, syncRepository } from "./repoFiles.js";
import type { AIChatExecutionTarget, AIChatRequest, AIChatRunSummary, AIEntryKind, AIProviderSettings, RepositoryConfig, RepositoryConfigDraft } from "./types.js";

const READINESS_ATTESTATION_TTL_MS = 5 * 60_000;
const READINESS_ATTESTATION_MAX_ENTRIES = 128;
const AI_GLOBAL_CONCURRENCY_LIMIT = 4;

type ApiRouterOptions = {
  configPath?: string;
  packageRoot?: string;
  aiCommandRunner?: AICommandRunner;
  aiProviderRequester?: GuardedProviderRequester;
  readinessAttestationTtlMs?: number;
  readinessAttestationMaxEntries?: number;
  readinessAttestationNow?: () => number;
};

export function createApiRouter(registryOrConfigPath: RepositoryRegistry | string, httpDelivery?: HttpDeliveryService, options: ApiRouterOptions = {}): Router {
  const router = Router();
  const registry = typeof registryOrConfigPath === "string" ? createRepositoryRegistry({ configPath: registryOrConfigPath }) : registryOrConfigPath;
  const configPath = path.resolve(options.configPath || (typeof registryOrConfigPath === "string" ? registryOrConfigPath : registry.configPath || path.join(process.cwd(), "repositories.yaml")));
  const readinessAttestationTtlMs = positiveInteger(options.readinessAttestationTtlMs, READINESS_ATTESTATION_TTL_MS);
  const readinessAttestationMaxEntries = positiveInteger(options.readinessAttestationMaxEntries, READINESS_ATTESTATION_MAX_ENTRIES);
  const readinessAttestationNow = options.readinessAttestationNow || Date.now;
  const readinessAttestations = new Map<string, number>();
  const activeAIRuns = new Map<string, { abort: () => void }>();
  const activeAIRepos = new Set<string>();
  let activeAIRequests = 0;
  let configSaveActive = false;

  function storeReadinessAttestation(entry: AIEntryKind, repoId: string, revision: string, provider: AIProviderSettings | undefined): void {
    const now = readinessAttestationNow();
    cleanupExpiredReadinessAttestations(now);
    const key = readinessAttestationKey(entry, repoId, revision, provider);
    readinessAttestations.delete(key);
    readinessAttestations.set(key, now + readinessAttestationTtlMs);
    while (readinessAttestations.size > readinessAttestationMaxEntries) {
      const oldestKey = readinessAttestations.keys().next().value as string | undefined;
      if (!oldestKey) break;
      readinessAttestations.delete(oldestKey);
    }
  }

  function refreshReadinessAttestation(target: AIChatExecutionTarget, repoId: string, revision: string): boolean {
    const provider = "provider" in target ? target.provider : undefined;
    const now = readinessAttestationNow();
    cleanupExpiredReadinessAttestations(now);
    const key = readinessAttestationKey(targetEntry(target), repoId, revision, provider);
    if (!readinessAttestations.has(key)) return false;
    readinessAttestations.delete(key);
    readinessAttestations.set(key, now + readinessAttestationTtlMs);
    return true;
  }

  function cleanupExpiredReadinessAttestations(now: number): void {
    for (const [key, expiresAt] of readinessAttestations) {
      if (expiresAt <= now) readinessAttestations.delete(key);
    }
  }

  async function ensureReadinessAttestation(target: AIChatExecutionTarget, repo: RepositoryConfig, revision: string, signal: AbortSignal): Promise<void> {
    if (refreshReadinessAttestation(target, repo.id, revision)) {
      if (isCliTarget(target)) await assertCliWorkspaceWritable(repo);
      return;
    }
    const provider = "provider" in target ? target.provider : undefined;
    const entry = targetEntry(target);
    const readiness = await probeAIEntryReadiness(entry, {
      provider,
      repo,
      runner: options.aiCommandRunner,
      providerRequester: options.aiProviderRequester,
      signal,
    });
    if (signal.aborted) throw new HttpError(499, "AI Chat request was canceled.");
    if (!readiness.ready) {
      throw new HttpError(409, readiness.status.message || "AI Entry readiness could not be renewed.", {
        code: "readiness_renewal_failed",
        entry,
      });
    }
    const currentRepo = await registry.findRepository(repo.id);
    await assertRepositoryRevision(currentRepo, revision);
    storeReadinessAttestation(entry, repo.id, revision, provider);
  }

  async function withRepoAILock<T>(repoId: string, work: () => Promise<T>): Promise<T> {
    if (configSaveActive) throw new HttpError(409, "Repository config is being saved. Retry after Settings finishes.");
    if (activeAIRepos.has(repoId)) throw new HttpError(409, "Another AI Chat run is still active for this repository.");
    activeAIRepos.add(repoId);
    let keepRepoLocked = false;
    try {
      return await withAIRequestSlot(work);
    } catch (error) {
      keepRepoLocked = hasUnverifiedProcessTree(error);
      throw error;
    } finally {
      if (!keepRepoLocked) activeAIRepos.delete(repoId);
    }
  }

  async function withAIRequestSlot<T>(work: () => Promise<T>): Promise<T> {
    if (activeAIRequests >= AI_GLOBAL_CONCURRENCY_LIMIT) throw new HttpError(429, "Reader-Wiki AI concurrency limit is active. Try again after another request finishes.");
    activeAIRequests += 1;
    try {
      return await work();
    } finally {
      activeAIRequests -= 1;
    }
  }

  router.use("/http-delivery", expressJson({ limit: "20kb" }));
  router.use("/repo-open", expressJson({ limit: "20kb" }));
  router.use("/repository-config", expressJson({ limit: "100kb" }));
  router.use("/ai", expressJson({ limit: "140kb" }));

  router.get("/repos", async (_request, response, next) => {
    try {
      setNoStore(response);
      response.json({ repositories: await registry.listRepositoryItems() });
    } catch (error) {
      next(error);
    }
  });

  router.get("/tree", async (request, response, next) => {
    try {
      const repo = await registry.findRepository(String(request.query.repo || ""));
      setNoStore(response);
      response.json({ repoId: repo.id, revision: await repositoryRevision(repo), path: String(request.query.path || ""), nodes: await readTree(repo, request.query.path) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/git-status", async (request, response, next) => {
    try {
      const repo = await registry.findRepository(String(request.query.repo || ""));
      setNoStore(response);
      response.json({ repoId: repo.id, revision: await repositoryRevision(repo), statuses: await readGitStatusEntries(repo) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/repo-open", async (request, response, next) => {
    try {
      const repo = await registry.findRepository(String(request.body?.repoId || ""));
      const revision = await assertRepositoryRevision(repo, request.body?.expectedRevision);
      setNoStore(response);
      const sync = await syncRepository(repo);
      const treeSnapshot = await readTreeSnapshot(repo);
      response.json({ repoId: repo.id, revision, sync, tree: treeSnapshot.tree, treeTruncated: treeSnapshot.truncated, treeWarnings: treeSnapshot.warnings });
    } catch (error) {
      next(error);
    }
  });

  router.get("/repository-config", async (_request, response, next) => {
    try {
      setNoStore(response);
      response.json(await loadRepositoryConfigState(configPath, options.packageRoot));
    } catch (error) {
      next(error);
    }
  });

  router.post("/repository-config/validate", async (request, response, next) => {
    try {
      setNoStore(response);
      response.json(await validateRepositoryConfigDraft(request.body as RepositoryConfigDraft, configPath));
    } catch (error) {
      next(error);
    }
  });

  router.post("/repository-config/preview", async (request, response, next) => {
    try {
      setNoStore(response);
      response.json(await previewRepositoryConfig(request.body as RepositoryConfigDraft, configPath));
    } catch (error) {
      next(error);
    }
  });

  router.post("/repository-config/save", async (request, response, next) => {
    if (configSaveActive || activeAIRepos.size > 0) {
      next(new HttpError(409, "Repository config cannot be changed while an AI Chat run is active."));
      return;
    }
    configSaveActive = true;
    try {
      setNoStore(response);
      const state = await saveRepositoryConfigDraft(request.body as RepositoryConfigDraft, configPath);
      httpDelivery?.stopAll();
      response.json(state);
    } catch (error) {
      next(error);
    } finally {
      configSaveActive = false;
    }
  });

  router.get("/file", async (request, response, next) => {
    try {
      const repo = await registry.findRepository(String(request.query.repo || ""));
      setNoStore(response);
      response.json({ ...(await readRepoFile(repo, request.query.path)), revision: await repositoryRevision(repo) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/http-delivery/status", (_request, response) => {
    setNoStore(response);
    response.json(httpDelivery?.status() || { state: "idle", items: [] });
  });

  router.post("/ai/test-connection", async (request, response, next) => {
    const abortScope = requestAbortScope(request, response);
    try {
      setNoStore(response);
      response.json(await withAIRequestSlot(() => testAIConnection(request.body as AIProviderSettings, abortScope.signal)));
    } catch (error) {
      next(error);
    } finally {
      abortScope.cleanup();
    }
  });

  router.post("/ai/entry-readiness", async (request, response, next) => {
    const abortScope = requestAbortScope(request, response);
    try {
      setNoStore(response);
      const entry = normalizeAIEntryKind(request.body?.entry);
      const repoId = String(request.body?.repoId || "");
      const repo = repoId ? await registry.findRepository(repoId) : undefined;
      const provider = request.body?.provider as AIProviderSettings | undefined;
      const revision = repo ? await assertRepositoryRevision(repo, request.body?.expectedRevision) : "no-repository";
      const readiness = await withAIRequestSlot(() => probeAIEntryReadiness(entry, {
          provider,
          repo,
          runner: options.aiCommandRunner,
          providerRequester: options.aiProviderRequester,
          signal: abortScope.signal,
        }));
      if (repo) {
        const currentRepo = await registry.findRepository(repoId);
        await assertRepositoryRevision(currentRepo, revision);
      }
      if (readiness.ready) storeReadinessAttestation(entry, repoId, revision, provider);
      response.json({ ...readiness, revision });
    } catch (error) {
      next(error);
    } finally {
      abortScope.cleanup();
    }
  });

  router.post("/ai/chat", async (request, response, next) => {
    const abortScope = requestAbortScope(request, response);
    try {
      const body = request.body as AIChatRequest;
      setNoStore(response);
      const target = resolveAIChatTarget(body);
      assertAIChatTargetReady(target);
      const repoId = String(body.context?.repoId || "");
      const execution = await withRepoAILock(repoId, async () => {
        const repo = await registry.findRepository(repoId);
        const guardedPathPolicy = usesGuardedRepoContext(target)
          ? await buildGuardedRepoPathPolicy(repo, [configPath, aiChatSystemPromptPath()])
          : undefined;
        const effectiveRepo = guardedPathPolicy ? { ...repo, root: guardedPathPolicy.rootRealPath } : repo;
        if (guardedPathPolicy) await assertGuardedRepoContextPaths(effectiveRepo, body.context, guardedPathPolicy);
        const builtContext = await buildAIChatContextForRepository(effectiveRepo, body.context);
        const context = guardedPathPolicy ? sanitizeGuardedAIChatContext(effectiveRepo, builtContext, guardedPathPolicy) : builtContext;
        await ensureReadinessAttestation(target, effectiveRepo, context.revision, abortScope.signal);
        const result = await (async () => {
        if (isDirectProviderTarget(target) && providerExecutionMode(target.provider) === "readOnly") {
          const direct = await requestAIChatCompletion({
            provider: target.provider,
            messages: body.messages,
            context,
            attachments: body.attachments,
            modelBehavior: body.modelBehavior,
            signal: abortScope.signal,
          });
          return { ...direct, run: contextOnlyRunSummary(target) };
        }
        if (isDirectProviderTarget(target)) {
          return requestGuardedRepoWriteAIChatCompletion({
            provider: target.provider,
            messages: body.messages,
            context,
            repo: effectiveRepo,
            attachments: body.attachments,
            modelBehavior: body.modelBehavior,
            signal: abortScope.signal,
            requester: options.aiProviderRequester,
            pathPolicy: guardedPathPolicy,
          });
        }
        return requestRepoWriteAIChatCompletion({ target, messages: body.messages, context, repo: effectiveRepo, attachments: body.attachments, modelBehavior: body.modelBehavior, runner: options.aiCommandRunner, signal: abortScope.signal });
        })();
        return { context, result };
      });
      response.json({ message: { role: "assistant", content: execution.result.content }, context: execution.context, status: execution.result.status, run: execution.result.run });
    } catch (error) {
      next(error);
    } finally {
      abortScope.cleanup();
    }
  });

  router.post("/ai/chat/stream", async (request, response, next) => {
    const body = request.body as AIChatRequest;
    const abortScope = requestAbortScope(request, response);
    const runId = randomUUID();
    activeAIRuns.set(runId, { abort: abortScope.abort });
    try {
      const target = resolveAIChatTarget(body);
      assertAIChatTargetReady(target);
      const repoId = String(body.context?.repoId || "");
      const execution = await withRepoAILock(repoId, async () => {
        const repo = await registry.findRepository(repoId);
        const guardedPathPolicy = usesGuardedRepoContext(target)
          ? await buildGuardedRepoPathPolicy(repo, [configPath, aiChatSystemPromptPath()])
          : undefined;
        const effectiveRepo = guardedPathPolicy ? { ...repo, root: guardedPathPolicy.rootRealPath } : repo;
        if (guardedPathPolicy) await assertGuardedRepoContextPaths(effectiveRepo, body.context, guardedPathPolicy);
        const builtContext = await buildAIChatContextForRepository(effectiveRepo, body.context);
        const context = guardedPathPolicy ? sanitizeGuardedAIChatContext(effectiveRepo, builtContext, guardedPathPolicy) : builtContext;
        await ensureReadinessAttestation(target, effectiveRepo, context.revision, abortScope.signal);
        setNoStore(response);
        response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
        response.setHeader("X-Content-Type-Options", "nosniff");
        if (!canWriteResponse(response)) throw new HttpError(499, "AI Chat request was canceled.");
        response.write(`${JSON.stringify({ type: "meta", runId, context })}\n`);
        const result = await (async () => {
        if (isDirectProviderTarget(target) && providerExecutionMode(target.provider) === "readOnly") {
          const direct = await requestAIChatCompletionStream({
            provider: target.provider,
            messages: body.messages,
            context,
            attachments: body.attachments,
            modelBehavior: body.modelBehavior,
            signal: abortScope.signal,
          }, (content) => {
            if (canWriteResponse(response)) response.write(`${JSON.stringify({ type: "delta", content })}\n`);
          });
          return { ...direct, run: contextOnlyRunSummary(target) };
        }
        if (isDirectProviderTarget(target)) {
          const guarded = await requestGuardedRepoWriteAIChatCompletion({
            provider: target.provider,
            messages: body.messages,
            context,
            repo: effectiveRepo,
            attachments: body.attachments,
            modelBehavior: body.modelBehavior,
            signal: abortScope.signal,
            requester: options.aiProviderRequester,
            pathPolicy: guardedPathPolicy,
          });
          if (canWriteResponse(response)) response.write(`${JSON.stringify({ type: "delta", content: guarded.content })}\n`);
          return guarded;
        }
        const cli = await requestRepoWriteAIChatCompletion({ target, messages: body.messages, context, repo: effectiveRepo, attachments: body.attachments, modelBehavior: body.modelBehavior, runner: options.aiCommandRunner, signal: abortScope.signal });
        if (canWriteResponse(response)) response.write(`${JSON.stringify({ type: "delta", content: cli.content })}\n`);
        return cli;
        })();
        return { context, result };
      });
      if (canWriteResponse(response)) {
        response.write(`${JSON.stringify({ type: "done", message: { role: "assistant", content: execution.result.content }, context: execution.context, status: execution.result.status, run: execution.result.run })}\n`);
        response.end();
      }
    } catch (error) {
      if (!canWriteResponse(response)) return;
      if (!response.headersSent) {
        next(error);
        return;
      }
      const httpError = isHttpError(error) ? error : new HttpError(500, "Reader-Wiki AI Chat stream failed.");
      response.write(`${JSON.stringify({ type: "error", error: httpError.message, ...(httpError.details === undefined ? {} : { details: httpError.details }) })}\n`);
      response.end();
    } finally {
      activeAIRuns.delete(runId);
      abortScope.cleanup();
    }
  });

  router.post("/ai/cancel", (request, response, next) => {
    try {
      const runId = String(request.body?.runId || "");
      const run = activeAIRuns.get(runId);
      if (!run) throw new HttpError(404, "AI Chat run is no longer active.");
      run.abort();
      setNoStore(response);
      response.status(202).json({ runId, state: "canceling" });
    } catch (error) {
      next(error);
    }
  });

  router.post("/http-delivery/start", async (request, response, next) => {
    try {
      if (!httpDelivery) throw new HttpError(503, "HTTP Delivery is not available.");
      const repo = await registry.findRepository(String(request.body?.repoId || ""));
      const revision = await assertRepositoryRevision(repo, request.body?.expectedRevision);
      setNoStore(response);
      response.json(await httpDelivery.start({ repo, revision, path: String(request.body?.path || ""), baseUrl: requestBaseUrl(request) }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/http-delivery/stop", (request, response, next) => {
    try {
      if (!httpDelivery) throw new HttpError(503, "HTTP Delivery is not available.");
      setNoStore(response);
      response.json(httpDelivery.stop(String(request.body?.deliveryId || "")));
    } catch (error) {
      next(error);
    }
  });

  router.get("/image", async (request, response, next) => {
    try {
      const repo = await registry.findRepository(String(request.query.repo || ""));
      const revision = await assertRepositoryRevision(repo, request.query.revision);
      const image = await resolveRepoImage(repo, request.query.path);
      setNoStore(response);
      response.setHeader("Content-Type", image.mimeType);
      response.setHeader("Content-Length", String(image.byteLength));
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("X-Reader-Wiki-Revision", revision);
      if (image.mimeType === "image/svg+xml") {
        response.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-ancestors 'none'");
      }
      response.send(image.bytes);
    } catch (error) {
      next(error);
    }
  });

  router.get("/pdf", async (request, response, next) => {
    try {
      const repo = await registry.findRepository(String(request.query.repo || ""));
      const revision = await assertRepositoryRevision(repo, request.query.revision);
      const pdf = await resolveRepoPdf(repo, request.query.path);
      setNoStore(response);
      response.setHeader("Content-Type", pdf.mimeType);
      response.setHeader("Content-Length", String(pdf.byteLength));
      response.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(path.basename(pdf.relativePath))}`);
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("X-Reader-Wiki-Revision", revision);
      response.send(pdf.bytes);
    } catch (error) {
      next(error);
    }
  });

  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    const httpError = isHttpError(error) ? error : new HttpError(500, "Reader-Wiki API failed.");
    response.status(httpError.status).json({ error: httpError.message, ...(httpError.details === undefined ? {} : { details: httpError.details }) });
  });

  return router;
}

function resolveAIChatTarget(body: AIChatRequest): AIChatExecutionTarget {
  const rawTarget = body.target as unknown as { kind?: string; entry?: string; provider?: AIProviderSettings; status?: unknown } | undefined;
  const target = rawTarget || (body.provider ? { kind: "provider", provider: body.provider } : null);
  if (!target) throw new HttpError(400, "Select an AI Chat target.");
  if (target.kind === "codexCli") return { kind: "codexCli", entry: "codexCli", status: target.status as AIChatExecutionTarget["status"] };
  if (target.kind === "claudeCli") return { kind: "claudeCli", entry: "claudeCli", status: target.status as AIChatExecutionTarget["status"] };
  if (target.kind === "codexBackedProvider" && target.provider) return { kind: "codexBackedProvider", provider: target.provider, status: target.status as AIChatExecutionTarget["status"] };
  if (target.kind === "codexBackedLocal" && target.provider) return { kind: "codexBackedLocal", provider: target.provider, status: target.status as AIChatExecutionTarget["status"] };
  if (target.kind === "cli" && target.entry === "codexCli") return { kind: "codexCli", entry: "codexCli", status: target.status as AIChatExecutionTarget["status"] };
  if (target.kind === "cli" && target.entry === "claudeCli") return { kind: "claudeCli", entry: "claudeCli", status: target.status as AIChatExecutionTarget["status"] };
  if (target.kind === "provider" && target.provider?.entry === "localAi") return { kind: "codexBackedLocal", provider: target.provider, status: target.status as AIChatExecutionTarget["status"] };
  if (target.kind === "provider" && target.provider) return { kind: "codexBackedProvider", provider: target.provider, status: target.status as AIChatExecutionTarget["status"] };
  throw new HttpError(400, "Unknown AI Chat target.");
}

function assertAIChatTargetReady(target: AIChatExecutionTarget): void {
  if (target.kind === "codexBackedProvider" || target.kind === "codexBackedLocal") {
    const readiness = providerReadiness(target.provider);
    if (readiness.state !== "ready") throw new HttpError(400, readiness.message);
  }
  if (target.status?.state !== "ready" || target.status.code !== "success") {
    throw new HttpError(409, "AI Entry readiness is not confirmed.");
  }
}

function setNoStore(response: Response): void {
  response.setHeader("Cache-Control", "no-store, max-age=0");
}

function requestBaseUrl(request: Request): string {
  const protocol = request.protocol || "http";
  return `${protocol}://${request.get("host") || "localhost"}`;
}

function isDirectProviderTarget(target: AIChatExecutionTarget): target is Extract<AIChatExecutionTarget, { kind: "codexBackedProvider" | "codexBackedLocal" }> {
  return target.kind === "codexBackedProvider" || target.kind === "codexBackedLocal";
}

function isCliTarget(target: AIChatExecutionTarget): target is Extract<AIChatExecutionTarget, { kind: "codexCli" | "claudeCli" }> {
  return target.kind === "codexCli" || target.kind === "claudeCli";
}

function usesGuardedRepoContext(target: AIChatExecutionTarget): boolean {
  return isDirectProviderTarget(target) && providerExecutionMode(target.provider) === "repoWrite";
}

function contextOnlyRunSummary(target: Extract<AIChatExecutionTarget, { kind: "codexBackedProvider" | "codexBackedLocal" }>): AIChatRunSummary {
  return {
    accessMode: "readOnly",
    entry: target.provider.entry,
    substrate: "directProvider",
    auditState: "verified",
    changedPaths: [],
    repairs: [],
    warnings: ["Context-only execution: Reader-Wiki did not grant repository write tools."],
  };
}

function providerExecutionMode(provider: AIProviderSettings): "readOnly" | "repoWrite" {
  return provider.executionMode === "repoWrite" ? "repoWrite" : "readOnly";
}

function requestAbortScope(request: Request, response: Response): { signal: AbortSignal; abort: () => void; cleanup: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const close = () => {
    if (!response.writableEnded) controller.abort();
  };
  request.once("aborted", abort);
  response.once("close", close);
  return {
    signal: controller.signal,
    abort,
    cleanup: () => {
      request.removeListener("aborted", abort);
      response.removeListener("close", close);
    },
  };
}

function readinessAttestationKey(entry: AIEntryKind, repoId: string, revision: string, provider: AIProviderSettings | undefined): string {
  const fingerprint = createHash("sha256").update(JSON.stringify(providerAttestationSnapshot(provider))).digest("hex");
  const scope = entry === "codexCli" || entry === "claudeCli" ? "cli-session" : `${repoId}:${revision}`;
  return `${entry}:${scope}:${fingerprint}`;
}

async function assertCliWorkspaceWritable(repo: RepositoryConfig): Promise<void> {
  const workspace = await resolveAIWorkspace(repo);
  try {
    await access(workspace.root, constants.W_OK);
  } catch {
    throw new HttpError(409, "The selected Current repo is not writable by the Reader-Wiki process.", { code: "workspace_not_ready" });
  }
}

function providerAttestationSnapshot(provider: AIProviderSettings | undefined): Record<string, string> {
  if (!provider) return {};
  return {
    entry: provider.entry,
    provider: provider.provider || "",
    runtime: provider.runtime || "",
    model: provider.model,
    baseUrl: provider.baseUrl,
    apiFormat: provider.apiFormat,
    credential: provider.credential || "",
    executionMode: providerExecutionMode(provider),
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function canWriteResponse(response: Response): boolean {
  return !response.destroyed && response.writable && !response.writableEnded;
}

function hasUnverifiedProcessTree(error: unknown): boolean {
  if (!isHttpError(error) || !error.details || typeof error.details !== "object") return false;
  return (error.details as { processTreeUnverified?: unknown }).processTreeUnverified === true;
}

function targetEntry(target: AIChatExecutionTarget): AIEntryKind {
  if (target.kind === "codexCli" || target.kind === "claudeCli") return target.entry;
  return target.provider.entry;
}

function normalizeAIEntryKind(entry: unknown): AIEntryKind {
  if (entry === "aiApi" || entry === "localAi" || entry === "codexCli" || entry === "claudeCli") return entry;
  throw new HttpError(400, "Unknown AI entry.");
}
