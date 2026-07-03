import express, { type Express } from "express";
import type { Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { createApiRouter } from "./api.js";
import { createHttpDeliveryService } from "./httpDelivery.js";
import { createRepositoryRegistry, type RepositoryRegistry } from "./repositoryRegistry.js";

export type ReaderWikiServerOptions = {
  dev?: boolean;
  packageRoot?: string;
  configPath?: string;
  distPath?: string;
  repositoryRegistry?: RepositoryRegistry;
  host?: string;
  port?: number;
  hmrPort?: number;
};

export type ReaderWikiServerHandle = {
  app: Express;
  server: Server;
  url: string;
  port: number;
  close: () => Promise<void>;
};

export async function startReaderWikiServer(options: ReaderWikiServerOptions = {}): Promise<ReaderWikiServerHandle> {
  const packageRoot = path.resolve(options.packageRoot || process.cwd());
  const configPath = path.resolve(options.configPath || path.join(packageRoot, "repositories.yaml"));
  const distPath = path.resolve(options.distPath || path.join(packageRoot, "dist"));
  const port = options.port ?? 5173;
  const repositoryRegistry = options.repositoryRegistry || createRepositoryRegistry({ configPath });
  const httpDelivery = createHttpDeliveryService(repositoryRegistry);
  const app = express();

  app.use("/api", createApiRouter(repositoryRegistry, httpDelivery));
  app.use("/delivery", httpDelivery.router);

  const hmrPort = options.dev ? await resolveHmrPort(options.hmrPort, options.host) : undefined;
  const vite = options.dev ? await createViteMiddleware({ packageRoot, hmrPort }) : null;
  if (vite) {
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distPath));
    app.get("*", (_request, response) => response.sendFile(path.join(distPath, "index.html")));
  }

  const server = await listen(app, port, options.host);
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const urlHost = options.host || "localhost";
  return {
    app,
    server,
    url: `http://${urlHost}:${actualPort}`,
    port: actualPort,
    close: async () => {
      await closeServer(server);
      if (vite) await vite.close();
    },
  };
}

async function createViteMiddleware({ packageRoot, hmrPort }: { packageRoot: string; hmrPort?: number }) {
  const { createServer } = await import("vite");
  return createServer({
    root: packageRoot,
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

function listen(app: Express, port: number, host?: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = host ? app.listen(port, host) : app.listen(port);
    server.once("listening", () => resolve(server));
    server.once("error", reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
