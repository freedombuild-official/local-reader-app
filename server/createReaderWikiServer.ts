import express, { type Express } from "express";
import type { Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { createApiRouter } from "./api.js";
import type { AICommandRunner } from "./aiCliAdapters.js";
import { createDefaultAiCliSetupService, type AiCliSetupService } from "./aiCliSetup.js";
import { createHttpDeliveryService } from "./httpDelivery.js";
import { createHtmlPreviewService } from "./htmlPreviewServer.js";
import { createRepositoryRegistry, type RepositoryRegistry } from "./repositoryRegistry.js";
import { createReaderWikiSecurity, formatUrlHost, isLoopbackHost } from "./security.js";

export type ReaderWikiServerOptions = {
  dev?: boolean;
  packageRoot?: string;
  configPath?: string;
  distPath?: string;
  repositoryRegistry?: RepositoryRegistry;
  host?: string;
  port?: number;
  hmrPort?: number;
  allowNonLoopback?: boolean;
  sessionToken?: string;
  aiCliSetupService?: AiCliSetupService;
  aiCommandRunner?: AICommandRunner;
};

export type ReaderWikiServerHandle = {
  app: Express;
  server: Server;
  url: string;
  port: number;
  sessionToken: string;
  close: () => Promise<void>;
};

export async function startReaderWikiServer(options: ReaderWikiServerOptions = {}): Promise<ReaderWikiServerHandle> {
  const packageRoot = path.resolve(options.packageRoot || process.cwd());
  const configPath = path.resolve(options.configPath || path.join(packageRoot, "repositories.yaml"));
  const distPath = path.resolve(options.distPath || path.join(packageRoot, "dist"));
  const port = options.port ?? 5173;
  const host = options.host || "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error("Local Reader App is a loopback-only application and refuses non-loopback binding.");
  }
  const repositoryRegistry = options.repositoryRegistry || createRepositoryRegistry({ configPath });
  const httpDelivery = createHttpDeliveryService(repositoryRegistry);
  const htmlPreview = createHtmlPreviewService({ repositoryRegistry, bindHost: host });
  const aiCliSetupService = options.aiCliSetupService || createDefaultAiCliSetupService(packageRoot);
  const aiRequestShutdownController = new AbortController();
  const security = createReaderWikiSecurity({ bindHost: host, token: options.sessionToken, dev: options.dev });
  const app = express();

  app.disable("x-powered-by");
  app.use(security.headers);
  app.use(security.issueSession);
  app.use("/api", security.protectApi, createApiRouter(repositoryRegistry, httpDelivery, {
    configPath,
    packageRoot,
    aiCliSetupService,
    aiCommandRunner: options.aiCommandRunner,
    shutdownSignal: aiRequestShutdownController.signal,
    htmlPreview,
  }));
  app.use("/delivery", httpDelivery.router);

  const hmrPort = options.dev ? await resolveHmrPort(options.hmrPort, host) : undefined;
  const vite = options.dev ? await createViteMiddleware({ packageRoot, hmrPort }) : null;
  if (vite) {
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distPath));
    app.get("*", (_request, response) => response.sendFile(path.join(distPath, "index.html")));
  }

  const server = await listen(app, port, host);
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  security.setPort(actualPort);
  let closePromise: Promise<void> | null = null;
  return {
    app,
    server,
    url: `http://${formatUrlHost(host)}:${actualPort}`,
    port: actualPort,
    sessionToken: security.token,
    close: () => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        aiRequestShutdownController.abort();
        const results = await Promise.allSettled([
          closeServer(server),
          htmlPreview.dispose(),
          aiCliSetupService.shutdown(),
          ...(vite ? [vite.close()] : []),
        ]);
        const failures = results
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map((result) => result.reason);
        try {
          aiCliSetupService.assertNoUnverifiedProcessTree();
        } catch (error) {
          if (!failures.includes(error)) failures.push(error);
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "Local Reader App shutdown did not complete cleanly.");
      })();
      return closePromise;
    },
  };
}

async function createViteMiddleware({ packageRoot, hmrPort }: { packageRoot: string; hmrPort?: number }) {
  const { createServer } = await import("vite");
  return createServer({
    root: packageRoot,
    configLoader: "runner",
    server: { middlewareMode: true, ...(hmrPort ? { hmr: { port: hmrPort } } : {}) },
    appType: "spa",
  });
}

async function resolveHmrPort(hmrPort: number | undefined, host: string | undefined): Promise<number> {
  if (hmrPort && hmrPort > 0) return hmrPort;
  return findAvailablePort(host);
}

function findAvailablePort(host: string | undefined): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function listen(app: Express, port: number, host: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);
    server.once("listening", () => resolve(server));
    server.once("error", reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
