# Security Policy

## Overview

Local Reader App reads local repositories and exposes a loopback HTTP service. Security reports should be handled privately until maintainers have assessed the impact and prepared a fix.

## Supported Versions

Until the project publishes tagged releases with a different policy, only the current default-branch source is supported.

| Target | Security support |
| --- | --- |
| Current default branch | Supported |
| Older commits, local forks, and modified builds | No guaranteed updates |

## Reporting a Vulnerability

Use a private channel. If GitHub shows **Security** > **Advisories** > **Report a vulnerability** for this repository:

1. Open the repository's **Security** tab.
2. Open **Advisories**.
3. Choose **Report a vulnerability** and submit the report privately.

If that action is unavailable, email [`info.freedombuild@gmail.com`](mailto:info.freedombuild@gmail.com) with the subject `[Security] Local Reader App`.

Include the affected revision, operating system, reproduction conditions, expected impact, and the smallest safe proof of concept. Remove credentials, private repository contents, private paths, and personal data from the report. Email is not an encrypted secret-storage channel, so replace real secrets with redacted examples.

Do not disclose an unpatched vulnerability in a public issue, discussion, pull request, AI prompt, screenshot, or log.

Reports are especially useful for path traversal or symbolic-link escapes, unintended file exposure, loopback or session-boundary failures, unsafe file rendering, and AI CLI execution outside the selected Current repo. General setup questions and feature requests belong in the normal project issue workflow after the repository is public.

## Maintainer Response

Maintainers should acknowledge the private report when practical, reproduce it where safe, determine affected revisions, and coordinate remediation and disclosure with the reporter. No response-time, fix, or release-time guarantee is made.

## Summary

Use GitHub private vulnerability reporting when it is available; otherwise use the private email fallback above. Keep vulnerability details out of public channels until maintainers have assessed the report and coordinated disclosure.
