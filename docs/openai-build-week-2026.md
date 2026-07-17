# OpenAI Build Week 2026 Evidence

## Overview

Local Reader App is a Developer Tools submission for OpenAI Build Week 2026. It turns local folders into a browser-based reading workspace for documentation, source, text, images, PDFs, and Git changes. Optional AI Chat can use Codex CLI or Claude Code CLI while keeping authentication with the CLI and making the Current repo boundary explicit.

The project existed before the event. This document separates the pre-existing baseline from the meaningful extension completed after the Submission Period opened.

## Submission Period and Baseline

The official Submission Period opened on July 13, 2026 at 09:00 PDT, which was July 14, 2026 at 01:00 JST. Commit `5273915` was created before that boundary and is the baseline for the event delta.

The fixed core comparison is:

```text
5273915..7ec6be6
```

That range changes 32 files with 12,493 insertions and 241 deletions. Later documentation, packaging, site, and submission commits are recorded separately instead of being presented as pre-existing core functionality.

## Meaningful Extension During Build Week

The core Build Week commits are:

| Commit | Meaningful extension |
| --- | --- |
| `423368f` | Added CLI-owned authentication, dynamic model and reasoning catalogs, and managed CLI update behavior. |
| `005f426` | Preserved readiness while adding explicit Standard/Fast inference selection. |
| `0cea07d` | Added tab-scoped AI state, repository-scoped conversation persistence, and aligned model selection. |
| `4e71660` | Added a fail-closed Windows boundary for CLI process tests. |
| `7ec6be6` | Hardened Windows managed CLI resolution. |

These changes affect real runtime behavior, state ownership, safety checks, cross-platform boundaries, and automated tests. They are not a cosmetic rebrand of the pre-event project.

## Codex and GPT-5.6 Collaboration

The primary Codex session ID is:

```text
019f696e-2220-7fc1-bd3d-7bdd8a9c03de
```

The primary implementation session ran in Codex App with GPT-5.6 Sol (`gpt-5.6-sol`). Codex helped inspect the existing code and contracts, implement scoped changes, add regression tests, run builds and safety scans, and review failures against the intended boundary.

GPT-5.6 was used for the implementation reasoning in that session, including the interaction between CLI-owned authentication, dynamic catalogs, stale configuration handling, inference-speed selection, session persistence, and Windows process ownership.

## Human Decisions

The human maintainer remained the decision-maker and chose:

- to keep Local Reader App local-first and source-first;
- to make normal viewing read-only while keeping AI write mode explicit;
- to preserve CLI-owned authentication instead of collecting provider credentials in the app;
- to reject stale model and reasoning selections instead of silently replacing them;
- to fail closed where Windows process-tree ownership is not yet stable;
- to submit the working application, with a separate site as the judge-facing entry point; and
- to provide an event-specific judge package without presenting it as a general desktop release.

## Judge Test Path

The event-specific package contains prebuilt `dist/` and `dist-server/` output, the production dependency manifest, an anonymous sample workspace, and a SHA-256 manifest. Judges install production dependencies and start the package without running `pnpm build`.

See [JUDGING.md](JUDGING.md) for exact commands, supported-platform boundaries, and the suggested test flow.

## Judging Criteria Mapping

### Technological Implementation

The repository provides runtime code, tests, a cross-platform CI matrix, explicit path guards, fail-closed AI readiness, dynamic CLI catalogs, and repository-scoped session persistence. The fixed commit range above makes the event delta reproducible.

### Design

The three-column workspace combines repository navigation, a multi-format reader, file and Git context, outline and memo tools, and optional AI Chat. The judge package opens an anonymous sample rather than requiring access to a private folder.

### Potential Impact

Developers, technical writers, and small teams can read local source and documentation without first copying it into a hosted knowledge service. Optional AI remains a deliberate extension rather than a requirement for the core reader.

### Quality of the Idea

Local Reader App combines a reader-first workspace with optional repo-scoped AI, CLI-owned authentication, removable initial-context chips, dynamic model catalogs, and explicit human review boundaries. The result is different from a generic hosted chat interface or a full file editor.

## Reproduce the Git Evidence

From a clone of the public repository:

```bash
git log --format='%h %aI %s' 5273915..7ec6be6
git diff --shortstat 5273915..7ec6be6
git diff --name-status 5273915..7ec6be6
```

The current submission source may include later evidence and packaging commits. The fixed comparison above remains the boundary for the five core implementation commits.

## Official Event References

- [OpenAI Build Week Official Rules](https://openai.devpost.com/rules)
- [OpenAI Build Week FAQ](https://openai.devpost.com/details/faqs)

## Summary

Local Reader App is submitted as a pre-existing project with a timestamped, testable, and substantial Build Week extension. The public Git history, primary Codex session ID, no-build judge path, and explicit human decisions make the collaboration and event delta auditable.
