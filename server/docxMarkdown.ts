import { SaxesParser } from "saxes";
import * as yauzl from "yauzl";
import { HttpError, isHttpError } from "./errors.js";
import {
  DOCX_VIEWER_MAX_BYTES,
  DOCX_VIEWER_MAX_DOCUMENT_XML_BYTES,
  DOCX_VIEWER_MAX_ENTRIES,
  DOCX_VIEWER_MAX_MARKDOWN_CHARS,
} from "./viewerLimits.js";

const WORD_DOCUMENT_ENTRY = "word/document.xml";
const DOCX_MARKDOWN_UNSUPPORTED_MESSAGE = "This .docx file does not contain Markdown source that Reader-Wiki can render.";

export async function extractMarkdownFromDocx(filePath: string, byteLength: number): Promise<string> {
  if (byteLength > DOCX_VIEWER_MAX_BYTES) throw new HttpError(413, "The .docx file is too large to display.");
  const documentXml = await readDocxDocumentXml(filePath);
  const markdown = extractTextFromWordDocumentXml(documentXml);
  if (!isMarkdownSource(markdown)) throw new HttpError(415, DOCX_MARKDOWN_UNSUPPORTED_MESSAGE);
  return markdown;
}

export async function extractMarkdownFromDocxBuffer(buffer: Buffer): Promise<string> {
  if (buffer.byteLength > DOCX_VIEWER_MAX_BYTES) throw new HttpError(413, "The .docx file is too large to display.");
  const documentXml = await readDocxDocumentXml(buffer);
  const markdown = extractTextFromWordDocumentXml(documentXml);
  if (!isMarkdownSource(markdown)) throw new HttpError(415, DOCX_MARKDOWN_UNSUPPORTED_MESSAGE);
  return markdown;
}

async function readDocxDocumentXml(source: string | Buffer): Promise<string> {
  try {
    return await readZipEntry(source, WORD_DOCUMENT_ENTRY);
  } catch (error) {
    if (isHttpError(error)) throw error;
    throw new HttpError(415, "The .docx file could not be read.");
  }
}

async function readZipEntry(source: string | Buffer, targetEntryName: string): Promise<string> {
  const options = { lazyEntries: true, strictFileNames: true, validateEntrySizes: true };
  const zipFile = Buffer.isBuffer(source) ? await yauzl.fromBufferPromise(source, options) : await yauzl.openPromise(source, options);
  return new Promise((resolve, reject) => {
      if (zipFile.entryCount > DOCX_VIEWER_MAX_ENTRIES) {
        zipFile.close();
        reject(new HttpError(413, "The .docx internal structure is too large to display."));
        return;
      }

      let settled = false;
      let found = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        zipFile.close();
        reject(error);
      };
      const finish = (content: string) => {
        if (settled) return;
        settled = true;
        zipFile.close();
        resolve(content);
      };

      zipFile.on("entry", (entry) => {
        if (entry.fileName !== targetEntryName) {
          zipFile.readEntry();
          return;
        }
        found = true;
        if (entry.isEncrypted()) {
          fail(new HttpError(415, "Encrypted .docx files cannot be displayed."));
          return;
        }
        if (entry.uncompressedSize > DOCX_VIEWER_MAX_DOCUMENT_XML_BYTES) {
          fail(new HttpError(413, "The .docx document XML is too large to display."));
          return;
        }

        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail(streamError || new Error("Failed to read .docx entry"));
            return;
          }
          const chunks: Buffer[] = [];
          let totalBytes = 0;
          stream.on("data", (chunk: Buffer) => {
            totalBytes += chunk.length;
            if (totalBytes > DOCX_VIEWER_MAX_DOCUMENT_XML_BYTES) {
              stream.destroy();
              fail(new HttpError(413, "The .docx document XML is too large to display."));
              return;
            }
            chunks.push(Buffer.from(chunk));
          });
          stream.on("error", fail);
          stream.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
        });
      });

      zipFile.once("end", () => {
        if (!found) fail(new HttpError(415, DOCX_MARKDOWN_UNSUPPORTED_MESSAGE));
      });
      zipFile.once("error", fail);
      zipFile.readEntry();
  });
}

function extractTextFromWordDocumentXml(xml: string): string {
  const parser = new SaxesParser({ xmlns: false });
  const paragraphs: string[] = [];
  let currentParagraph: string[] | null = null;
  let inText = false;
  let charCount = 0;

  const append = (text: string) => {
    if (!currentParagraph || !text) return;
    charCount += text.length;
    if (charCount > DOCX_VIEWER_MAX_MARKDOWN_CHARS) {
      throw new HttpError(413, "The Markdown extracted from .docx is too large to display.");
    }
    currentParagraph.push(text);
  };

  parser.on("opentag", (node) => {
    const name = localName(node.name);
    if (name === "p") {
      currentParagraph = [];
      inText = false;
      return;
    }
    if (!currentParagraph) return;
    if (name === "t") {
      inText = true;
      return;
    }
    if (name === "tab") append("\t");
    if (name === "br" || name === "cr") append("\n");
  });
  parser.on("text", (text) => {
    if (inText) append(text);
  });
  parser.on("closetag", (tag) => {
    const name = typeof tag === "string" ? localName(tag) : localName(tag.name);
    if (name === "t") {
      inText = false;
      return;
    }
    if (name === "p" && currentParagraph) {
      paragraphs.push(currentParagraph.join("").replace(/\r\n|\r/g, "\n"));
      currentParagraph = null;
      inText = false;
    }
  });

  try {
    parser.write(xml).close();
  } catch (error) {
    if (isHttpError(error)) throw error;
    throw new HttpError(415, "The .docx document XML could not be parsed.");
  }

  return paragraphs.join("\n").trim();
}

function isMarkdownSource(content: string): boolean {
  if (!content.trim()) return false;
  return [
    /^#{1,6}\s+\S/m,
    /!?\[[^\]\n]{1,200}\]\([^) \n]+(?:\s+"[^"\n]*")?\)/m,
    /^```[\s\S]*?^```/m,
    /^\s*\|.+\|\s*\n\s*\|(?:\s*:?-{3,}:?\s*\|)+/m,
  ].some((pattern) => pattern.test(content));
}

function localName(name: string): string {
  const separatorIndex = name.indexOf(":");
  return separatorIndex === -1 ? name : name.slice(separatorIndex + 1);
}
