# Local Reader App Judging Guide

## Overview

The `build-week-2026-judge` prerelease is an event-specific test package for the Developer Tools track. It contains prebuilt browser and server output plus an anonymous sample workspace. It is not a desktop installer or a general binary release.

## Requirements

- macOS or native Windows
- Node.js `>=22.13.0 <27`
- pnpm `10.27.0`
- a current desktop browser
- network access only for the production dependency installation

The normal viewer does not require an AI account, API key, Codex CLI, or Claude Code CLI.

## Start Without Rebuilding

1. Download and extract the judge package from the [`build-week-2026-judge` prerelease](https://github.com/freedombuild-official/local-reader-app/releases/tag/build-week-2026-judge).
2. Open a terminal in the extracted `local-reader-app-build-week-judge` folder.
3. Install only production dependencies:

   ```bash
   pnpm install --prod --frozen-lockfile
   ```

4. Start the prebuilt application and its packaged sample:

   ```bash
   pnpm start:judge
   ```

5. Open the exact loopback URL printed in the terminal. The default is [http://127.0.0.1:5173/](http://127.0.0.1:5173/).
6. Stop the server with `Control+C` on macOS or `Ctrl+C` on Windows.

Do not run `pnpm build`. The package already contains `dist/` and `dist-server/`.

## Suggested Five-Minute Test

1. Open the sample `README.md` and switch between Rendered and Source views.
2. Expand `docs/` and open `architecture.md` and `safety-boundaries.md` in separate file tabs.
3. Open `src/reader.ts` to inspect source with line numbers.
4. Use Outline to navigate headings and inspect File Information.
5. Change the appearance or text size in Settings, then return to the workspace.
6. Confirm that the anonymous sample remains the only registered folder.

## AI Chat Boundary

AI Chat is optional and is not needed for judging the normal viewer. The packaged sample does not include provider credentials or enable an AI entry automatically.

The submission video demonstrates the Build Week Codex and GPT-5.6 work. Judges do not need to authenticate a CLI or grant write access to complete the no-build test path.

## Supported-Platform Evidence

The documented end-user platforms are macOS and native Windows. The final judge package is manually smoke-tested on macOS. The package generator, typecheck, unit tests, and production build run in the repository's Ubuntu, Windows, and macOS GitHub Actions matrix.

The Windows CI result does not claim a manual Windows browser smoke test. Any platform not manually tested is identified as such rather than inferred from a successful build.

## Package Provenance

`JUDGE_BUILD_MANIFEST.json` records:

- the Git source commit;
- whether the source worktree was clean;
- the allowlisted package inputs; and
- the size and SHA-256 digest of every packaged file except the manifest itself.

The release page publishes the archive SHA-256 separately. A final public judge package must be generated with `--require-clean` from the recorded source commit.

## Privacy and Safety

- The package contains only public project files and the fictional `examples/build-week-demo` workspace.
- It does not contain credentials, private repository paths, customer data, or local configuration.
- The server binds to `127.0.0.1` by default.
- The sample launcher writes its generated repository configuration to a temporary directory and removes it when the server exits.
- Normal viewing does not edit the sample files.

## Known Boundaries

- Production dependencies must be installed after extraction; the project source does not need to be compiled.
- The package is a local browser application, not a hosted demo.
- Git change markers require a Git repository. The packaged sample focuses on the reader path and does not create Git history automatically.
- Optional AI Chat requires separate CLI readiness and remains outside the five-minute no-build path.

## Source-Based Alternative

The public repository remains the canonical source. The normal source installation and verification commands are documented in the root [README](../README.md). The judge package exists only to satisfy the event's test-without-rebuilding requirement.

## Summary

Install production dependencies, run `pnpm start:judge`, and inspect the packaged sample at the printed loopback URL. No source build, private data, or AI credential is required.
