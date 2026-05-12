# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- In-editor note explorer for browsing and switching notes without leaving the page.

### Changed

- Migrated package manager from npm to pnpm.
- Extracted monolithic App component into dedicated page components and feature modules for better maintainability.

### Fixed

- Speed up note opening and preview rendering.
- Clear stale PDF preview when switching between notes.
- Cache bundled Chromium in Docker images to speed up builds.

## [1.0.0] - 2026-05-02

### Added

- Per-export shareable PDF links with UUID tokens. Each export gets a unique, cryptographically random share URL (`/pdf/:token`) that can be shared without owner authentication.
- Revocable share links: delete an individual token at any time, returning a 404.
- Stale token cleanup: tokens pointing to deleted exports are automatically purged.

### Changed

- Refreshed application stylesheet with 600+ lines of style improvements.
- Editor font-size increased to 16px for better readability.
- Responsive preview-collapse breakpoint lowered to 600px for improved mobile experience.

## [0.1.8] - 2026-05-01

### Added

- Version command to display the current installed version.

## [0.1.7] - 2026-05-01

No user-facing changes. Release scripts and packaging improvements.

## [0.1.6] - 2026-05-01

No user-facing changes. Switched to npm-publish GitHub Action for automated releases.

## [0.1.5] - 2026-05-01

No user-facing changes. Version bump.

## [0.1.4] - 2026-05-01

No user-facing changes. Version bump.

## [0.1.3] - 2026-05-01

Initial release.

### Added

- Collaborative real-time editing with multiple cursors and undo/redo history.
- Inline comment threads anchored to text selections with threaded replies, resolve, and reopen.
- Shared note access with configurable permissions (view, comment, edit) and name requirement for participants.
- Shared rendered HTML preview endpoint for non-editor access.
- Pandoc PDF export with configurable settings and WeasyPrint support.
- Browser-based PDF rendering with live preview synced to the editor.
- Persistent PDF export management.
- Note import and export as ZIP archives.
- CLI image upload command for embedding images into notes.
- Uploaded asset proxy middleware for Vite development.
- Note image assets and typed collaborative editor.
- Agent setup and anchored comment interactions in the web UI.
- Scroll synchronization with scroll metrics between editor and preview.
- Preview mode persistence across page reloads.
- CLI thread ID retrieval from API responses.

### Changed

- Export and image modal layout redesigned for better usability.
- PDF export switched from Pandoc-only to browser-based rendering.

### Fixed

- Image uploads and dev routing stabilization.
- Editor now relies on native textarea edits for more reliable text changes.
- Preview scroll position stays in sync with the editor.
- Live preview aligned with exported PDF output.
- Comment composer behavior and dark theme defaults refined.
- Removed redundant export button and updated PDF export header.
- Hidden Pandoc image attributes in preview output.
