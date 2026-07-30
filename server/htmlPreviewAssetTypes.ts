import path from "node:path";

const PREVIEW_ASSET_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".css",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".map",
  ".webmanifest",
  ".xml",
  ".yaml",
  ".yml",
  ".csv",
  ".txt",
  ".md",
  ".markdown",
  ".ts",
  ".tsx",
  ".jsx",
  ".toml",
  ".ini",
  ".cfg",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".bmp",
  ".ico",
  ".tif",
  ".tiff",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".wasm",
  ".mp3",
  ".wav",
  ".ogg",
  ".m4a",
  ".aac",
  ".mp4",
  ".webm",
  ".mov",
  ".vtt",
]);

const PREVIEW_WRITABLE_TEXT_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".css",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".map",
  ".webmanifest",
  ".xml",
  ".yaml",
  ".yml",
  ".csv",
  ".txt",
  ".md",
  ".markdown",
  ".ts",
  ".tsx",
  ".jsx",
  ".toml",
  ".ini",
  ".cfg",
  ".svg",
  ".vtt",
]);

export function isHtmlPreviewDocumentPath(filePath: string): boolean {
  return [".html", ".htm"].includes(path.extname(filePath).toLowerCase());
}

export function isHtmlPreviewAssetPath(filePath: string): boolean {
  return PREVIEW_ASSET_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function isHtmlPreviewWritableTextPath(filePath: string): boolean {
  return PREVIEW_WRITABLE_TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function htmlPreviewContentType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
    case ".htm":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "text/javascript; charset=utf-8";
    case ".ts":
    case ".tsx":
    case ".jsx":
      return "text/plain; charset=utf-8";
    case ".json":
    case ".map":
      return "application/json; charset=utf-8";
    case ".webmanifest":
      return "application/manifest+json; charset=utf-8";
    case ".xml":
      return "application/xml; charset=utf-8";
    case ".yaml":
    case ".yml":
      return "application/yaml; charset=utf-8";
    case ".csv":
      return "text/csv; charset=utf-8";
    case ".toml":
      return "application/toml; charset=utf-8";
    case ".ini":
    case ".cfg":
      return "text/plain; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".avif":
      return "image/avif";
    case ".bmp":
      return "image/bmp";
    case ".ico":
      return "image/x-icon";
    case ".tif":
    case ".tiff":
      return "image/tiff";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".ttf":
      return "font/ttf";
    case ".otf":
      return "font/otf";
    case ".eot":
      return "application/vnd.ms-fontobject";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".md":
    case ".markdown":
      return "text/markdown; charset=utf-8";
    case ".wasm":
      return "application/wasm";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".ogg":
      return "audio/ogg";
    case ".m4a":
      return "audio/mp4";
    case ".aac":
      return "audio/aac";
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".mov":
      return "video/quicktime";
    case ".vtt":
      return "text/vtt; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
