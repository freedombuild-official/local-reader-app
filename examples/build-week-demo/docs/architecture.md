# Architecture

## Overview

The sample describes a local reading workflow with three layers: a folder registry, a guarded file service, and a browser workspace.

## Folder Registry

The registry contains an ID, a label, an absolute root, an optional default file, and explicit exclusions. Roots cannot overlap.

## Guarded File Service

The service resolves repository-relative paths, rejects traversal outside the registered root, classifies content, and returns only the data needed by the selected viewer.

## Browser Workspace

The browser presents a file tree, multi-file tabs, a reader, an outline, file information, and an optional AI panel. The normal reader path does not write to registered files.

## Data Flow

1. The user selects a registered folder.
2. The local service validates the root and requested relative path.
3. The browser receives safe metadata and supported content.
4. The user decides whether to open another file or enable an optional action.
