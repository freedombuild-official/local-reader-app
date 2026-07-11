# Reader-Wiki

Languages: [English](README.md) | [日本語](README.ja.md)

Reader-Wiki turns folders on your Mac or Windows PC into a private reading workspace in your browser. Use it to browse documentation, source code, text, images, PDFs, and local Git changes without moving those files into another service.

The normal viewer does not edit files in the folders you register. Reader-Wiki runs on your own computer at `http://127.0.0.1:5173/`. No repository content is sent to an AI service unless you enable AI Chat. Before a request, its repository context is shown in removable chips; a root rule file may be suggested automatically.

Reader-Wiki currently runs from the source files on GitHub. There is no `.dmg`, `.exe`, app-store package, hosted account, or one-click installer. The setup below takes you from downloading the source to opening your first folder.

## Contents

- [What You Can Do](#what-you-can-do)
- [Install and Start on macOS](#install-and-start-on-macos)
- [Install and Start on Windows](#install-and-start-on-windows)
- [Configure the Folders You Read](#configure-the-folders-you-read)
- [Use the Workspace](#understand-the-workspace)
- [Set Up Optional AI Chat](#set-up-optional-ai-chat)
- [Safety and Privacy](#safety-and-privacy)
- [Support and Responsibility](#support-and-responsibility)
- [Update Reader-Wiki](#update-reader-wiki)
- [Uninstall Reader-Wiki](#uninstall-reader-wiki)
- [Troubleshooting](#troubleshooting)
- [For Contributors](#for-contributors)
- [License](#license)

## What You Can Do

- Register one or more local folders and switch between them.
- Browse a file tree with local Git status markers and safe path controls.
- Keep up to five Preview, Fixed, or Pinned file tabs per registered folder.
- Render Markdown and sandboxed HTML, inspect source and code with line numbers, and preview images, PDFs, and supported Markdown-in-DOCX files.
- Copy file contents, paths, messages, and individual Markdown code blocks.
- Inspect file metadata, Git state, and a clickable Markdown outline.
- Keep a temporary Markdown memo and download it when needed.
- Open selected files in temporary, separate browser tabs with HTTP Delivery.
- Adjust text size, light or dark appearance, and workspace width.
- Optionally ask an AI service about files or folders that you select explicitly.

Reader-Wiki is primarily a reader, not a general file editor, terminal, Git client, or remote file server. Normal viewing does not write to registered folders. A supported optional AI Chat **Current repo write** entry is the explicit exception and can edit only its Current repo after readiness succeeds. Saving Repository Settings updates only Reader-Wiki's own configuration, while downloading a Memo creates a browser download that you requested. Removing an entry from the repository list never deletes the registered folder.

## Before You Install

You need:

- macOS or Windows;
- [Node.js](https://nodejs.org/en/download) `>=22.13.0 <27`;
- pnpm `10.27.0`;
- a current desktop web browser; and
- enough access to read the folders you want to register.

[Git](https://git-scm.com/downloads) is recommended but not required for basic ZIP-based viewing. Git is needed to clone or update the project with Git and to show change markers, deleted tracked files, and changed lines.

AI software and API keys are optional. You can use every non-AI reading feature without them.

## Get Reader-Wiki from GitHub

Choose one method on this repository's GitHub page:

1. For the simplest method, select **Code** > **Download ZIP**, extract the ZIP, and remember the extracted folder.
2. If you already use Git, select **Code**, copy the HTTPS URL shown on this GitHub page, and clone that URL.

The commands below use `/path/to/reader-wiki` or `C:\path\to\reader-wiki` as examples. Replace them with the folder you downloaded or cloned.

## Install and Start on macOS

### Install the required tools

1. Install a compatible Node.js version from the official download page.
2. Open **Terminal**.
3. Confirm Node.js and npm, then install the pnpm version used by Reader-Wiki:

   ```bash
   node --version
   npm --version
   npm install --global pnpm@10.27.0
   pnpm --version
   ```

If the global pnpm installation reports a permissions error, use the official [pnpm installation guide](https://pnpm.io/10.x/installation) instead of changing broad filesystem permissions.

### Install Reader-Wiki

1. Move into the downloaded Reader-Wiki folder. The easiest method is to type `cd ` with a trailing space in Terminal, drag the Reader-Wiki folder from Finder into Terminal, and press `Return`. You can also enter its path directly:

   ```bash
   cd "/path/to/reader-wiki"
   ```

2. Install the exact locked dependencies:

   ```bash
   pnpm install --frozen-lockfile
   ```

3. Create your private local configuration:

   ```bash
   cp example.repositories.yaml repositories.yaml
   open -e repositories.yaml
   ```

4. Replace the sample entry with a folder you want to read. Use an existing absolute path:

   ```yaml
   repositories:
     - id: my-docs
       label: My Documents
       root: '<absolute-path-to-your-folder>'
       defaultPath: README.md
       excludes:
         - .git
         - node_modules
         - dist
   ```

   If you do not know a folder's absolute path, select it in Finder, hold `Option`, open the context menu, and choose **Copy as Pathname**. You can also type `cd ` in Terminal, drag the folder into the Terminal window, press `Return`, and run `pwd`.

   If the folder has no `README.md`, set `defaultPath` to another existing file or remove that line.

5. Build Reader-Wiki:

   ```bash
   pnpm build
   ```

6. Start it:

   ```bash
   pnpm start
   ```

7. Keep Terminal open and visit [http://127.0.0.1:5173/](http://127.0.0.1:5173/) in your browser. The terminal also prints the exact URL and configuration file path.

8. To stop Reader-Wiki, return to that Terminal window and press `Control+C`.

## Install and Start on Windows

Use **PowerShell**, not Command Prompt, for the commands in this section.

### Install the required tools

1. Install a compatible Node.js version with the official Windows installer.
2. Open **PowerShell**.
3. Confirm Node.js and npm, then install the pnpm version used by Reader-Wiki:

   ```powershell
   node --version
   npm --version
   npm install --global pnpm@10.27.0
   pnpm --version
   ```

If PowerShell says that `pnpm.ps1` cannot run because of the execution policy, do not weaken the policy. Use `pnpm.cmd` in place of `pnpm` in the commands below, for example `pnpm.cmd --version`.

### Install Reader-Wiki

1. Move into the extracted or cloned Reader-Wiki folder. In File Explorer, select that folder, hold `Shift`, right-click, and choose **Copy as path**. In PowerShell, type `Set-Location ` with a trailing space, paste the copied path, and press `Enter`. You can also enter it directly:

   ```powershell
   Set-Location 'C:\path\to\reader-wiki'
   ```

2. Install the exact locked dependencies:

   ```powershell
   pnpm install --frozen-lockfile
   ```

3. Create and open your private local configuration:

   ```powershell
   Copy-Item example.repositories.yaml repositories.yaml
   notepad .\repositories.yaml
   ```

4. Replace the sample entry with a folder you want to read. Put a Windows absolute path inside YAML single quotes and use each backslash once:

   ```yaml
   repositories:
     - id: my-docs
       label: My Documents
       root: '<absolute-path-to-your-folder>'
       defaultPath: README.md
       excludes:
         - .git
         - node_modules
         - dist
   ```

   In File Explorer, select the folder, hold `Shift`, right-click, and choose **Copy as path**. Paste it between the YAML single quotes and remove the double quotes copied by Explorer. PowerShell can confirm a path with:

   ```powershell
   (Resolve-Path '<absolute-path-to-your-folder>').Path
   ```

   If the folder has no `README.md`, set `defaultPath` to another existing file or remove that line.

5. Build Reader-Wiki:

   ```powershell
   pnpm build
   ```

6. Start it:

   ```powershell
   pnpm start
   ```

7. Keep PowerShell open and visit [http://127.0.0.1:5173/](http://127.0.0.1:5173/) in your browser. PowerShell also shows the exact URL and configuration file path.

8. To stop Reader-Wiki, return to that PowerShell window and press `Ctrl+C`.

## Start Reader-Wiki Again

After the first build, normal startup only needs the project folder and `pnpm start`.

On macOS:

```bash
cd "/path/to/reader-wiki"
pnpm start
```

On Windows PowerShell:

```powershell
Set-Location 'C:\path\to\reader-wiki'
pnpm start
```

`pnpm start` does not install dependencies or rebuild updated source. Run the update steps later in this README after downloading a newer version.

## Configure the Folders You Read

Reader-Wiki calls each registered folder a repository, but the folder can also be a documentation folder that is not managed by Git.

The default configuration file is `repositories.yaml` in the Reader-Wiki folder. Keep this file private: it contains absolute paths from your computer and is intentionally excluded from Git.

Each entry supports these fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | Yes | A unique name used internally by Reader-Wiki. |
| `label` | Yes | The name shown in the repository selector. |
| `root` | Yes | An existing, readable absolute folder path. |
| `defaultPath` | No | A file inside `root` to open when the repository is selected, such as `README.md`. |
| `excludes` | No | Repository-relative files or folders to hide. Use `/` inside nested relative paths on every OS. |

Repository IDs must be unique. Two entries cannot point to the same folder, differ only by letter case or Unicode normalization, or have parent-and-child roots. These checks prevent overlapping visibility and AI context boundaries.

`.git` is always hidden. Reader-Wiki never fetches from Git remotes, even if an older configuration still contains `fetchRemote: true`.

Each `excludes` line supports one of these simple forms:

- a folder or file name such as `node_modules`, matched as a path segment;
- an exact relative path and its descendants, such as `private/exports`;
- an extension pattern such as `'*.pem'`; or
- a name prefix ending in `*`, such as `'secret*'`.

Quote wildcard entries exactly as shown because an unquoted leading `*` has a different meaning in YAML. Other wildcard syntax is not supported. Only `.git` is excluded automatically. Add `.env`, key files, exports, or other sensitive paths yourself when they must not appear in the tree, AI context choices, or direct HTTP Delivery targets.

### Add or edit repositories in Settings

After the first valid repository is configured, you can manage the list in the browser:

1. Select the gear button at the bottom of the left sidebar.
2. Open **Repositories**.
3. Select **Add repository**, or select an existing row to edit it.
4. Enter the ID, label, absolute root, optional default path, and exclusions.
5. Select **Validate config** and resolve every reported issue.
6. Select **Preview YAML** if you want to inspect the file that will be written.
7. Select **Save config**.

**Remove from list** removes only the configuration entry. It never deletes the folder or any file inside it. Saving a changed repository list stops active HTTP Delivery sessions because their old repository boundaries are no longer current.

If another program changes the configuration after Settings loads it, Reader-Wiki refuses to overwrite the newer file. Return to the viewer, reopen Settings, and try again.

### Use a configuration file in another location

On macOS:

```bash
READER_WIKI_CONFIG="<absolute-path-to-repositories.yaml>" pnpm start
```

On Windows PowerShell:

```powershell
$env:READER_WIKI_CONFIG = '<absolute-path-to-repositories.yaml>'
pnpm start
```

Settings saves to the selected configuration file, so it must be writable if you want to edit the repository list in the UI.

## Understand the Workspace

The main screen has three areas:

1. The left sidebar selects repositories and files.
2. The center displays open files in tabs.
3. The right panel switches between **Outline**, **Memo**, and **AI Chat**.

At narrow browser widths, the right panel moves below the reader, and the workspace eventually becomes a single column.

### Repository selector and file tree

- **Repository** switches between registered roots. Each repository keeps its own file tabs during the current page session.
- **Reload repository** refreshes the file tree and every open tab from the local disk. Use it after another editor or program changes files; Reader-Wiki does not continuously watch the filesystem.
- **HTTP Delivery** shows the current number of temporary deliveries, their URLs, and a stop button for each one.
- **Collapse all folders** closes every expanded folder except the root. It does not close file tabs.
- Long trees support horizontal scrolling and keep ancestor folders visible at the top. Select a sticky ancestor to jump back to its position.
- Git markers show `new`, `changed`, `deleted`, and binary changes. Changed text lines are also marked in the source viewer.
- A deleted tracked text file can still show its last `HEAD` content when Git can provide it.
- Very large trees may stop at a safe limit and show a partial-tree warning instead of exhausting the computer.

Right-click a file or folder for:

- **Copy Absolute Path**;
- **Copy Relative Path**;
- **Open in New Tab** for files, meaning another file tab inside Reader-Wiki; and
- **Send a path to AI Chat** after an AI entry passes its readiness check.

The context menu supports `Arrow Up`, `Arrow Down`, `Home`, `End`, and `Escape`.

### File tabs

Each repository can keep up to five tabs:

- **Preview** is the normal temporary tab. Selecting another file in the tree replaces it.
- **Fixed** stays open until you close it or return it to Preview.
- **Pinned** stays at the front and is never automatically replaced.

Double-click or double-tap the active tab to switch between Preview and Fixed. Right-click a tab for **Fix Tab** or **Return to Preview**, **Pin** or **Unpin**, **HTTP Delivery**, and **Close**. Selecting the active tab again reveals its file in the tree.

| Key | File-tab action |
| --- | --- |
| `Left Arrow` / `Right Arrow` | Move between open tabs. |
| `Home` / `End` | Move to the first or last tab. |
| `Delete` | Close the focused tab. |
| `Shift+F10` or the Context Menu key | Open tab actions. |
| `Enter` or `Space` | Select the tab; if already active, reveal it in the tree. |

The right-panel tabs also support `Left Arrow`, `Right Arrow`, `Home`, and `End`.

## View Files

Reader-Wiki chooses a safe viewer from the file name, content, and size.

| File | Available view |
| --- | --- |
| Markdown | **Rendered** or **Source**. Rendered Markdown hides YAML frontmatter and supports tables, read-only task lists, and code-block copy and wrapping. |
| HTML | **Rendered** in a script-disabled sandbox or **Source**. |
| Source code, JSON, YAML, configuration, and text | **Raw** with line numbers, horizontal scrolling, and local Git change markers. |
| PNG, JPEG, GIF, WebP, and SVG | Image preview. |
| PDF | Embedded browser PDF preview. |
| `.docx` containing Markdown source | Rendered as Markdown. Reader-Wiki does not reproduce a normal Word page layout. |
| Binary, unsupported, deleted binary, or oversized files | Metadata only, without loading an unsafe or excessive body into the reader. |

The header can copy the full contents of a text-based file. Rendered Markdown code blocks have separate buttons to copy only that block or toggle long-line wrapping.

**Source** wraps long lines for reading. **Raw** keeps line structure and uses horizontal scrolling.

Rendered Markdown and HTML can load HTTPS images that the document explicitly references. That contacts the image host, and a newly opened Markdown or HTML file starts in **Rendered** mode. If you must avoid that request, inspect an untrusted document in a separate plain-text editor before opening it in Reader-Wiki.

### Viewer size limits

Files above these limits show metadata instead of the full viewer:

| Type | Limit |
| --- | ---: |
| Markdown and HTML | 2.5 MB |
| Code and text | 3 MB |
| Markdown-in-DOCX | 20 MiB container, with additional safe extraction limits |
| PDF | 80 MiB |
| GIF | 25 MiB |
| PNG | 40 MiB |
| JPEG and WebP | 50 MiB |
| SVG | 10 MiB |

Archives, installers, databases, older Office documents, PowerPoint files, and Excel files are not rendered as document content. Their available metadata is still shown.

## Use Outline and File Information

Open **Outline** in the right panel to see:

- file name and repository-relative path;
- type, MIME type when available, and viewer state;
- file size, character count, line count, and created time;
- local Git state; and
- the source type for a supported Markdown-in-DOCX file.

For Markdown, **Table of Contents** lists H1 through H6 headings and their source line numbers. Select a heading to scroll the center reader to it.

## Use the Temporary Memo

**Memo** is one temporary Markdown scratchpad for the current browser page:

- **Raw** edits Markdown text.
- **Render** previews it with tables, task lists, and code-block controls.
- The copy button copies the whole memo.
- The download button saves `reader-wiki-memo.md` through your browser.
- The delete button clears it immediately.

Memo does not create or edit a repository file. Download anything you want to keep before reloading or closing the page.

## Use HTTP Delivery

HTTP Delivery gives a selected file a temporary URL in a separate tab on the same local Reader-Wiki server. Start it from the center viewer header or a file-tab menu. Use the radio-tower button beside the repository selector to reopen an active URL or stop it.

- Up to five files can be active at once.
- Starting Delivery again for the same file reuses its existing delivery while the registered repository settings remain unchanged.
- A Delivery URL is not a fixed snapshot. Each visit reads the file's current local contents.
- Markdown becomes a standalone rendered page with table, task-list, and code-block controls.
- Text and passive supported assets are served inline when safe.
- Delivered Markdown is limited to 2 MiB. Other directly delivered files and supporting assets are limited to 25 MiB.
- HTML, HTM, and SVG targets are rejected because Delivery does not execute active content.
- For local supporting assets, a delivered Markdown page can load only explicitly referenced PNG, JPEG, GIF, WebP, and PDF files located in the Markdown file's own directory or a subdirectory. Parent references using `../` are rejected.
- An explicitly embedded HTTPS image can still be requested directly from its remote host.
- Supporting local assets that are dotfiles, credential-like paths, excluded paths, root escapes, or unreferenced neighboring files remain unavailable.
- The file you select as the direct Delivery target is a separate case: any visible regular file within the size limit can be served except HTML, HTM, SVG, and symbolic-link paths. Do not start Delivery for secrets; add sensitive paths to `excludes`.
- Deliveries end when you stop them, stop the server, or save a changed repository configuration.

These URLs are local and temporary. Do not expose them with a tunnel, router rule, reverse proxy, or public firewall rule.

## Adjust Reader-Wiki in Settings

Select the gear button to open Settings. Returning to the viewer without reloading the page preserves the current tabs, Memo, and AI conversation.

### Basic

- **Reader text scale**: `×1`, `×1.5`, or `×2` for Markdown, HTML, text, code, and document reading surfaces.
- **Appearance**: Light or Dark.
- **Workspace density**: Compact, Comfortable, or Focused.

These three choices are saved in this browser and survive a page reload.

### Repositories

Add, edit, validate, preview, save, and remove repository-list entries. This is the only normal Settings category that writes a file to disk.

### AI Chat

Choose one AI entry, enter only the connection details it needs, run a readiness check, and adjust supported model behavior. AI settings and credentials are not written to `repositories.yaml` or browser persistent storage.

## Understand What Is Saved

| Item | Where it lives | After page reload |
| --- | --- | --- |
| Repository list | `repositories.yaml` or the file selected by `READER_WIKI_CONFIG` | Kept |
| Text scale, theme, and layout | Browser storage for this local site | Kept |
| Open file tabs | Current page memory | Cleared |
| Memo | Current page memory until you download it | Cleared |
| AI conversation | Current page memory | Cleared |
| AI entry settings and credentials | Current page memory only | Cleared |
| HTTP Delivery sessions | Current Reader-Wiki server process | Cleared when the server stops |
| Files in registered repositories | Read by the viewer; changed only by a guarded Current repo write run that you explicitly request | May change only after that run |

## Set Up Optional AI Chat

AI Chat is optional. Use **AI API** for a remote provider or **Local AI** for a model server running on the same computer. These entries default to **Context-only**. You may explicitly select **Current repo write** when the configured endpoint and model pass Reader-Wiki's strict edit-protocol readiness check. The model still receives no shell or filesystem access: Reader-Wiki mediates bounded reads and applies only validated text operations inside the Current repo. **Codex CLI** and **Claude Code CLI** remain available for installation and persistent-auth diagnostics, but both write paths fail closed in this build because Reader-Wiki cannot prove a Current repo-only filesystem boundary for them. All four entries use the normal `pnpm start` command; there is no separate AI startup command.

You provide and manage any AI account, API key, local runtime, model, endpoint, and credential used with AI Chat. Provider subscriptions, API usage fees, token or quota limits, network access, local model downloads, model licenses, storage, memory, compute, electricity, updates, and model selection are your responsibility. Reader-Wiki does not pay AI costs, refund provider charges, increase quotas, choose models for you, or provide provider-specific support.

### AI API

1. Open **Settings** > **AI Chat**.
2. Set **AI API** active.
3. Choose OpenAI, Anthropic, Google, OpenAI-compatible, or Custom.
4. Enter the exact model name and API key. OpenAI-compatible and Custom entries also need a base URL and API format.
5. Keep **Repository access** at **Context-only**, or explicitly select **Current repo write** to use Reader-Wiki's guarded server-side edit protocol.
6. Select **Check readiness**. Changing the access mode invalidates the previous readiness result.

Remote AI endpoints must use HTTPS and resolve to a public network address. Reader-Wiki blocks embedded URL credentials, private or reserved remote addresses, and redirects to another origin.

The readiness check may list models or send a minimal test prompt to the configured provider. It does not send repository content.

Context sent to a remote provider leaves your computer and is subject to that provider's policies. Review every selected path, rule chip, and attachment before sending.

AI API **Current repo write** uses the configured OpenAI-compatible, Anthropic, or Google request format; Custom uses the API format selected in Settings. Write readiness sends a repository-free capability prompt and succeeds only when the endpoint and selected model return the exact versioned JSON protocol. A model that answers with ordinary prose remains usable in **Context-only** mode but cannot become write-ready.

For a write run, Reader-Wiki sends a bounded repository-relative tree manifest. The model may request additional UTF-8 text files through bounded read rounds; those provider-visible paths appear in the run summary. The server rejects absolute and parent paths, symlinks, excluded paths, `.git`, `.codex`, `.agents`, Reader-Wiki control-plane files, binary data, oversized requests, stale file identities or hashes, colliding operations, and reserved staging names. It preflights every operation, uses repo-local staging and backups, applies create, replace, full-text write, and explicitly authorized delete operations in a deterministic order, rolls back a failed run where possible, and verifies the resulting files before removing backups. This is guarded multi-file application with rollback, not a promise of a crash-proof filesystem transaction or protection against the final path-check-to-rename race from another process running as the same user.

The protocol may create or update multiple files and nested paths only after you send a message requesting repository edits. Deletion is fail-closed unless the latest user message contains an exact `DELETE: relative/path` line for that file; add one line per file. A move therefore requires a validated destination write plus an exact deletion authorization for the read source. An authorization in an earlier message, a different path, a wildcard, or ordinary prose does not authorize deletion. Selected paths are optional context hints, not the authorization boundary. There is no save, direct-edit, terminal, or Preview / Apply UI.

### Local AI with Ollama or LM Studio

Local AI connects to a model server that you start on the same computer. Reader-Wiki does not require a specific local model. Use a model that your runtime can serve through the selected OpenAI-compatible endpoint, and enter the exact model name shown by that runtime.

For example, with LM Studio:

1. Start LM Studio separately.
2. Load a model you have chosen.
3. Start LM Studio's OpenAI-compatible server, normally at `http://127.0.0.1:1234/v1`.
4. In Reader-Wiki, open **Settings** > **AI Chat** and set **Local AI** active.
5. Select **LM Studio**.
6. Set the endpoint to `http://127.0.0.1:1234/v1` and the model to the exact model name loaded in LM Studio.
7. Leave the optional credential empty unless your local server requires one.
8. Keep **Repository access** at **Context-only**, or explicitly select **Current repo write** to use the guarded server-side edit protocol.
9. Select **Check readiness**.

Reader-Wiki does not start LM Studio or Ollama, download a model, load a model, check a model's license, or manage your local machine resources. Do those steps in the local runtime first and confirm that your computer has enough storage, memory, and compute for the model you choose.

Ollama and other supported local runtimes can also be used when an explicit loopback host and port, the matching API format, and the exact loaded model name are configured. **Current repo write** is not restricted to a built-in LM Studio or Ollama URL, but readiness must prove that the configured model follows the strict edit protocol. Reader-Wiki never starts or downloads the local runtime or model.

### CLI entries

The Codex CLI and Claude Code CLI entries are diagnostics-only in this build. Reader-Wiki checks the installed binary, persistent sign-in, relevant non-interactive flags, and selected workspace, but their Current repo write boundary always reports **Check failed** and no CLI edit run starts.

1. Install Codex CLI or Claude Code CLI separately by following that CLI's official instructions.
2. Complete the CLI's persistent sign-in from your own terminal and confirm that it works before starting Reader-Wiki. Reader-Wiki intentionally does not forward credential-like environment variables to CLI child processes, so an environment-variable-only API key does not satisfy this check.
3. Start Reader-Wiki normally with `pnpm start`.
4. Open **Settings** > **AI Chat**, set the installed CLI active, and select **Check readiness**.
5. Confirm the diagnostic result. The AI Chat composer stays unavailable for this CLI entry; use AI API or Local AI for supported requests.

Readiness performs those diagnostics without sending an AI prompt or editing repository files. Reader-Wiki does not start sign-in, browser authorization, CLI installation, model download, terminal, or Git remote operations.

Codex CLI is fail-closed because the tested macOS Codex 0.144.1 `:minimal` runtime grants shared system temporary directories read/write access even when the dynamic profile denies them; that is wider than Current repo-only. Claude Code CLI is fail-closed because Reader-Wiki has not proved repo-outside read denial and protected-path write denial with an equivalent cross-platform filesystem sandbox. A future CLI path must pass the same boundary tests before it can become write-ready.

### Choose context and send a message

1. Complete the active entry's readiness check.
2. For a repository-specific question, right-click a file or folder in the tree and select **Send a path to AI Chat**.
3. Review the context chips above the message box. Remove anything you do not want to send.
4. Enter a message and send it.

Selecting a path is optional. Skip step 2 for a general question, an attachment-only request, or a repo-wide edit instruction that does not need an initial path hint. A directory or several selected files are valid context. Still review and remove any automatically suggested root rule that you do not want to send.

An open file is not sent automatically. A selected file can contribute text; a selected directory contributes only its direct child list, not every nested file. When present, root `AGENTS.md` or `CLAUDE.md` rules appear as a visible, removable rule chip.

Tree-selected paths and uploaded attachments are one-request context: they disappear from the composer after sending. A retry reuses only the previous message text and does not silently restore those one-time items.

AI context is bounded to 12 primary items, 2 rule items, 64 KiB in total, and at most 16,000 characters from one file. Images, PDFs, binaries, unsupported files, and oversized files contribute metadata rather than body content.

### Conversation controls

- Responses stream into the conversation when the provider supports streaming.
- Copy any user or AI message.
- Cancel an active request.
- Retry the last failed request.
- Use Markdown tables, task lists, and code-block copy and wrapping in AI responses.
- Press `Enter` to send. Use `Shift+Enter` or `Ctrl/Command+Enter` for a new line.
- Use voice input when the browser exposes a compatible speech-recognition feature.
- Upload up to five files. Recognized text files up to 64 KiB are eligible to include text, with at most 12,000 characters used per attachment in the provider prompt. Other attachments send name, type, and size metadata only.
- The complete AI request body is limited to about 140 KiB, so several large text attachments can still be rejected. Use fewer or smaller files when that happens.
- Choose Low, Medium, or High response depth for supported GPT-style models, or Thinking mode for supported Qwen-style models. Other models use their defaults.

Only one AI run can use the same repository at a time, with up to four runs across the server. Readiness uses a short server-side lease. If that lease expired or disappeared after a server restart while the browser still shows **Connected** or **Success**, sending automatically repeats the same entry, settings, Current repo, and revision checks before continuing. A failed renewal stops before the provider editing request or CLI run. Changing settings or switching repositories still invalidates readiness.

AI API and Local AI **Context-only** responses end with a summary showing no repository changes. Every **Current repo write** response reports provider-visible read paths plus new, changed, and deleted Current repo paths, or an `unverified` warning when cleanup or post-write verification was incomplete. AI remains advisory; a person must review the response, repository, and actual working-tree diff and decide what to keep.

## Safety and Privacy

- Reader-Wiki accepts only local loopback hosts such as `127.0.0.1`, `localhost`, and `::1`. It refuses `0.0.0.0` and other network interfaces.
- Each start creates a new browser session. API calls require that session, and write-like configuration actions also require the exact local origin and request format.
- Requested paths must stay inside a registered root. Absolute input paths, `..` traversal, and excluded paths are rejected. File-body reads and HTTP Delivery also reject every symbolic-link path component, while tree navigation refuses links that resolve outside the root.
- `.git` is always excluded from file viewing. Git commands are used only for local status and diff information; Reader-Wiki does not contact Git remotes.
- Normal viewing does not edit repository files. Repository Settings writes only the selected Reader-Wiki configuration file.
- AI API and Local AI send the conversation, versioned system instructions, and the context visible in chips and attachments. **Context-only** sends no repository write tools. **Current repo write** additionally sends a bounded repository-relative tree manifest and only the additional files requested through guarded reads. Remote AI sends that material to its configured provider.
- AI API and Local AI default to **Context-only**. In a write run, the model has no direct filesystem or shell access; only the Reader-Wiki server validates and applies bounded UTF-8 text operations inside the Current repo. Selected context paths do not restrict the run to those paths. Reader-Wiki does not commit, push, pull, fetch, checkout, merge, reset, rebase, tag, or branch on your behalf.
- HTTP Delivery uses temporary, restricted local URLs and does not turn Reader-Wiki into a public server.

Do not run Reader-Wiki on an untrusted copy of its own source, and do not expose its port through a tunnel or network rule. To report a security problem privately, follow [SECURITY.md](SECURITY.md).

## Support and Responsibility

Reader-Wiki is provided as free, open-source software under the MIT License. It does not include individual installation, configuration, operation, or troubleshooting support comparable to a paid product or support contract.

Decide whether and how to use Reader-Wiki at your own discretion and responsibility. Keep backups of important repositories before changing tools, settings, dependencies, local AI configuration, or enabling provider write mode. You are responsible for checking the effect of commands you run, folders you register, files you expose through HTTP Delivery, context you send to AI, and every file change applied for an AI API or Local AI write run. Codex CLI and Claude Code CLI do not edit files in this build.

Bug reports and issues, if available on the public repository, do not guarantee an individual reply, a fix, a release date, or a service-level agreement. Security reports are separate from general support; follow [SECURITY.md](SECURITY.md) and do not post unpatched vulnerability details in a public issue, discussion, AI prompt, screenshot, or log.

## Update Reader-Wiki

Stop the running server with `Control+C` or `Ctrl+C` before updating.

### If you cloned with Git

From the Reader-Wiki folder:

```bash
git pull --ff-only
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

On PowerShell, use the same commands. If the execution policy blocks `pnpm.ps1`, substitute `pnpm.cmd`.

### If you downloaded a ZIP

1. Download and extract the new ZIP into a new folder.
2. Copy your private `repositories.yaml` from the old Reader-Wiki folder into the new one.
3. In the new folder, run `pnpm install --frozen-lockfile`, `pnpm build`, and `pnpm start`.
4. Confirm your repositories and settings before deleting the old Reader-Wiki folder.

## Uninstall Reader-Wiki

1. Stop the server with `Control+C` or `Ctrl+C`.
2. If you want to keep the repository list, save a copy of `repositories.yaml` elsewhere.
3. Delete the Reader-Wiki project folder.
4. Optionally clear site data for `127.0.0.1:5173` in your browser to remove the saved text scale, theme, and layout.

Uninstalling Reader-Wiki does not delete any registered repository folder.

## Troubleshooting

If you are stuck, you can attach this README file to an AI assistant and ask it to walk through the current step with you. Tell it your operating system, Reader-Wiki version or source revision if known, the step you are on, the exact command or click you tried, and the exact error message. Remove API keys, passwords, tokens, cookies, `.env` contents, personal information, private paths, and confidential repository data before sending anything. AI suggestions can be wrong, so read the command and its effect before running it. Asking an AI assistant does not mean the maintainers provide individual support.

### `pnpm` is not found

Open a new terminal after installation and run:

```bash
npm install --global pnpm@10.27.0
pnpm --version
```

On Windows, try `pnpm.cmd --version` if the PowerShell execution policy blocks `pnpm.ps1`.

### The Node.js version is rejected

Run `node --version`. Install a version from `22.13.0` up to, but not including, `27`.

### `Repository config was not found`

Make sure you started Reader-Wiki from its own folder and created `repositories.yaml`. If you use `READER_WIKI_CONFIG`, confirm that its absolute path is correct.

### The repository configuration is unsafe or invalid

Check that every root is an existing readable absolute directory, IDs are unique, roots do not overlap, and default paths and exclusions are repository-relative. Use **Settings** > **Repositories** > **Validate config** for specific checks.

### Port 5173 is already in use

Stop the other process, or select another local port.

On macOS:

```bash
PORT=5174 pnpm start
```

On Windows PowerShell:

```powershell
$env:PORT = '5174'
pnpm start
```

Then open `http://127.0.0.1:5174/`.

### `pnpm start` runs but the page is missing or outdated

`pnpm start` serves the last build. Stop it, then run:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

### An old browser tab reports a session or authorization error

Each server start creates a new local session. Reload the URL printed by the current server or open it in a new tab.

### Local file changes do not appear

Select **Reload repository**. Reader-Wiki does not continuously watch the registered folders.

### Git change markers do not appear

Confirm that Git is installed, the registered folder is a Git working tree, and `git status` works there. Basic file viewing continues when Git information is unavailable.

### AI readiness fails

- Confirm that the selected model name exactly matches the provider or local runtime.
- For LM Studio or Ollama, start the runtime and model before checking Reader-Wiki.
- Use **Local AI** for explicit loopback HTTP endpoints. **AI API** remote endpoints require HTTPS.
- Re-enter credentials after a page reload because Reader-Wiki does not persist them.
- Run **Check readiness** again after changing any connection field.

### Voice input is unavailable

The microphone button is enabled only when the browser provides a compatible speech-recognition API. Typed AI Chat remains available.

### HTTP Delivery rejects a file

Use the main viewer for HTML, HTM, or SVG. For a local Markdown asset, confirm that the document explicitly references it without `../`, that it is in the Markdown file's directory or a subdirectory, and that it is not excluded or reached through a symbolic link. Delivered Markdown is limited to 2 MiB; other delivered files and assets are limited to 25 MiB.

## For Contributors

Use the live development server only when changing Reader-Wiki itself:

```bash
pnpm dev
```

Before sharing a change, run:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm audit --prod
pnpm run scan:public
```

GitHub Actions checks frozen installation, types, tests, the production build, and the public-source scan on Ubuntu, Windows, and macOS.

## License

Reader-Wiki is licensed under the MIT License. See [LICENSE](LICENSE).

## Summary

Reader-Wiki is a local browser workspace for reading one or more folders without handing normal viewing control of those files to a hosted service. Start with the macOS or Windows guide, register an absolute folder path, and use the complete feature sections above as your operating manual. AI Chat remains optional and receives the context shown in its removable chips, including any automatically suggested root rule.
