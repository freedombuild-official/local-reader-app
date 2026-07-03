import type MarkdownIt from "markdown-it";

export const MARKDOWN_CODE_BLOCK_DATA_ATTR = "data-reader-wiki-code-block";
export const MARKDOWN_CODE_TOOLBAR_PLACEHOLDER = '<div class="markdown-code-block-toolbar"></div>';

const CODE_TOOLBAR_HTML = [
  '<div class="markdown-code-block-toolbar">',
  '<button type="button" class="markdown-code-action-button markdown-code-copy-button" data-copy-state="idle" aria-label="Copy code block" title="Copy code block">',
  '<span class="markdown-code-icon markdown-code-icon-copy" aria-hidden="true">',
  '<svg viewBox="0 0 24 24" focusable="false"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>',
  "</span>",
  '<span class="markdown-code-icon markdown-code-icon-check" aria-hidden="true">',
  '<svg viewBox="0 0 24 24" focusable="false"><path d="M20 6 9 17l-5-5"></path></svg>',
  "</span>",
  "</button>",
  '<button type="button" class="markdown-code-action-button markdown-code-wrap-button" data-wrap-state="off" aria-label="Wrap code block" title="Wrap code block" aria-pressed="false">',
  '<span class="markdown-code-icon" aria-hidden="true">',
  '<svg viewBox="0 0 24 24" focusable="false"><path d="M4 7h12a4 4 0 0 1 0 8H8"></path><path d="m11 12-3 3 3 3"></path><path d="M4 19h16"></path></svg>',
  "</span>",
  "</button>",
  "</div>",
].join("");

type MarkdownRenderRule = NonNullable<MarkdownIt["renderer"]["rules"]["fence"]>;

export function installCodeBlockRule(markdown: MarkdownIt): void {
  markdown.renderer.rules.fence = (items, idx, options) => {
    const item = items[idx];
    const info = item.info ? unescapeAll(item.info).trim() : "";
    const langName = info ? info.split(/\s+/g)[0] : "";
    const highlighted = options.highlight?.(item.content, langName, "") || escapeHtml(item.content);
    if (highlighted.startsWith("<pre")) return wrapMarkdownCodeBlock(highlighted);
    const langClass = langName ? ` class="${options.langPrefix}${escapeHtmlAttribute(langName)}"` : "";
    return wrapMarkdownCodeBlock(`<pre><code${langClass}>${highlighted}</code></pre>`);
  };

  const renderIndentedCodeBlock: MarkdownRenderRule = (items, idx, _options, _env, slf) => {
    const item = items[idx];
    return wrapMarkdownCodeBlock(`<pre${slf.renderAttrs(item)}><code>${escapeHtml(item.content)}</code></pre>`);
  };
  markdown.renderer.rules.code_block = renderIndentedCodeBlock;
}

export function injectMarkdownCodeToolbarButtons(html: string): string {
  return html.replaceAll(MARKDOWN_CODE_TOOLBAR_PLACEHOLDER, CODE_TOOLBAR_HTML);
}

function wrapMarkdownCodeBlock(preHtml: string): string {
  return `<div class="markdown-code-block" ${MARKDOWN_CODE_BLOCK_DATA_ATTR}="true">${MARKDOWN_CODE_TOOLBAR_PLACEHOLDER}${preHtml}</div>\n`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

function unescapeAll(value: string): string {
  return value.replace(/&([a-zA-Z#0-9]+);/g, (match, entity) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return htmlEntities[entity] || match;
  });
}

const htmlEntities: Record<string, string> = {
  amp: "&",
  gt: ">",
  lt: "<",
  quot: '"',
};
