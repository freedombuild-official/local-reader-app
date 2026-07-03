import path from "node:path";
import { fileURLToPath } from "node:url";
import { startReaderWikiServer, type ReaderWikiServerHandle } from "./createReaderWikiServer.js";

const args = new Set(process.argv.slice(2));
const isDev = args.has("--dev");
const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || undefined;
const hmrPort = process.env.VITE_HMR_PORT ? Number(process.env.VITE_HMR_PORT) : undefined;
const packageRoot = process.cwd();
const configPath = process.env.READER_WIKI_CONFIG || path.join(packageRoot, "repositories.yaml");
let serverHandle: ReaderWikiServerHandle | null = null;
let isShuttingDown = false;

async function main(): Promise<void> {
  serverHandle = await startReaderWikiServer({ dev: isDev, port, host, hmrPort, configPath, packageRoot });
  console.log(`Reader-Wiki listening on ${serverHandle.url}`);
  console.log(`Repository config: ${configPath}`);
}

async function shutdown(exitCode: number): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  const server = serverHandle;
  serverHandle = null;
  if (server) await server.close();
  process.exit(exitCode);
}

function signalExitCode(signal: NodeJS.Signals): number {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}

function installSignalHandler(signal: NodeJS.Signals): void {
  process.once(signal, () => {
    void shutdown(signalExitCode(signal)).catch((error) => {
      const scriptName = path.basename(fileURLToPath(import.meta.url));
      console.error(`${scriptName}: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
  });
}

installSignalHandler("SIGINT");
installSignalHandler("SIGTERM");

main().catch((error) => {
  const scriptName = path.basename(fileURLToPath(import.meta.url));
  console.error(`${scriptName}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
