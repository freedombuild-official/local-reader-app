# Local Reader App

Languages: [English](README.md) | [日本語](README.ja.md)

This README documents the current default-branch source at package version `0.1.0`.

Local Reader App turns folders on your Mac or Windows PC into a private reading workspace in your browser. Use it to browse documentation, source code, text, images, PDFs, and local Git changes without moving those files into another service.

The normal viewer does not edit files in the folders you register. Local Reader App runs on your own computer at `http://127.0.0.1:5173/`. No repository content is sent to an AI service unless you enable AI Chat. Before an AI request, context selected from the Current repo is shown in removable chips; a rule file from the Current repo root may be suggested automatically.

Local Reader App currently runs from the source files on GitHub. There is no `.dmg`, `.exe`, app-store package, hosted account, or one-click installer. The setup below takes you from downloading the source to opening your first folder.

## Project and Authorship

Local Reader App was created by **[Ryusei Komada](https://github.com/freedombuild-official)** and is published under the **FreedomBuild** trade name. The official source is [`freedombuild-official/local-reader-app`](https://github.com/freedombuild-official/local-reader-app).

Copyright remains with Ryusei Komada and other contributors for their respective work. The Apache License 2.0 grants the permissions described in [LICENSE](LICENSE); it does not erase authorship or grant rights to present a modified project as an official FreedomBuild release. See [AUTHORS.md](AUTHORS.md), [NOTICE](NOTICE), and [TRADEMARKS.md](TRADEMARKS.md) for the project identity and attribution details.

## Contents

- [Project and Authorship](#project-and-authorship)
- [What You Can Do](#what-you-can-do)
- [Install and Start on macOS](#install-and-start-on-macos)
- [Install and Start on Windows](#install-and-start-on-windows)
- [Configure the Folders You Read](#configure-the-folders-you-read)
- [Use the Workspace](#understand-the-workspace)
- [Set Up Optional AI Chat](#set-up-optional-ai-chat)
- [Safety and Privacy](#safety-and-privacy)
- [Security Reports](#security-reports)
- [Support and Responsibility](#support-and-responsibility)
- [Update Local Reader App](#update-local-reader-app)
- [Uninstall Local Reader App](#uninstall-local-reader-app)
- [Troubleshooting](#troubleshooting)
- [Technical Overview and Public Interfaces](#technical-overview-and-public-interfaces)
- [For Contributors](#for-contributors)
- [License, Attribution, and Trademarks](#license-attribution-and-trademarks)

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

Local Reader App is primarily a reader, not a general file editor, terminal, Git client, or remote file server. Normal viewing does not write to registered folders. A supported optional AI Chat **Current repo write** entry is the explicit exception and can edit only the Current repo selected for that run after readiness succeeds. Saving Repository Settings updates only Local Reader App's own configuration, while downloading a Memo creates a browser download that you requested. Removing an entry from the repository list never deletes the registered folder.

## Before You Install

You need:

- macOS or Windows;
- [Node.js](https://nodejs.org/en/download) `>=22.13.0 <27`;
- pnpm `10.27.0`;
- a current desktop web browser; and
- enough access to read the folders you want to register.

[Git](https://git-scm.com/downloads) is recommended but not required for basic ZIP-based viewing. Git is needed to clone or update the project with Git and to show change markers, deleted tracked files, and changed lines.

AI software and API keys are optional. You can use every non-AI reading feature without them.

The supported end-user installation paths for `0.1.0` are macOS and native Windows. Linux and WSL2 have source-level CI coverage but no verified end-user installation or lifecycle guide here, so they are not claimed as supported user platforms. Later references to Linux or WSL2 describe the Claude Code CLI security classification only; use macOS or native Windows for the documented setup.

## Get Local Reader App from GitHub

Choose one method on this repository's GitHub page:

1. For the simplest method, select **Code** > **Download ZIP**, extract the ZIP, and remember the extracted folder.
2. If you already use Git, select **Code**, copy the HTTPS URL shown on this GitHub page, and clone that URL.

The commands below use `/path/to/local-reader-app` or `C:\path\to\local-reader-app` as examples. Replace them with the folder you downloaded or cloned.

## Install and Start on macOS

### Install the required tools

1. Install a compatible Node.js version from the official download page.
2. Open **Terminal**.
3. Confirm Node.js and npm, then install the pnpm version used by Local Reader App:

   ```bash
   node --version
   npm --version
   npm install --global pnpm@10.27.0
   pnpm --version
   ```

If the global pnpm installation reports a permissions error, use the official [pnpm installation guide](https://pnpm.io/10.x/installation) instead of changing broad filesystem permissions.

### Install Local Reader App

1. Move into the downloaded Local Reader App folder. The easiest method is to type `cd ` with a trailing space in Terminal, drag the Local Reader App folder from Finder into Terminal, and press `Return`. You can also enter its path directly:

   ```bash
   cd "/path/to/local-reader-app"
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

5. Build Local Reader App:

   ```bash
   pnpm build
   ```

6. Start it:

   ```bash
   pnpm start
   ```

7. Keep Terminal open and visit [http://127.0.0.1:5173/](http://127.0.0.1:5173/) in your browser. The terminal also prints the exact URL and configuration file path.

8. To stop Local Reader App, return to that Terminal window and press `Control+C`.

## Install and Start on Windows

Use **PowerShell**, not Command Prompt, for the commands in this section.

### Install the required tools

1. Install a compatible Node.js version with the official Windows installer.
2. Open **PowerShell**.
3. Confirm Node.js and npm, then install the pnpm version used by Local Reader App:

   ```powershell
   node --version
   npm --version
   npm install --global pnpm@10.27.0
   pnpm --version
   ```

If PowerShell says that `pnpm.ps1` cannot run because of the execution policy, do not weaken the policy. Use `pnpm.cmd` in place of `pnpm` in the commands below, for example `pnpm.cmd --version`.

### Install Local Reader App

1. Move into the extracted or cloned Local Reader App folder. In File Explorer, select that folder, hold `Shift`, right-click, and choose **Copy as path**. In PowerShell, type `Set-Location ` with a trailing space, paste the copied path, and press `Enter`. You can also enter it directly:

   ```powershell
   Set-Location 'C:\path\to\local-reader-app'
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

5. Build Local Reader App:

   ```powershell
   pnpm build
   ```

6. Start it:

   ```powershell
   pnpm start
   ```

7. Keep PowerShell open and visit [http://127.0.0.1:5173/](http://127.0.0.1:5173/) in your browser. PowerShell also shows the exact URL and configuration file path.

8. To stop Local Reader App, return to that PowerShell window and press `Ctrl+C`.

## Start Local Reader App Again

After the first build, normal startup only needs the project folder and `pnpm start`.

On macOS:

```bash
cd "/path/to/local-reader-app"
pnpm start
```

On Windows PowerShell:

```powershell
Set-Location 'C:\path\to\local-reader-app'
pnpm start
```

`pnpm start` does not install dependencies or rebuild updated source. Run the update steps later in this README after downloading a newer version.

## Configure the Folders You Read

Local Reader App calls each registered folder a repository, but the folder can also be a documentation folder that is not managed by Git.

The default configuration file is `repositories.yaml` in the Local Reader App folder. Keep this file private: it contains absolute paths from your computer and is intentionally excluded from Git.

Each entry supports these fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | Yes | A unique name used internally by Local Reader App. |
| `label` | Yes | The name shown in the repository selector. |
| `root` | Yes | An existing, readable absolute folder path. |
| `defaultPath` | No | A file inside `root` to open when the repository is selected, such as `README.md`. |
| `excludes` | No | Repository-relative files or folders to hide. Use `/` inside nested relative paths on every OS. |

Repository IDs must be unique. Two entries cannot point to the same folder, differ only by letter case or Unicode normalization, or have parent-and-child roots. These checks prevent overlapping visibility and AI context boundaries.

`.git` is always hidden. Local Reader App never fetches from Git remotes, even if an older configuration still contains `fetchRemote: true`.

Each `excludes` line supports one of these simple forms:

- a folder or file name such as `node_modules`, matched as a path segment;
- an exact relative path and its descendants, such as `private/exports`;
- an extension pattern such as `'*.pem'`; or
- a name prefix ending in `*`, such as `'secret*'`.

Quote wildcard entries exactly as shown because an unquoted leading `*` has a different meaning in YAML. Other wildcard syntax is not supported. Exclude matching is case-sensitive, so use the exact letter case of the real path. Only `.git` is excluded automatically. Add `.env`, key files, exports, or other sensitive paths yourself when they must not appear in the tree, Local Reader App's AI context choices, or direct HTTP Delivery targets.

**`excludes` is not a native CLI access boundary.** Codex CLI and Claude Code CLI may inspect or change excluded paths anywhere inside the Current repo when using their own tools, subject to the CLI runtime policy. Removing a context chip also removes only the initial context assembled by Local Reader App; it does not prevent the CLI from finding the same file or rule later. Do not enable a CLI entry for a repository containing secrets that the CLI must never access.

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

If another program changes the configuration after Settings loads it, Local Reader App refuses to overwrite the newer file. Return to the viewer, reopen Settings, and try again.

Repository Settings saves and AI runs are mutually exclusive. If a save is rejected because AI Chat is active, wait for that run to finish or cancel it, then validate and save again. If an AI request is rejected while a configuration save is active, wait for the save to finish and retry the request.

### Use a configuration file in another location

On macOS:

```bash
LOCAL_READER_APP_CONFIG="<absolute-path-to-repositories.yaml>" pnpm start
```

On Windows PowerShell:

```powershell
$env:LOCAL_READER_APP_CONFIG = '<absolute-path-to-repositories.yaml>'
pnpm start
```

Settings saves to the selected configuration file, so it must be writable if you want to edit the repository list in the UI.

`READER_WIKI_CONFIG` remains available only as a backward-compatible fallback. New configurations and documentation should use `LOCAL_READER_APP_CONFIG`.

## Understand the Workspace

The main screen has three areas:

1. The left sidebar selects repositories and files.
2. The center displays open files in tabs.
3. The right panel switches between **Outline**, **Memo**, and **AI Chat**.

At narrow browser widths, the right panel moves below the reader, and the workspace eventually becomes a single column.

### Repository selector and file tree

- **Repository** switches between registered roots. Each repository keeps its own file tabs during the current page session.
- **Reload repository** refreshes the file tree and every open tab from the local disk. Use it after another editor or program changes files; Local Reader App does not continuously watch the filesystem.
- **HTTP Delivery** shows the current number of temporary deliveries, their URLs, and a stop button for each one.
- **Collapse all folders** closes every expanded folder except the root. It does not close file tabs.
- Long trees support horizontal scrolling and keep ancestor folders visible at the top. Select a sticky ancestor to jump back to its position.
- Git markers show `new`, `changed`, `deleted`, and binary changes. Changed text lines are also marked in the source viewer.
- A deleted tracked text file can still show its last `HEAD` content when Git can provide it.
- Very large trees may stop at a safe limit and show a partial-tree warning instead of exhausting the computer.

Right-click a file or folder for:

- **Copy Absolute Path**;
- **Copy Relative Path**;
- **Open in New Tab** for files, meaning another file tab inside Local Reader App; and
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

Local Reader App chooses a safe viewer from the file name, content, and size.

| File | Available view |
| --- | --- |
| Markdown | **Rendered** or **Source**. Rendered Markdown hides YAML frontmatter and supports tables, read-only task lists, and code-block copy and wrapping. |
| HTML | **Rendered** in a script-disabled sandbox or **Source**. |
| Source code, JSON, YAML, configuration, and text | **Raw** with line numbers, horizontal scrolling, and local Git change markers. |
| PNG, JPEG, GIF, WebP, and SVG | Image preview. |
| PDF | Embedded browser PDF preview. |
| `.docx` containing Markdown source | Rendered as Markdown. Local Reader App does not reproduce a normal Word page layout. |
| Binary, unsupported, deleted binary, or oversized files | Metadata only, without loading an unsafe or excessive body into the reader. |

The header can copy the full contents of a text-based file. Rendered Markdown code blocks have separate buttons to copy only that block or toggle long-line wrapping.

**Source** wraps long lines for reading. **Raw** keeps line structure and uses horizontal scrolling.

Rendered Markdown and sandboxed HTML can load HTTPS image resources that the document explicitly references, including image URLs in inline CSS. The Content Security Policy blocks other remote subresource types and the HTML sandbox disables scripts, but permitted HTTPS image requests still contact the image host. A newly opened Markdown or HTML file starts in **Rendered** mode, so inspect an untrusted document in a separate plain-text editor before opening it in Local Reader App if you must avoid external requests.

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
- The download button saves `local-reader-app-memo.md` through your browser.
- The delete button clears it immediately.

Memo does not create or edit a repository file. Download anything you want to keep before reloading or closing the page.

## Use HTTP Delivery

HTTP Delivery gives a selected file a temporary URL in a separate tab on the same loopback Local Reader App server. Start it from the center viewer header or a file-tab menu. Use the radio-tower button beside the repository selector to reopen an active URL or stop it.

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

## Adjust Local Reader App in Settings

Select the gear button to open Settings. Returning to the viewer without reloading the page preserves the current tabs, Memo, and AI conversation.

### Basic

- **Reader text scale**: `×1`, `×1.5`, or `×2` for Markdown, HTML, text, code, and document reading surfaces.
- **Appearance**: Light or Dark.
- **Workspace density**: Compact, Comfortable, or Focused.

These three choices are saved in this browser and survive a page reload.

### Repositories

Add, edit, validate, preview, save, and remove repository-list entries. This is the only normal Settings category that writes a file to disk.

### AI Chat

Choose one AI entry, enter only the connection details it needs, and run its readiness check. For a CLI entry, **Authentication and model** can inspect the CLI-owned sign-in, start or cancel the CLI's normal authorization flow, and load the models and model-specific reasoning efforts currently advertised by that CLI. Values and selections in Local Reader App remain in the current page and are not written to `repositories.yaml` or browser persistent storage. Persistent CLI sign-in remains in storage managed by the CLI itself, outside Local Reader App.

## Understand What Is Saved

| Item | Where it lives | After page reload |
| --- | --- | --- |
| Repository list | `repositories.yaml` or the file selected by `LOCAL_READER_APP_CONFIG` | Kept |
| Text scale, theme, and layout | Browser storage for this local site | Kept |
| Open file tabs | Current page memory | Cleared |
| Memo | Current page memory until you download it | Cleared |
| AI conversation | Current page memory | Cleared |
| AI entry state, credential values entered into Local Reader App, and CLI model/effort selection | Current page memory only | Cleared |
| Codex CLI or Claude Code CLI persistent sign-in | Storage managed externally by that CLI | Not cleared by Local Reader App |
| Voice input audio and transcript | Browser or operating-system speech recognition; an external speech service may process audio, while Local Reader App receives the transcript | Browser/provider-dependent |
| HTTP Delivery sessions | Current Local Reader App server process | Cleared when the server stops |
| Files in registered repositories | Read by the viewer; a supported CLI AI Chat request may edit the Current repo | May change after a CLI edit request |

Local Reader App has no built-in repository backup or restore. Before a CLI write, make a verified backup with your normal Git or file-copy workflow. To back up Local Reader App's repository list, copy the actual YAML file shown in **Settings** > **Repositories** > **Config details**; restore it while the server is stopped and start the app again. Browser appearance settings have no export and must be set again if site data is cleared.

## Set Up Optional AI Chat

AI Chat is optional. In this README, “MVP” and “this build” mean the documented `0.1.0` source. The MVP supports an already installed **Codex CLI** or **Claude Code CLI**. Local Reader App can inspect or start the selected CLI's own authentication flow and can use that CLI's authenticated model catalog; it does not create a Local Reader App account or take ownership of the credential. Both CLI entries can use their native tools to work in the Current repo when the runtime can enforce the Current repo boundary. **AI API** and **Local AI** remain visible as future entries, but their action is a disabled **Coming soon** button and they cannot be activated through the normal UI. Their existing connection and Model behavior fields are unchanged. All four cards use the normal `pnpm start` command; there is no separate AI startup command.

You provide and manage any AI account, API key, local runtime, model, endpoint, and credential used with AI Chat. Provider subscriptions, API usage fees, token or quota limits, network access, local model downloads, model licenses, storage, memory, compute, electricity, updates, and model selection are your responsibility. Local Reader App does not pay AI costs, refund provider charges, increase quotas, choose models for you, or provide provider-specific support.

### AI API and Local AI

The AI API and Local AI implementations remain in the source for future development, including provider settings and a guarded edit protocol. They are not a supported public interface in the MVP. Their cards stay visible so the four-entry design is clear, but **Set active** is replaced by a disabled **Coming soon** action, so the normal UI cannot send a provider request or start a local runtime through either entry. Internal loopback API code for these future entries still exists and must not be treated as a supported or disabled security boundary.

### CLI entries

Codex CLI and Claude Code CLI can use their native tools to edit files in the Current repo selected in Local Reader App. Local Reader App starts the selected CLI with that registered repository root as its working directory only after its binary, authentication, selected catalog model/effort pair, required non-interactive flags, and workspace pass readiness.

1. Install Codex CLI or Claude Code CLI separately by following that CLI's official instructions.
2. Start Local Reader App normally with `pnpm start`.
3. Open **Settings** > **AI Chat** and select **Set active** for the installed CLI. Local Reader App re-inspects setup, binds the catalog's explicit default model/effort on the first activation, and runs **CLI Readiness** automatically. If the entry is already active, **Check again** in **Authentication and model** repeats that complete sequence.
4. If sign-in is required, select **Sign in** and complete the URL/device-code flow owned by the CLI. Local Reader App shows only the transient authorization URL or code returned by the CLI; the resulting credential remains in CLI-managed storage. You can also authenticate from your own terminal. Codex uses persistent sign-in, and Local Reader App intentionally does not forward `OPENAI_API_KEY` or `CODEX_API_KEY`. Claude Code can use persistent sign-in or supported launcher environment values: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, and `CLAUDE_CONFIG_DIR`. Local Reader App does not display or persist those values.
5. Review the selected model and reasoning effort, or choose another advertised pair. The catalog's explicit default is used only when no prior selection exists. Local Reader App has no fixed fallback and does not silently replace a prior pair that disappears after a catalog or CLI change.
6. Confirm that **CLI Readiness** succeeded, then send the request from AI Chat. Changing the model/effort or Current repo invalidates readiness; select **Check readiness** or use **Check again** to re-inspect setup and rerun readiness.

Setup inspection and readiness do not edit repository files. **Authentication and model** uses Codex App Server account/catalog metadata or Claude Agent SDK account/catalog metadata; checking that card does not send a chat model request. Codex **CLI Readiness** inspects the installed CLI, persistent sign-in, selected catalog pair, flags, Current repo write access, and project MCP isolation without sending a model request. Claude Code **CLI Readiness** additionally sends one no-tool model prompt so an expired or rejected credential is not reported as ready. Local Reader App can start the CLI-owned authorization flow, but it does not install a CLI, download a model, expose an in-app terminal, or store the resulting credential.

An in-app compatibility update is offered when the installed CLI has a known compatibility deficiency and the executable belongs to a package layout that Local Reader App can revalidate. A compatible managed CLI also shows an explicit **Check and apply latest** action. Local Reader App does not claim that a newer version exists before that action: the CLI updater combines the check and application, and it runs only after a server-issued, short-lived confirmation followed by a browser confirmation. When the updater finishes, Local Reader App re-inspects setup and reruns readiness; it reports the updater result without assuming that the version changed. For managed Codex packages, the update check pins the canonical launcher, package and platform metadata, native payload, runtime metadata, and Node interpreter by file identity and content digest. Managed Claude layouts pin the exact package manifest and launcher/interpreter chain, or the exact official native version path. Every member is re-read immediately before the fixed update command; any replacement or mismatch stops the update. Custom or unmanaged executables must be updated with their original package manager. Local Reader App never updates either CLI as part of **Set active**, **Check again**, startup, polling, or automated validation, and this feature is not a cryptographic proof of package authenticity. Setup, authentication, readiness, and AI Chat use only a server-resolved execution descriptor. Managed package members and custom launcher identities are re-read by canonical path, regular-file identity, and content digest before use and after version revalidation; a bounded custom script also pins its one native shebang interpreter. The inspected descriptor is held fixed for the operation instead of accepting a binary or path from the browser.

Claude Agent SDK `0.3.211` is pinned exactly. Its catalog discovery runs inside a fixed, Local Reader App-owned worker process group on macOS and Linux and supports a revalidated managed native package or managed Node/npm launcher chain. The server passes only its server-resolved execution descriptor—the canonical native binary plus at most one canonical launcher prefix—to the worker. The SDK receives that binary and prefix as its executable and executable arguments instead of resolving the launcher's shebang or `PATH` again. The server does not accept a worker command or path from the browser and verifies that the whole group has stopped before accepting the catalog result. Until stable process-tree ownership is available, native Windows fails closed before starting either CLI's setup inspection, authentication, catalog discovery, update, readiness probe, or AI Chat turn. The normal Local Reader App viewer remains supported on native Windows; this restriction applies only to the Codex CLI and Claude Code CLI entries. AI API and Local AI remain unchanged disabled **Coming soon** entries.

Claude Code setup is currently a foundation-only integration in this release: the production adapter and Local HTTP contract are present and covered by fake/static tests, but the maintainers did not use a Claude subscription to live-validate authentication, catalog loading, or a model request. Treat live Claude compatibility as unverified until it is tested with an eligible account. Codex setup, catalog selection, and a normal send are the live validation gate for this change.

On supported CLI runtimes, Codex CLI runs non-interactively with the Current repo as `-C` and a unique per-run permission profile that makes only that workspace writable. User config is ignored for the run, unrelated built-in integrations are disabled, and existing exec-policy rules are not bypassed. Claude Code CLI runs with the Current repo as its working directory, no user/project/local setting sources or additional directories, and its native `Bash`, `Glob`, `Grep`, `Read`, `Edit`, and `Write` tools in `acceptEdits` mode. On macOS and a Linux runtime, its native Bash sandbox must start successfully and cannot retry a command outside the sandbox. Native Windows starts neither CLI entry because Local Reader App cannot yet enforce and verify the same complete process-tree boundary there; WSL2 is classified as a Linux runtime for this check, but that classification does not make WSL2 a supported Local Reader App user platform.

Local Reader App does not translate a CLI response into Local Reader App's guarded provider edit protocol and does not impose that protocol's file-count, directory, read-round, or operation-type limits on a CLI run. The CLI may inspect and change additional files inside the Current repo when needed to complete the request; selected context chips and configured `excludes` are not an edit-path or native-tool access limit. Review the response and actual working-tree diff before deciding what to keep.

### Choose context and send a message

1. Complete the active entry's readiness check.
2. For a repository-specific question, right-click a file or folder in the tree and select **Send a path to AI Chat**.
3. Review the context chips above the message box. Removing a chip keeps it out of the initial context assembled by Local Reader App, but does not prevent a CLI entry from finding the same path later with native tools.
4. Enter a message and send it.

Selecting a path is optional. Skip step 2 for a general question, an attachment-only request, or a repo-wide edit instruction that does not need an initial path hint. A directory or several selected files are valid context. Review an automatically suggested root rule before sending; removing it affects only the initial context and is not a guarantee that a CLI cannot discover that rule inside the Current repo.

An open file is not sent automatically. A selected file can contribute text; a selected directory contributes only its direct child list, not every nested file. When present, root `AGENTS.md` or `CLAUDE.md` rules appear as a visible, removable rule chip.

Tree-selected paths and uploaded attachments are one-request context: they disappear from the composer after sending. A retry reuses only the previous message text and does not silently restore those one-time items.

AI context is bounded to 12 primary items, 2 rule items, 64 KiB in total, and at most 16,000 characters from one file. Images, PDFs, binaries, unsupported files, and oversized files contribute metadata rather than body content.

### Conversation controls

- Select **New chat** in the AI Chat-only header to clear the transcript, draft, retry state, attachments, and one-request context without clearing the active AI Entry or its readiness state.
- Switch repositories without clearing the active AI Entry, transcript, or draft. CLI readiness is cleared immediately, and the composer remains unavailable until readiness succeeds for the newly selected Current repo.
- A response is added to the conversation when the selected CLI run completes.
- Copy any user or AI message.
- Cancel an active request.
- Retry the last failed request.
- Use Markdown tables, task lists, and code-block copy and wrapping in AI responses.
- Press `Enter` to send. Use `Shift+Enter` or `Ctrl/Command+Enter` for a new line.
- Use voice input when the browser exposes a compatible speech-recognition feature.
- Upload up to five files. Recognized text files up to 64 KiB are eligible to include text, with at most 12,000 characters used per attachment in the provider prompt. Other attachments send name, type, and size metadata only.
- The complete AI request body is limited to about 140 KiB, so several large text attachments can still be rejected. Use fewer or smaller files when that happens.
- Choose the model and model-specific reasoning effort advertised by the active Codex CLI or Claude Code CLI. The selected pair is shown beside the composer and is sent as actual CLI arguments.

Only one AI run can use the same repository at a time, with up to four runs across the server. A CLI readiness lease is scoped to the selected repository/revision, entry, CLI version, catalog revision, server-owned setup generation, model, effort, and inspected execution descriptor. Each catalog refresh, authentication change, update transition, or provider invalidation advances that generation. Switching repositories, changing any selected/catalog value, or receiving a newer setup generation therefore requires an explicit current selection and a new readiness result instead of reusing the previous lease, even if the same catalog revision and pair reappear. A stale setup response cannot overwrite a newer terminal state; an observed setup identity change also cancels an in-flight browser request. After the lease expires, sending repeats the same checks before continuing. A failed renewal or stale pair stops before the CLI run. Reloading the page clears the in-memory conversation and model selection. Restarting the server invalidates the old browser session but does not erase an already open page by itself; reload or reopen the URL printed by the new server to create a fresh session, which also clears the conversation.

AI Chat displays only the AI Entry's user-facing natural-language response. Local Reader App keeps its best-effort change audit and warnings as internal run metadata for repository refresh and retry control instead of appending them to the conversation. If execution fails, the conversation shows a short explanation and next action rather than raw CLI output. AI remains advisory; a person must review the response, repository, and actual working-tree diff and decide what to keep.

## Safety and Privacy

- Local Reader App accepts exactly `127.0.0.1`, `localhost`, or `::1` as `HOST`. It refuses `0.0.0.0`, other loopback addresses, and network interfaces.
- Each server start creates a new server-side session token. Open or reload the exact URL printed by that server to receive the new browser session; an old tab's API calls fail after restart until it is reloaded. Write-like configuration actions also require the exact local origin and request format.
- Requested paths must stay inside a registered root. Absolute input paths, `..` traversal, and excluded paths are rejected. File-body reads and HTTP Delivery also reject every symbolic-link path component, while tree navigation refuses links that resolve outside the root.
- `.git` is always excluded from file viewing. Git commands are used only for local status and diff information; Local Reader App does not contact Git remotes.
- Rendered Markdown and sandboxed HTML may contact explicitly referenced HTTPS image hosts. Other remote subresource types are restricted by Content Security Policy and HTML scripts are disabled, but inspect untrusted documents as plain text elsewhere before opening them when any network request is unacceptable.
- Voice input uses the browser's speech-recognition feature. Depending on the browser and operating system, audio may be processed by an external speech service; Local Reader App cannot select, verify, or control that service's storage. Use typed input if this is unacceptable.
- Normal viewing does not edit repository files. Repository Settings writes only the selected Local Reader App configuration file.
- AI API and Local AI are disabled **Coming soon** entries in the normal UI, which cannot send repository context or edit requests through them. Their future internal loopback API implementation is not a supported interface or an access-control guarantee.
- Codex CLI and Claude Code CLI are the explicit AI Chat write entries on supported CLI runtimes. They receive the conversation and visible context, may inspect additional Current repo files with their native tools, and can create, update, rename, or delete multiple files and nested directories without Local Reader App's provider edit limits. Local Reader App supplies no additional workspace root. Neither CLI entry starts on native Windows in this MVP because complete process-tree ownership cannot yet be enforced and verified there.
- HTTP Delivery uses temporary, restricted local URLs and does not turn Local Reader App into a public server.

Do not run Local Reader App on an untrusted copy of its own source, and do not expose its port through a tunnel or network rule. To report a security problem privately, follow [SECURITY.md](SECURITY.md).

## Security Reports

Do not report an unpatched vulnerability in a public issue, discussion, pull request, AI prompt, screenshot, or log. If GitHub shows **Security** > **Advisories** > **Report a vulnerability** for this repository, use that private workflow. Otherwise email [`info.freedombuild@gmail.com`](mailto:info.freedombuild@gmail.com) with the subject `[Security] Local Reader App`.

Include the affected revision, operating system, reproduction conditions, expected impact, and the smallest safe proof of concept. Remove credentials, personal data, private paths, and confidential repository contents. See [SECURITY.md](SECURITY.md) for the complete reporting policy.

## Support and Responsibility

Local Reader App is provided as free, open-source software under the Apache License 2.0. It does not include individual installation, configuration, operation, or troubleshooting support comparable to a paid product or support contract.

Decide whether and how to use Local Reader App at your own discretion and responsibility. Keep backups of important repositories before changing tools, settings, dependencies, or enabling a CLI entry. You are responsible for checking the effect of commands you run, folders you register, files you expose through HTTP Delivery, context you send to AI, and every file change produced by Codex CLI or Claude Code CLI.

After the repository is public, use [GitHub Issues](https://github.com/freedombuild-official/local-reader-app/issues) for reproducible bugs and focused feature proposals. Include the source version or revision, operating system, steps, expected and actual behavior, and a sanitized exact error. An issue does not guarantee an individual reply, a fix, a release date, or a service-level agreement. Security reports are different: follow [SECURITY.md](SECURITY.md) and do not post unpatched vulnerability details in an issue, discussion, AI prompt, screenshot, or log.

## Update Local Reader App

Stop the running server with `Control+C` or `Ctrl+C` before updating.

### If you cloned with Git

From the Local Reader App folder:

```bash
git pull --ff-only
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

On PowerShell, use the same commands. If the execution policy blocks `pnpm.ps1`, substitute `pnpm.cmd`.

### If you downloaded a ZIP

1. Download and extract the new ZIP into a new folder.
2. Copy your private `repositories.yaml` from the old Local Reader App folder into the new one.
3. In the new folder, run `pnpm install --frozen-lockfile`, `pnpm build`, and `pnpm start`.
4. Confirm your repositories and settings before deleting the old Local Reader App folder.

## Uninstall Local Reader App

1. Stop the server with `Control+C` or `Ctrl+C`.
2. If you want to keep the repository list, save a copy of `repositories.yaml` elsewhere.
3. Delete the Local Reader App project folder.
4. Optionally clear site data for the local origin you used—`http://127.0.0.1:5173` by default—to remove the saved text scale, theme, and layout.

Uninstalling Local Reader App does not delete any registered repository folder.

## Troubleshooting

If you are stuck, you can attach this README file to an AI assistant and ask it to walk through the current step with you. Tell it your operating system, Local Reader App version or source revision if known, the step you are on, the exact command or click you tried, and the exact error message. Remove API keys, passwords, tokens, cookies, `.env` contents, personal information, private paths, and confidential repository data before sending anything. AI suggestions can be wrong, so read the command and its effect before running it. Asking an AI assistant does not mean the maintainers provide individual support.

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

Make sure you started Local Reader App from its own folder and created `repositories.yaml`. If you use `LOCAL_READER_APP_CONFIG`, confirm that its absolute path is correct.

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

Select **Reload repository**. Local Reader App does not continuously watch the registered folders.

### Git change markers do not appear

Confirm that Git is installed, the registered folder is a Git working tree, and `git status` works there. Basic file viewing continues when Git information is unavailable.

### AI readiness fails

- On native Windows, CLI setup, readiness, and AI Chat intentionally remain unavailable until stable complete process-tree ownership is implemented. Normal repository viewing is still supported.
- Confirm that Codex CLI or Claude Code CLI is installed and works from your own terminal.
- Select **Set active**, or select **Check again** in **Authentication and model** for the active entry. Local Reader App re-inspects setup, safely binds a usable catalog pair, and runs readiness. Complete **Sign in** if required; if a prior pair disappeared, choose a currently advertised model and reasoning effort explicitly.
- You can also run the CLI's own authentication status command in your terminal and complete sign-in there.
- Codex CLI must use persistent sign-in; Local Reader App does not forward `OPENAI_API_KEY` or `CODEX_API_KEY` to it.
- Claude Code CLI may use persistent sign-in or the supported Claude authentication environment inherited from the process that starts Local Reader App.
- For Claude Code, a stale or rejected `ANTHROPIC_API_KEY` can override persistent sign-in. Remove or replace that variable, complete `claude auth login` if needed, and start Local Reader App from the corrected terminal.
- If the catalog changed, reselect a valid model/effort pair. Local Reader App deliberately does not substitute another model for a stale selection.
- Confirm that the selected Current repo still exists and is writable by your account.
- Select **Check readiness** again after changing a model/effort or repository. AI API and Local AI remain disabled **Coming soon** entries in this build.

### Local Reader App could not confirm that the CLI stopped

The server deliberately keeps that Current repo locked because the CLI process tree may still be running. Closing the CLI alone does not clear the lock:

1. Close the CLI process and any child process it started.
2. Review the Current repo and decide how to handle any partial changes.
3. Stop the Local Reader App server with `Control+C` or `Ctrl+C`, then run `pnpm start` again.
4. Reload or reopen the exact URL printed by the new server, run readiness again, and only then retry. The reload clears the in-memory conversation.

### Voice input is unavailable

The microphone button is enabled only when the browser provides a compatible speech-recognition API. Typed AI Chat remains available.

### HTTP Delivery rejects a file

Use the main viewer for HTML, HTM, or SVG. For a local Markdown asset, confirm that the document explicitly references it without `../`, that it is in the Markdown file's directory or a subdirectory, and that it is not excluded or reached through a symbolic link. Delivered Markdown is limited to 2 MiB; other delivered files and assets are limited to 25 MiB.

## Technical Overview and Public Interfaces

Local Reader App has a React/Vite browser client and a local Express server. The server reads the configured YAML file, validates every registered root, performs guarded filesystem and local Git operations, and serves the client and loopback API in one process. Optional Codex CLI and Claude Code CLI entries run as separate child processes only after their readiness and Current repo checks succeed. The project has no hosted backend, account system, or built-in telemetry service.

The supported operator-facing interfaces are:

| Interface | Purpose and compatibility |
| --- | --- |
| `pnpm start` | Starts the last production build. Run `pnpm build` first after installation or an update. |
| `pnpm dev` | Starts the development server with automatic source updates. Use it only when developing Local Reader App. |
| `http://127.0.0.1:5173/` | Default local URL. `PORT` can change the port; `HOST` accepts only `127.0.0.1`, `localhost`, or `::1`. |
| `repositories.yaml` | Default private repository list. Start from `example.repositories.yaml`; do not commit your real paths. |
| `LOCAL_READER_APP_CONFIG` | Selects another repository configuration file. `READER_WIKI_CONFIG` is a legacy fallback. |
| `LOCAL_READER_APP_AI_CHAT_SYSTEM_PROMPT` | Selects a custom Markdown system prompt containing `version` frontmatter. `READER_WIKI_AI_CHAT_SYSTEM_PROMPT` is a legacy fallback. |
| `VITE_HMR_PORT` | Overrides the development-only browser hot-reload port when needed. |

Internal `ReaderWiki*` types, `reader_wiki_*` protocol values, cookies, local-storage keys, loopback JSON endpoints, and `X-Reader-Wiki-*` headers are compatibility implementation details, not a promised external API. A future release may change them with the corresponding client and server together.

## For Contributors

Contributions use the standard Apache-2.0 inbound-equals-outbound model: no CLA or copyright assignment is required, and contributors retain copyright in their own work while licensing submitted contributions under Apache-2.0.

1. Fork the official repository, clone your fork, and create a focused branch.
2. Install the locked dependencies, make one coherent change, and add or update tests and both README languages when behavior changes.
3. Run every verification command below.
4. Push your branch and open a pull request against the official `main` branch. Explain the problem, chosen change, user or safety impact, and verification results.

Do not include credentials, tokens, private repository content, personal paths, customer data, or unrelated generated files. Report vulnerabilities through [SECURITY.md](SECURITY.md), not a public issue or pull request. [CONTRIBUTING.md](CONTRIBUTING.md) contains the complete contribution policy.

Use the live development server only when changing Local Reader App itself:

```bash
pnpm install --frozen-lockfile
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

Keep [README.md](README.md) and [README.ja.md](README.ja.md) aligned when behavior, commands, limits, warnings, or public identity changes. GitHub Actions checks frozen installation, types, tests, the production build, and the public-source scan on Ubuntu, Windows, and macOS.

## License, Attribution, and Trademarks

Local Reader App is licensed under the [Apache License 2.0](LICENSE). Copyright 2026 Ryusei Komada. Other contributors retain copyright in their respective contributions. [NOTICE](NOTICE) records the original project attribution, and [AUTHORS.md](AUTHORS.md) identifies the original creator and maintainer.

Apache-2.0 permits use, modification, and distribution subject to its terms, but it does not grant rights to FreedomBuild's trade name, the Local Reader App project identity, or a future official logo. Use those identifiers accurately and distinguish forks or modified distributions from official releases as described in [TRADEMARKS.md](TRADEMARKS.md).

To cite the project, use [CITATION.cff](CITATION.cff). To contribute, follow [CONTRIBUTING.md](CONTRIBUTING.md).

## Summary

Local Reader App is a local browser workspace for reading one or more folders without handing normal viewing control of those files to a hosted service. Start with the macOS or Windows guide, register an absolute folder path, and use the complete feature sections above as your operating manual. AI Chat remains optional. Its removable chips show the initial context, while a supported CLI entry may inspect additional files inside the Current repo when needed for the request.
