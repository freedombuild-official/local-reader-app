# Security Policy

## Overview

Reader-Wiki reads local repositories and exposes a loopback HTTP service. Security reports should be handled privately until maintainers have assessed the impact and prepared a fix.

## Supported Versions

Before the first public release, only the current default-branch source is supported.

| Target | Security support |
| --- | --- |
| Current default branch | Supported |
| Older commits, local forks, and modified builds | No guaranteed updates |

## Reporting a Vulnerability

Use GitHub's private vulnerability reporting for this repository:

1. Open the repository's **Security** tab.
2. Open **Advisories**.
3. Choose **Report a vulnerability** and submit the report privately.

Include the affected revision, operating system, reproduction conditions, expected impact, and the smallest safe proof of concept. Remove credentials, private repository contents, and personal data from the report.

Do not disclose an unpatched vulnerability in a public issue, discussion, or pull request. If **Report a vulnerability** is unavailable, private vulnerability reporting has not been configured; do not publish exploit details through a public channel.

## Maintainer Response

Maintainers should acknowledge the private report, reproduce it where safe, determine affected versions, and coordinate remediation and disclosure with the reporter. No response-time or release-time guarantee is made before a public maintenance policy is adopted.

## Publication Gate

The public GitHub namespace and a private reporting destination are not encoded in this source because no verified repository URL is available. Before publication, a maintainer must:

- choose and verify the public GitHub namespace;
- enable GitHub private vulnerability reporting;
- confirm that the **Report a vulnerability** action is available to outside reporters; and
- add verified `repository`, `homepage`, and `bugs` metadata to `package.json` in a separately reviewed change.

Until these checks are complete, publication remains **HOLD**. Do not invent an email address or repository URL to bypass this gate.

## Summary

Report vulnerabilities through the repository's private GitHub security workflow. Public disclosure and publication must wait until the maintainer has verified that workflow and the public namespace.
