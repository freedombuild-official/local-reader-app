import { classifyTextFileName, getFileExtension, type TextFileKind } from "../shared/fileClassification.js";

const MIB = 1024 * 1024;

export const PDF_VIEWER_MAX_BYTES = 80 * MIB;

export const IMAGE_VIEWER_MAX_BYTES_BY_EXTENSION: Readonly<Record<string, number>> = {
  ".gif": 25 * MIB,
  ".jpeg": 50 * MIB,
  ".jpg": 50 * MIB,
  ".png": 40 * MIB,
  ".svg": 10 * MIB,
  ".webp": 50 * MIB,
};

export const TEXT_VIEWER_MAX_BYTES_BY_KIND: Readonly<Record<TextFileKind, number>> = {
  markdown: 2_500_000,
  html: 2_500_000,
  code: 3_000_000,
  text: 3_000_000,
};

export const DOCX_VIEWER_MAX_BYTES = 20 * MIB;
export const DOCX_VIEWER_MAX_ENTRIES = 500;
export const DOCX_VIEWER_MAX_DOCUMENT_XML_BYTES = 3 * MIB;
export const DOCX_VIEWER_MAX_MARKDOWN_CHARS = 1_500_000;

export function getTextViewerByteLimit(filePath: string): number {
  return TEXT_VIEWER_MAX_BYTES_BY_KIND[classifyTextFileName(filePath) || "text"];
}

export function getImageViewerByteLimit(filePath: string): number | null {
  return IMAGE_VIEWER_MAX_BYTES_BY_EXTENSION[getFileExtension(filePath)] ?? null;
}
