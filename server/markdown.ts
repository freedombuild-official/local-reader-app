import MarkdownIt from "markdown-it";
import path from "node:path";
import sanitizeHtml from "sanitize-html";
import { MARKDOWN_CODE_BLOCK_DATA_ATTR, injectMarkdownCodeToolbarButtons, installCodeBlockRule } from "../shared/markdownCodeBlocks.js";
import { MARKDOWN_TABLE_SCROLL_DATA_ATTR, installTableScrollRule } from "../shared/markdownTableScroll.js";
import { installTaskListRule } from "../shared/markdownTaskLists.js";

const markdown = new MarkdownIt({ html: true, linkify: false, typographer: false });
markdown.validateLink = () => true;
installTableScrollRule(markdown);
installCodeBlockRule(markdown);
installTaskListRule(markdown);

export type MarkdownRenderContext = {
  repoId: string;
  currentPath: string;
  repoRoot?: string;
};

export function renderMarkdown(content: string, context?: MarkdownRenderContext): { frontmatter: string; body: string; html: string } {
  const { frontmatter, body } = splitFrontmatter(content);
  const rawHtml = markdown.render(body);
  return {
    frontmatter,
    body,
    html: injectMarkdownCodeToolbarButtons(sanitizeHtml(rawHtml, createSanitizeOptions(context))),
  };
}

function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  if (!content.startsWith("---\n")) return { frontmatter: "", body: content };
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return { frontmatter: "", body: content };
  return { frontmatter: content.slice(4, end), body: content.slice(end + 5) };
}

function createSanitizeOptions(context?: MarkdownRenderContext): sanitizeHtml.IOptions {
  return {
    allowedTags: ["a", "blockquote", "br", "code", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "img", "input", "li", "ol", "p", "pre", "span", "strong", "table", "tbody", "td", "th", "thead", "tr", "ul"],
    allowedAttributes: {
      a: ["href", "rel", "target", "title"],
      div: ["class", MARKDOWN_CODE_BLOCK_DATA_ATTR, MARKDOWN_TABLE_SCROLL_DATA_ATTR],
      img: ["alt", "height", "loading", "src", "title", "width"],
      input: ["aria-label", "checked", "class", "disabled", "type"],
      li: ["class"],
      ol: ["start"],
      span: ["class"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["https"] },
    allowProtocolRelative: false,
    transformTags: {
      a: (tagName, attribs) => {
        if (attribs.target?.toLowerCase() !== "_blank") return { tagName, attribs };
        const relValues = new Set((attribs.rel || "").split(/\s+/).filter(Boolean));
        relValues.add("noopener");
        relValues.add("noreferrer");
        return { tagName, attribs: { ...attribs, rel: Array.from(relValues).join(" ") } };
      },
      img: (tagName, attribs) => {
        const src = resolveMarkdownImageSrc(attribs.src, context);
        const nextAttribs: Record<string, string> = { ...attribs, loading: attribs.loading || "lazy" };
        if (src) nextAttribs.src = src;
        else delete nextAttribs.src;
        return { tagName, attribs: nextAttribs };
      },
      input: (_tagName, attribs) => {
        if (attribs.type !== "checkbox" || !attribs.class?.split(/\s+/).includes("task-list-checkbox")) {
          return { tagName: "span", attribs: {} };
        }
        return {
          tagName: "input",
          attribs: {
            "aria-label": attribs["aria-label"] || "task item",
            class: "task-list-checkbox",
            disabled: "",
            type: "checkbox",
            ...(Object.prototype.hasOwnProperty.call(attribs, "checked") ? { checked: "" } : {}),
          },
        };
      },
    },
  };
}

function resolveMarkdownImageSrc(src: string | undefined, context?: MarkdownRenderContext): string | null {
  const value = (src || "").trim();
  if (!value) return null;
  if (value.startsWith("https://")) return value;
  if (!context) return value;
  if (value.startsWith("//") || value.includes("?") || value.includes("#")) return null;
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)) return null;

  const normalized = value.replaceAll("\\", "/");
  const pathInput = normalized.startsWith("/") ? normalized.slice(1) : path.posix.join(parentPath(context.currentPath), normalized);
  const repoRelativePath = normalizeRepoRelativePath(pathInput);
  if (!repoRelativePath) return null;
  const query = new URLSearchParams({ repo: context.repoId, path: repoRelativePath });
  return `/api/image?${query.toString()}`;
}

function parentPath(filePath: string): string {
  const parent = path.posix.dirname(filePath.replaceAll("\\", "/"));
  return parent === "." ? "" : parent;
}

function normalizeRepoRelativePath(input: string): string | null {
  const normalized = path.posix.normalize(input.replaceAll("\\", "/"));
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) return null;
  return normalized.replace(/^\.\//, "");
}
