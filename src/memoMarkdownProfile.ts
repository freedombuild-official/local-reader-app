import {
  defineLanguageFacet,
  Language,
  languageDataProp,
} from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { parser as commonmarkParser, Strikethrough, Table, TaskList } from "@lezer/markdown";

/**
 * Memo starts from CommonMark and adds only the extensions supported by this
 * editing surface. It intentionally omits GFM Autolink, so a bare URL remains
 * ordinary text.
 */
export const memoMarkdownExtensions = [Table, TaskList, Strikethrough];

const memoMarkdownData = defineLanguageFacet();

export const memoMarkdownParser = commonmarkParser.configure(
  [
    memoMarkdownExtensions,
    {
      props: [
        languageDataProp.add({
          Document: memoMarkdownData,
        }),
      ],
    },
  ],
);

export const memoMarkdownLanguage = new Language(
  memoMarkdownData,
  memoMarkdownParser,
  [],
  "local-reader-memo-markdown",
);

export function memoMarkdownSupport(): Extension {
  return memoMarkdownLanguage.extension;
}

export const liveMarkdownParseBudget = Object.freeze({
  syntaxCandidatesPerLine: 8_192,
  linkCandidatesPerBlock: 4_096,
  tableRowsPerBlock: 2_048,
  tablePipesPerBlock: 8_192,
  referenceDefinitionsPerDocument: 4_096,
});

export function isWithinLiveMarkdownParseBudget(markdown: string): boolean {
  let blockLinkCandidates = 0;
  let blockTableRows = 0;
  let blockTablePipes = 0;
  let referenceDefinitions = 0;
  let lineStart = 0;

  const inspectLine = (lineEnd: number): boolean => {
    let blank = true;
    let syntaxCandidates = 0;
    let linkCandidates = 0;
    let tablePipes = 0;
    let backslashRun = 0;
    for (let index = lineStart; index < lineEnd; index += 1) {
      const character = markdown[index];
      if (
        character === "*" ||
        character === "_" ||
        character === "~" ||
        character === "`" ||
        character === "[" ||
        character === "&" ||
        character === "<" ||
        character === "\\" ||
        character === "." ||
        character === ")" ||
        character === ">" ||
        character === "-" ||
        character === "+"
      ) {
        syntaxCandidates += 1;
      }
      if (character === "\\") {
        backslashRun += 1;
        blank = false;
        continue;
      }
      const escaped = backslashRun % 2 === 1;
      backslashRun = 0;
      if (character !== " " && character !== "\t") {
        blank = false;
      }
      if (!escaped && character === "[") {
        linkCandidates += 1;
      }
      if (!escaped && character === "|") {
        tablePipes += 1;
      }
    }

    if (blank) {
      blockLinkCandidates = 0;
      blockTableRows = 0;
      blockTablePipes = 0;
      return true;
    }

    blockLinkCandidates += linkCandidates;
    blockTableRows += tablePipes > 0 ? 1 : 0;
    blockTablePipes += tablePipes;
    const line = markdown.slice(lineStart, lineEnd);
    if (/^[ \t]{0,3}\[(?:\\.|[^\]\\])+\]:/.test(line)) {
      referenceDefinitions += 1;
    }
    return (
      syntaxCandidates <= liveMarkdownParseBudget.syntaxCandidatesPerLine &&
      blockLinkCandidates <= liveMarkdownParseBudget.linkCandidatesPerBlock &&
      blockTableRows <= liveMarkdownParseBudget.tableRowsPerBlock &&
      blockTablePipes <= liveMarkdownParseBudget.tablePipesPerBlock &&
      referenceDefinitions <=
        liveMarkdownParseBudget.referenceDefinitionsPerDocument
    );
  };

  for (let index = 0; index <= markdown.length; index += 1) {
    const character = markdown[index];
    if (
      index < markdown.length &&
      character !== "\n" &&
      character !== "\r"
    ) {
      continue;
    }
    if (!inspectLine(index)) {
      return false;
    }
    if (character === "\r" && markdown[index + 1] === "\n") {
      index += 1;
    }
    lineStart = index + 1;
  }
  return true;
}

export const memoMarkdownProfile = Object.freeze({
  commonMark: true,
  table: true,
  taskList: true,
  strikethrough: true,
  bareUrlAutolink: false,
  rawHtmlRendering: false,
  remoteImageLoading: false,
  frontmatterSemantics: false,
});
