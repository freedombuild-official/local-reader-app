# Reader-Wiki

Languages: [English](README.md) | [日本語](README.ja.md)

Reader-Wiki is a source-only local HTTP app for browsing files in local repositories. It binds to `127.0.0.1` by default and renders a React UI in your browser. Normal viewer and memo workflows do not edit repository files, run arbitrary shell commands, or install plugins. Optional `AI API` and `Local AI` entries are context-only by default: they receive explicitly selected, path-guarded context plus any visible, removable root `AGENTS.md` or `CLAUDE.md` rule context, and cannot edit the repository. CLI-backed repository writes are disabled in the public configuration.

Reader-Wiki does not contact Git remotes. The public execution policy ignores legacy `fetchRemote: true` values because repository-controlled remote and credential helpers can execute local programs. AI Chat never performs commit, push, pull, fetch, checkout, merge, reset, rebase, tag, branch creation, or remote operations.

## Requirements

- Node.js `>=22.13.0 <27`
- pnpm `10.27.0`
- Git for local repository metadata only

## Quick Start

1. Install dependencies:

   ```bash
   pnpm install --frozen-lockfile
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

On PowerShell, create the local config with:

```powershell
Copy-Item example.repositories.yaml repositories.yaml
```

## Production Start

Build before starting the production server:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

`pnpm start` serves the prebuilt browser and server output. It does not install dependencies or rebuild automatically.

## Configuration

Reader-Wiki reads `repositories.yaml` by default. You can also point to another file:

```bash
READER_WIKI_CONFIG=/absolute/path/to/repositories.yaml pnpm dev
```

For a production start on PowerShell:

```powershell
$env:READER_WIKI_CONFIG = 'C:\path\to\repositories.yaml'
pnpm start
```

A repository entry has this shape:

```yaml
repositories:
  - id: docs
    label: Docs
    root: /absolute/path/to/your/repo
    defaultPath: README.md
    # Legacy fetchRemote values are ignored by the public build.
    excludes:
      - .git
      - node_modules
      - dist
```

`root` must be an absolute path. `defaultPath` is optional and opens automatically when the app starts or when the repository is selected. Legacy `fetchRemote` values are accepted for config compatibility but never executed by the public build. When a repository is opened, Reader-Wiki refreshes visible local tree metadata for the whole repository. File contents, images, PDFs, and large binaries are still loaded only when a file is opened.

Windows roots can use a quoted absolute path such as `root: 'C:\path\to\your\repo'`.

## What It Shows

Reader-Wiki can display Markdown, HTML, YAML, code, text, images, and PDF files that live inside a registered repository root. Markdown is rendered through a sanitized HTML pipeline. HTML files render in a sandboxed iframe and can also be viewed as source.

## Server and Session Boundary

The default listener is `127.0.0.1`. Each server start creates a random API session token. Loading the app shell receives that token as an `HttpOnly`, `SameSite=Strict` cookie; every `/api` request requires the session, and mutations additionally require the exact local Host and Origin, JSON content, and the Reader-Wiki request header. Users do not copy or persist the token manually.

Reader-Wiki is loopback-only. Non-loopback values such as `0.0.0.0` are always refused; there is no public-server opt-in. Do not publish the port through a router, tunnel, permissive reverse proxy, or firewall rule.

## HTTP Delivery

HTTP Delivery opens a selected file in a separate tab on the same loopback server. Its public safety policy is intentionally narrower than the main viewer:

- HTML, HTM, and SVG targets are rejected with HTTP 415 and are never executed through Delivery.
- Markdown is rendered through the sanitized Delivery pipeline with a restrictive CSP.
- Only same-repository PNG, JPEG, GIF, WebP, and PDF assets explicitly referenced by that Markdown document can be fetched through the Delivery session.
- Dotfiles, credential-like files, active content, excluded paths, traversal, and unreferenced sibling files remain unavailable.

## Workspace

The browser UI has a repository tree, a central viewer, and a side panel. Opening files creates file tabs. Each repository keeps up to five tabs at a time. A `Preview` tab is replaced by the next tree selection unless you quickly click or tap the active tab twice to make it `Fixed`; a `Fixed` tab stays open until you toggle it back or close it. A `Pinned` tab stays at the front and is never replaced automatically. `Pin` and `Unpin` are available only from the file tab context menu, opened with right click or a two-finger tap. The central header shows only the open file's repository-relative path.

Markdown and HTML files can switch between `Rendered` and `Source`; `Source` wraps long lines for reading. Code, YAML, and text files use a `Raw` code viewer with line numbers and horizontal scrolling. Rendered Markdown is shown as document content without a card frame, and code blocks use a high-contrast scrollable style.

The side panel contains `Outline`, `Memo`, and `AI Chat`. `Outline` shows a `Table of Contents`; clicking a Markdown heading scrolls the central viewer to that heading. `Memo` is a browser-only scratchpad in the browser UI; it does not save or edit repository files. Memo supports `Raw` editing, `Render` markdown preview, and icon buttons for copy, download, and delete.

## AI Chat and LM Studio

`AI Chat` is optional and uses the versioned system prompt in `prompts/ai-chat-system.md`. Files and directories are sent only when selected explicitly, for example with `Send a path to AI Chat` from the file-tree context menu. A root `AGENTS.md` or `CLAUDE.md` can be shown as removable rule context.

The public execution policy supports these context-only entries:

- `AI API` connects directly to an explicitly configured remote HTTPS provider.
- `Local AI` connects directly to an explicitly configured loopback Ollama or LM Studio endpoint with a port.

Both entries require a successful server-side endpoint and model readiness check before sending. They receive only the materialized Reader-Wiki context and return a read-only run summary with no changed paths. Reader-Wiki does not give these providers repository tools, and raw provider credentials are not written to repository config or browser persistent storage.

To verify the supported LM Studio path:

1. Start LM Studio separately and load `openai/gpt-oss-20b`.
2. Enable its OpenAI-compatible local server, normally at `http://127.0.0.1:1234/v1`.
3. In Reader-Wiki Settings, choose `Local AI` and `LM Studio`, set the model to `openai/gpt-oss-20b`, and run the readiness check.
4. Send a prompt with an explicitly selected context file and confirm that the run summary remains read-only with no changed paths.

Reader-Wiki does not start LM Studio, load a model, or download a model. A remote `AI API` endpoint must use HTTPS; Local AI is the only mode that accepts an explicit loopback HTTP endpoint.

`Codex CLI` and `Claude Code CLI` repository writes are disabled by default. `READER_WIKI_EXPERIMENTAL_AI_WRITE=1` enables the legacy write-capable path only for isolated development testing; it is not part of the public security boundary. On PowerShell, set it for that process with `$env:READER_WIKI_EXPERIMENTAL_AI_WRITE = '1'`. Do not enable it for a public or shared listener.

## Safety Boundary

The server resolves every requested path through a path guard. It accepts repository-relative paths only and rejects absolute paths, `..` traversal, symlinks that escape the registered root, and excluded paths. The default exclude list always blocks `.git`. AI Chat does not expose local absolute paths in prompts or UI responses. Duplicate postflight checks are warning-only and do not automatically rewrite a selected file.

Reader-Wiki reads the current local working tree when a repository is opened. Remote Git fetch is disabled unconditionally in the public build, including when a legacy config contains `fetchRemote: true`.

## Source-Only Distribution and Publication Gates

This package is intentionally marked `private: true`. It is distributed as GitHub source and is not an npm publishing surface. Verified `repository`, `homepage`, and `bugs` values are intentionally absent until the public GitHub namespace exists.

Before the first public push, a maintainer must:

1. choose and verify the GitHub owner/repository namespace, then add only URLs derived from that verified namespace;
2. choose a clean snapshot, squash, or separately approved history rewrite strategy;
3. review full-history author and committer metadata, including whether public email addresses should be replaced with GitHub noreply identities;
4. run `pnpm run scan:history` plus a dedicated scanner such as gitleaks or trufflehog; and
5. enable and verify GitHub private vulnerability reporting as described in `SECURITY.md`.

The current source does not make those human decisions. Publication remains **HOLD** until they are complete.

## Out Of Scope

This edition is limited to a browser-based local viewer. Native desktop shells, bundled runtime state, terminal UI, signing flows, update services, and packaged release artifacts are intentionally outside the public scope.

## Verification

Use these commands before sharing changes:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm audit --prod
pnpm run scan:public
```

`scan:public` fails on public-source findings and reports unresolved namespace and history choices as human gates. `scan:history` is intentionally separate from routine CI because its current result requires a maintainer decision and may remain nonzero until the chosen history strategy is applied.

GitHub Actions runs frozen installation, typecheck, tests, production build, and the public-source scan across Ubuntu, Windows, and macOS, covering Node.js 22 minimum compatibility and Node.js 26 current compatibility. The Ubuntu Node.js 22 job also audits production dependencies.

## License

Reader-Wiki source is licensed under the MIT License. See `LICENSE`.

## Summary

Reader-Wiki is a loopback-only, source-distributed repository viewer with session-protected APIs, restricted HTTP Delivery, and context-only AI provider access by default. Public release still requires explicit human approval of the GitHub namespace, history strategy, email metadata, and private security-reporting route.
