# Safety Boundaries

## Local by Default

The reader runs on loopback and reads only folders registered by the user. It does not fetch a Git remote or upload the sample to a hosted workspace.

## Normal Viewing

Normal viewing does not edit files. Settings write only to the application's own repository configuration, and Memo download is an explicit browser download.

## Optional AI

AI Chat is separate from the reader. The selected Current repo and initial context are visible before a request. A write-capable run must be chosen explicitly and remains subject to the CLI runtime's own policy.

## Human Review

An AI response is a proposal or implementation aid, not the final decision-maker. The user reviews changes, tests, and publication boundaries.
