import path from "node:path";
import { json as expressJson, type NextFunction, type Request, type Response, Router } from "express";
import { HttpError, isHttpError } from "./errors.js";
import { buildAIChatContext } from "./aiContext.js";
import { requestCliAIChatCompletion, type AICommandRunner } from "./aiCliAdapters.js";
import { probeCliEntryReadiness } from "./aiEntries.js";
import { providerReadiness, requestAIChatCompletion, requestAIChatCompletionStream, testAIConnection } from "./aiProviders.js";
import type { HttpDeliveryService } from "./httpDelivery.js";
import { createRepositoryRegistry, type RepositoryRegistry } from "./repositoryRegistry.js";
import { loadRepositoryConfigState, previewRepositoryConfig, saveRepositoryConfigDraft, validateRepositoryConfigDraft } from "./repositoryConfig.js";
import { readGitStatusEntries, readRepoFile, readTree, readTreeSnapshot, resolveRepoImage, resolveRepoPdf, syncRepository } from "./repoFiles.js";
import type { AIChatExecutionTarget, AIChatRequest, AIProviderSettings, RepositoryConfigDraft } from "./types.js";

type ApiRouterOptions = {
  configPath?: string;
  packageRoot?: string;
  aiCommandRunner?: AICommandRunner;
};

export function createApiRouter(registryOrConfigPath: RepositoryRegistry | string, httpDelivery?: HttpDeliveryService, options: ApiRouterOptions = {}): Router {
  const router = Router();
  const registry = typeof registryOrConfigPath === "string" ? createRepositoryRegistry({ configPath: registryOrConfigPath }) : registryOrConfigPath;
  const configPath = path.resolve(options.configPath || (typeof registryOrConfigPath === "string" ? registryOrConfigPath : registry.configPath || path.join(process.cwd(), "repositories.yaml")));
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
      response.json({ repoId: repo.id, path: String(request.query.path || ""), nodes: await readTree(repo, request.query.path) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/git-status", async (request, response, next) => {
    try {
      const repo = await registry.findRepository(String(request.query.repo || ""));
      setNoStore(response);
      response.json({ repoId: repo.id, statuses: await readGitStatusEntries(repo) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/repo-open", async (request, response, next) => {
    try {
      const repo = await registry.findRepository(String(request.body?.repoId || ""));
      setNoStore(response);
      const sync = await syncRepository(repo);
      const tree = await readTreeSnapshot(repo);
      response.json({ repoId: repo.id, sync, tree });
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
    try {
      setNoStore(response);
      response.json(await saveRepositoryConfigDraft(request.body as RepositoryConfigDraft, configPath));
    } catch (error) {
      next(error);
    }
  });

  router.get("/file", async (request, response, next) => {
    try {
      const repo = await registry.findRepository(String(request.query.repo || ""));
      setNoStore(response);
      response.json(await readRepoFile(repo, request.query.path));
    } catch (error) {
      next(error);
    }
  });

  router.get("/http-delivery/status", (_request, response) => {
    setNoStore(response);
    response.json(httpDelivery?.status() || { state: "idle", items: [] });
  });

  router.post("/ai/test-connection", async (request, response, next) => {
    try {
      setNoStore(response);
      response.json(await testAIConnection(request.body as AIProviderSettings));
    } catch (error) {
      next(error);
    }
  });

  router.post("/ai/entry-readiness", async (request, response, next) => {
    try {
      setNoStore(response);
      const entry = String(request.body?.entry || "");
      if (entry !== "codexCli" && entry !== "claudeCli") throw new HttpError(400, "Unknown CLI entry.");
      response.json(await probeCliEntryReadiness(entry, options.aiCommandRunner));
    } catch (error) {
      next(error);
    }
  });

  router.post("/ai/chat", async (request, response, next) => {
    try {
      const body = request.body as AIChatRequest;
      setNoStore(response);
      const target = resolveAIChatTarget(body);
      assertAIChatTargetReady(target);
      const context = await buildAIChatContext(registry, body.context);
      const result = target.kind === "provider"
        ? await requestAIChatCompletion({ provider: target.provider, messages: body.messages, context, attachments: body.attachments, modelBehavior: body.modelBehavior })
        : await requestCheckedCliAIChatCompletion({ entry: target.entry, messages: body.messages, context, attachments: body.attachments, modelBehavior: body.modelBehavior, runner: options.aiCommandRunner });
      response.json({ message: { role: "assistant", content: result.content }, context, status: result.status });
    } catch (error) {
      next(error);
    }
  });

  router.post("/ai/chat/stream", async (request, response, next) => {
    const body = request.body as AIChatRequest;
    try {
      const target = resolveAIChatTarget(body);
      assertAIChatTargetReady(target);
      const context = await buildAIChatContext(registry, body.context);
      setNoStore(response);
      response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.write(`${JSON.stringify({ type: "meta", context })}\n`);
      const result = target.kind === "provider"
        ? await requestAIChatCompletionStream(
            { provider: target.provider, messages: body.messages, context, attachments: body.attachments, modelBehavior: body.modelBehavior },
            (content) => response.write(`${JSON.stringify({ type: "delta", content })}\n`),
          )
        : await requestCheckedCliAIChatCompletion({ entry: target.entry, messages: body.messages, context, attachments: body.attachments, modelBehavior: body.modelBehavior, runner: options.aiCommandRunner });
      if (target.kind === "cli") response.write(`${JSON.stringify({ type: "delta", content: result.content })}\n`);
      response.write(`${JSON.stringify({ type: "done", message: { role: "assistant", content: result.content }, context, status: result.status })}\n`);
      response.end();
    } catch (error) {
      if (!response.headersSent) {
        next(error);
        return;
      }
      const httpError = isHttpError(error) ? error : new HttpError(500, "Reader-Wiki AI Chat stream failed.");
      response.write(`${JSON.stringify({ type: "error", error: httpError.message })}\n`);
      response.end();
    }
  });

  router.post("/http-delivery/start", async (request, response, next) => {
    try {
      if (!httpDelivery) throw new HttpError(503, "HTTP Delivery is not available.");
      setNoStore(response);
      response.json(await httpDelivery.start({ repoId: String(request.body?.repoId || ""), path: String(request.body?.path || ""), baseUrl: requestBaseUrl(request) }));
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
      const image = await resolveRepoImage(repo, request.query.path);
      setNoStore(response);
      response.setHeader("Content-Type", image.mimeType);
      response.setHeader("Content-Length", String(image.byteLength));
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.sendFile(image.realPath, (error) => {
        if (error) next(error);
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/pdf", async (request, response, next) => {
    try {
      const repo = await registry.findRepository(String(request.query.repo || ""));
      const pdf = await resolveRepoPdf(repo, request.query.path);
      setNoStore(response);
      response.setHeader("Content-Type", pdf.mimeType);
      response.setHeader("Content-Length", String(pdf.byteLength));
      response.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(path.basename(pdf.relativePath))}`);
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.sendFile(pdf.realPath, (error) => {
        if (error) next(error);
      });
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
    response.status(httpError.status).json({ error: httpError.message });
  });

  return router;
}

function resolveAIChatTarget(body: AIChatRequest): AIChatExecutionTarget {
  const target = body.target || (body.provider ? { kind: "provider" as const, provider: body.provider } : null);
  if (!target) throw new HttpError(400, "Select an AI Chat target.");
  return target;
}

function assertAIChatTargetReady(target: AIChatExecutionTarget): void {
  if (target.kind === "cli") return;
  const readiness = providerReadiness(target.provider);
  if (readiness.state !== "ready") throw new HttpError(400, readiness.message);
  if (target.status?.state !== "ready" || target.status.code !== "success") {
    throw new HttpError(409, "AI Entry readiness is not confirmed.");
  }
}

function setNoStore(response: Response): void {
  response.setHeader("Cache-Control", "no-store, max-age=0");
}

function requestBaseUrl(request: Request): string {
  const forwardedProto = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProto || request.protocol || "http";
  return `${protocol}://${request.get("host") || "localhost"}`;
}

async function requestCheckedCliAIChatCompletion(request: Parameters<typeof requestCliAIChatCompletion>[0]) {
  const readiness = await probeCliEntryReadiness(request.entry, request.runner);
  if (!readiness.ready) throw new HttpError(409, readiness.status.message || "CLI readiness is not confirmed.");
  return requestCliAIChatCompletion(request);
}
