import { rmSync } from "node:fs";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function startJudgeSample({ packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url))) } = {}) {
  const configuredSampleRoot = String(process.env.LOCAL_READER_APP_JUDGE_SAMPLE_ROOT || "").trim();
  if (configuredSampleRoot && !path.isAbsolute(configuredSampleRoot)) {
    throw new Error("LOCAL_READER_APP_JUDGE_SAMPLE_ROOT must be an absolute path.");
  }
  const sampleRoot = configuredSampleRoot || path.join(packageRoot, "examples", "build-week-demo");
  const serverEntry = path.join(packageRoot, "dist-server", "server", "index.js");
  const templatePath = path.join(packageRoot, "sample.repositories.yaml");
  await Promise.all([access(sampleRoot), access(serverEntry), access(templatePath)]);

  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "local-reader-app-judge-"));
  const configPath = path.join(temporaryRoot, "repositories.yaml");
  const template = await readFile(templatePath, "utf8");
  const escapedSampleRoot = sampleRoot.replaceAll("'", "''");
  const renderedConfig = template.replace("__SAMPLE_ROOT__", escapedSampleRoot);
  if (renderedConfig === template) throw new Error("sample.repositories.yaml is missing the __SAMPLE_ROOT__ token.");
  await writeFile(configPath, renderedConfig, { encoding: "utf8", mode: 0o600 });

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    rmSync(temporaryRoot, { recursive: true, force: true });
    cleanedUp = true;
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
  process.once("exit", cleanup);

  process.env.HOST = process.env.HOST || "127.0.0.1";
  process.env.PORT = process.env.PORT || "5173";
  process.env.LOCAL_READER_APP_CONFIG = configPath;
  try {
    await import(`${pathToFileURL(serverEntry).href}?judge=${Date.now()}`);
    await new Promise(() => {});
  } catch (error) {
    cleanup();
    throw error;
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  startJudgeSample()
    .catch((error) => {
      console.error(`start-judge: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
