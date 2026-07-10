import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const chunkBudgetBytes = 500_000;
const totalBudgetBytes = 750_000;
const assetsDirectory = path.resolve("dist/assets");
const files = await readdir(assetsDirectory);
const javaScriptFiles = files.filter((file) => file.endsWith(".js"));
const entryCandidates = javaScriptFiles.filter((file) => /^index-.*\.js$/.test(file));
if (!entryCandidates.length) {
  console.error("Bundle budget failed: no Vite index JavaScript entry was found.");
  process.exitCode = 1;
} else {
  const results = await Promise.all(javaScriptFiles.map(async (file) => ({ file, bytes: (await stat(path.join(assetsDirectory, file))).size })));
  const entry = results.filter((result) => entryCandidates.includes(result.file)).sort((left, right) => right.bytes - left.bytes)[0];
  const oversized = results.filter((result) => result.bytes > chunkBudgetBytes);
  const totalBytes = results.reduce((total, result) => total + result.bytes, 0);
  if (oversized.length) {
    for (const result of oversized) console.error(`Bundle budget failed: ${result.file} is ${result.bytes} bytes; per-chunk limit is ${chunkBudgetBytes}.`);
    process.exitCode = 1;
  }
  if (totalBytes > totalBudgetBytes) {
    console.error(`Bundle budget failed: JavaScript chunks total ${totalBytes} bytes; total limit is ${totalBudgetBytes}.`);
    process.exitCode = 1;
  }
  if (!process.exitCode) {
    console.log(`Bundle budget passed: ${entry.file} is ${entry.bytes} bytes; ${results.length} JavaScript chunk(s) total ${totalBytes} bytes (limits ${chunkBudgetBytes} per chunk / ${totalBudgetBytes} total).`);
  }
}
