# Contributing to Local Reader App

## Overview

Contributions that improve Local Reader App are welcome. A contribution may be code, a test, documentation, a reproducible bug report, or a focused design proposal. The maintainer decides whether and when a contribution fits the project.

## Before You Start

1. Read [README.md](README.md), especially the safety, AI Chat, development, and verification sections.
2. Check existing issues and pull requests before starting overlapping work.
3. Open an issue before a large or behavior-changing contribution so the scope and safety boundary can be discussed first.
4. Keep each contribution focused on one decision. Do not mix unrelated formatting, generated files, or local configuration into the same change.

Do not include credentials, tokens, private repository content, personal paths, customer data, or other confidential information. Report security problems through [SECURITY.md](SECURITY.md), not through a public issue or pull request.

## Development and Verification

Install the locked dependencies and run the normal gates:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm audit --prod
pnpm run scan:public
```

Update `README.md` and `README.ja.md` together when a user-facing command, feature, limit, warning, support boundary, license statement, or safety behavior changes.

## Contribution License

Local Reader App uses the Apache License 2.0. Unless you explicitly state otherwise when submitting it, any contribution intentionally submitted for inclusion in this project is provided under the Apache License 2.0, consistent with section 5 of that license.

This project uses the normal Apache-2.0 contribution model:

- contributors retain copyright in their own contributions;
- accepted contributions are distributed under Apache-2.0;
- no Contributor License Agreement or Copyright Assignment Agreement is required; and
- submitting a contribution does not transfer ownership of the original Local Reader App code or of the project name and branding.

You must have the right to submit every part of your contribution. Preserve third-party license and attribution notices when they apply.

## Pull Request Expectations

A pull request should explain the problem, the chosen change, affected behavior, and the verification performed. Include screenshots only when they add information that text and tests cannot show, and remove private data before attaching them.

The maintainer may request a smaller scope, additional tests, documentation parity, or safety changes. Acceptance is not guaranteed, and accepting a contribution does not create an individual support or maintenance commitment.

## Summary

Submit focused, testable changes; protect confidential information; keep English and Japanese public documentation aligned; and provide contributions under Apache-2.0 without copyright assignment.
