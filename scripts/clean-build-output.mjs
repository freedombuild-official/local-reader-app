import { rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const generatedDirectories = ["dist", "dist-server"];

for (const directory of generatedDirectories) {
  const target = path.join(projectRoot, directory);
  if (path.dirname(target) !== projectRoot || path.basename(target) !== directory) {
    throw new Error(`Refusing to clean unexpected path: ${target}`);
  }
  await rm(target, { recursive: true, force: true });
}

console.log(`Cleaned generated build output: ${generatedDirectories.join(", ")}`);
