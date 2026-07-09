---
date_created: 2026-06-29
date_modified: 2026-07-09
description: 'Local HTTP viewer for browsing repository files as a wiki with guarded AI Chat writes.'
version: 1.2.0
---
# Reader-Wiki

Languages: [English](README.md) | [日本語](README.ja.md)

Reader-Wiki is a local HTTP app for browsing files in local repositories. It runs an Express server on localhost and renders a React UI in your browser. Normal viewer and memo workflows do not edit repository files, run arbitrary shell commands on your behalf, or install plugins. Optional AI Chat entries can be configured by the user; when an entry is ready, AI Chat may perform guarded repo-scoped writes inside the active repository root only. It does not contact Git remotes by default. If remote fetch is explicitly enabled for a repository, Reader-Wiki only performs fetch-only Git sync while opening the repository. AI Chat never performs commit, push, pull, fetch, checkout, merge, reset, rebase, tag, branch creation, or remote operations.

## Quick Start

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Create a local repository config:

   ```bash
   cp example.repositories.yaml repositories.yaml
   ```

3. Edit `repositories.yaml` and replace `/absolute/path/to/your/repo` with an absolute path on your machine.

4. Start the dev server:

   ```bash
   pnpm dev
   ```

5. Open the printed localhost URL in your browser.

## Configuration

Reader-Wiki reads `repositories.yaml` by default. You can also point to another file:

```bash
READER_WIKI_CONFIG=/absolute/path/to/repositories.yaml pnpm dev
```

A repository entry has this shape:

```yaml
repositories:
  - id: docs
    label: Docs
    root: /absolute/path/to/your/repo
    defaultPath: README.md
    # fetchRemote: true
    excludes:
      - .git
      - node_modules
      - dist
```

`root` must be an absolute path. `defaultPath` is optional and opens automatically when the app starts or when the repository is selected. `fetchRemote` is optional and defaults to `false`. When a repository is opened, Reader-Wiki refreshes visible tree metadata for the whole repository. File contents, images, PDFs, and large binaries are still loaded only when a file is opened.

## What It Shows

Reader-Wiki can display Markdown, HTML, YAML, code, text, images, and PDF files that live inside a registered repository root. Markdown is rendered through a sanitized HTML pipeline. HTML files render in a sandboxed iframe and can also be viewed as source.

## Workspace

The browser UI has a repository tree, a central viewer, and a side panel. Opening files creates file tabs. Each repository keeps up to five tabs at a time. A `Preview` tab is replaced by the next tree selection unless you quickly click or tap the active tab twice to make it `Fixed`; a `Fixed` tab stays open until you toggle it back or close it. A `Pinned` tab stays at the front and is never replaced automatically. `Pin` and `Unpin` are available only from the file tab context menu, opened with right click or a two-finger tap. The central header shows only the open file's repository-relative path.

Markdown and HTML files can switch between `Rendered` and `Source`; `Source` wraps long lines for reading. Code, YAML, and text files use a `Raw` code viewer with line numbers and horizontal scrolling. Rendered Markdown is shown as document content without a card frame, and code blocks use a high-contrast scrollable style.

The side panel contains `Outline`, `Memo`, and `AI Chat`. `Outline` shows a `Table of Contents`; clicking a Markdown heading scrolls the central viewer to that heading. `Memo` is a browser-only scratchpad in the browser UI; it does not save or edit repository files. Memo supports `Raw` editing, `Render` markdown preview, and icon buttons for copy, download, and delete.

`AI Chat` is optional and uses a versioned system prompt from `prompts/ai-chat-system.md`. If a repository root has `AGENTS.md` or `CLAUDE.md`, Reader-Wiki can show it as removable rule context for the active AI Entry. Files and directories are sent when selected explicitly, for example with `Send a path to AI Chat` from the file tree context menu. Write-capable entries run against the active repository root and report repository-relative changed paths.

## Safety Boundary

The server resolves every requested path through a path guard. It only accepts repository-relative paths and rejects absolute paths, `..` traversal, symlinks that escape the registered root, and excluded paths. The default exclude list always blocks `.git`. AI Chat does not expose local absolute paths in prompts or UI responses. Repo-scoped write mode is available only for a registered Git working tree and is limited to the active repository root.

AI Chat entries use these execution boundaries:

- `Codex CLI` uses the user's existing Codex CLI subscription authentication and runs non-interactively with repo-scoped workspace-write execution.
- `Claude Code CLI` uses the installed Claude Code CLI with a restricted non-interactive file-edit tool surface.
- `AI API` is Codex-backed: Reader-Wiki prepares an isolated Codex profile and passes the provider credential only through the child process environment.
- `Local AI` is Codex-backed for Ollama or LM Studio. Reader-Wiki does not start local runtimes or download models.

AI API and Local AI do not share the default Codex auth store with the normal Codex CLI entry. Raw API credentials are not written to repository config, browser persistent storage, or the generated Codex profile.

Reader-Wiki reads the current local working tree when a repository is opened. Remote Git fetch is disabled by default. If `fetchRemote: true` is set, Git sync is fetch-only. If that fetch requires credentials or fails, Reader-Wiki keeps showing the current local state and reports a warning in the UI.

## Out Of Scope

This edition is limited to a browser-based local viewer. Native desktop shells, bundled runtime state, terminal UI, signing flows, update services, and packaged release artifacts are intentionally outside the public scope.

## Verification

Use these commands before sharing changes:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Before sharing publicly, also scan the tree for local-only paths, credentials, and generated artifacts. The scan should not report anything that belongs outside a public repository.
