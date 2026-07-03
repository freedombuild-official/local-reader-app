import path from "node:path";
import { json as expressJson, type NextFunction, type Request, type Response, Router } from "express";
import { HttpError, isHttpError } from "./errors.js";
import type { HttpDeliveryService } from "./httpDelivery.js";
import { createRepositoryRegistry, type RepositoryRegistry } from "./repositoryRegistry.js";
import { readGitStatusEntries, readRepoFile, readTree, readTreeSnapshot, resolveRepoImage, resolveRepoPdf, syncRepository } from "./repoFiles.js";

export function createApiRouter(registryOrConfigPath: RepositoryRegistry | string, httpDelivery?: HttpDeliveryService): Router {
  const router = Router();
  const registry = typeof registryOrConfigPath === "string" ? createRepositoryRegistry({ configPath: registryOrConfigPath }) : registryOrConfigPath;
  router.use("/http-delivery", expressJson({ limit: "20kb" }));
  router.use("/repo-open", expressJson({ limit: "20kb" }));

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
    response.json(httpDelivery?.status() || { state: "idle", sessions: [] });
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
      response.json(httpDelivery.stop(String(request.body?.sessionId || "")));
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

function setNoStore(response: Response): void {
  response.setHeader("Cache-Control", "no-store, max-age=0");
}

function requestBaseUrl(request: Request): string {
  const forwardedProto = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProto || request.protocol || "http";
  return `${protocol}://${request.get("host") || "localhost"}`;
}
