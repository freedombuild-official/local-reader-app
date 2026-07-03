import path from "node:path";

export type DisplayFileKind = "markdown" | "code" | "text" | "html" | "image" | "pdf";
export type TextFileKind = Exclude<DisplayFileKind, "image" | "pdf">;

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mkdn"]);
const HTML_EXTENSIONS = new Set([".html", ".htm"]);
export const JSON_EXTENSIONS = new Set([".json", ".jsonc"]);
export const CONFIG_EXTENSIONS = new Set([".cfg", ".conf", ".editorconfig", ".ini", ".properties", ".toml", ".yaml", ".yml"]);
export const CODE_EXTENSIONS = new Set([
  ".astro",
  ".bash",
  ".bat",
  ".c",
  ".cc",
  ".cmd",
  ".cpp",
  ".cs",
  ".css",
  ".cxx",
  ".dockerfile",
  ".fish",
  ".go",
  ".gql",
  ".gradle",
  ".graphql",
  ".h",
  ".hpp",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".less",
  ".mjs",
  ".mk",
  ".php",
  ".plist",
  ".proto",
  ".ps1",
  ".py",
  ".rb",
  ".rs",
  ".rss",
  ".sass",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".swift",
  ".thrift",
  ".ts",
  ".tsx",
  ".vue",
  ".xml",
  ".xsd",
  ".xsl",
  ".xslt",
  ".zsh",
]);
export const TEXT_EXTENSIONS = new Set([".csv", ".diff", ".eml", ".ics", ".list", ".log", ".patch", ".rtf", ".tsv", ".txt", ".vcf"]);
const IMAGE_MIME_TYPES = new Map([
  [".gif", "image/gif"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);
const UNSUPPORTED_EXTENSIONS = new Set([
  ".7z",
  ".db",
  ".dmg",
  ".doc",
  ".docm",
  ".exe",
  ".gz",
  ".msi",
  ".pkg",
  ".ppt",
  ".pptx",
  ".rar",
  ".sqlite",
  ".sqlite3",
  ".tar",
  ".tgz",
  ".xls",
  ".xlsm",
  ".xlsx",
  ".zip",
]);
const SPECIAL_CODE_FILENAMES = new Set([
  ".babelrc",
  ".dockerignore",
  ".editorconfig",
  ".eslintrc",
  ".gitattributes",
  ".gitignore",
  ".npmrc",
  ".nvmrc",
  ".prettierrc",
  "brewfile",
  "cargo.lock",
  "cargo.toml",
  "dockerfile",
  "gemfile",
  "go.mod",
  "go.sum",
  "makefile",
  "package-lock.json",
  "podfile",
  "procfile",
  "pnpm-lock.yaml",
  "pyproject.toml",
  "rakefile",
  "requirements.txt",
  "yarn.lock",
]);

export function getFileExtension(filePath: string): string {
  return path.posix.extname(filePath).toLowerCase();
}

export function classifyRepoFileName(filePath: string): DisplayFileKind {
  if (getImageMimeTypeForPath(filePath)) return "image";
  if (isPdfFileName(filePath)) return "pdf";
  return classifyTextFileName(filePath) || "text";
}

export function classifyTextFileName(filePath: string): TextFileKind | null {
  const extension = getFileExtension(filePath);
  const baseName = getBaseName(filePath).toLowerCase();
  if (MARKDOWN_EXTENSIONS.has(extension)) return "markdown";
  if (HTML_EXTENSIONS.has(extension)) return "html";
  if (isCodeFileName(baseName, extension) || JSON_EXTENSIONS.has(extension) || CONFIG_EXTENSIONS.has(extension)) return "code";
  if (TEXT_EXTENSIONS.has(extension) || !extension) return "text";
  return null;
}

export function getImageMimeTypeForPath(filePath: string): string | null {
  return IMAGE_MIME_TYPES.get(getFileExtension(filePath)) || null;
}

export function isPdfFileName(filePath: string): boolean {
  return getFileExtension(filePath) === ".pdf";
}

export function isDocxFileName(filePath: string): boolean {
  return getFileExtension(filePath) === ".docx";
}

export function isUnsupportedViewerFileName(filePath: string): boolean {
  return UNSUPPORTED_EXTENSIONS.has(getFileExtension(filePath));
}

export function isCodeFileName(filePath: string, knownExtension?: string): boolean {
  const baseName = getBaseName(filePath).toLowerCase();
  const extension = knownExtension ?? getFileExtension(baseName);
  return CODE_EXTENSIONS.has(extension) || SPECIAL_CODE_FILENAMES.has(baseName) || isEnvFileName(baseName);
}

function isEnvFileName(baseName: string): boolean {
  return baseName === ".env" || baseName.startsWith(".env.");
}

function getBaseName(filePath: string): string {
  return filePath.replaceAll("\\", "/").split("/").pop() || "";
}
