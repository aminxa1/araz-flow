# Changelog

## 2.1.0 — Build 005
- Fixed the remaining stale HTML build identifier that was still `002` inside Build 004.
- Synchronized HTML, app.js, asset query versions, Service Worker cache, diagnostics key, and version.json to Build 005.
- Kept automatic mixed-version cache repair enabled.
- No schema change; Schema 9 remains intact.

## 2.1.0 — Build 004
- Fixed stale HTML build meta that incorrectly remained on Build 002 in Build 003.
- Added automatic mixed-version recovery: clear Araz Flow caches, unregister service workers, and controlled reload.
- Added a one-time repair guard to avoid reload loops.
- Preserved all Build 003 product fixes and Schema 9.

## 2.1.0 — Build 003
- Show project context on Today/Tomorrow action cards.
- Keep planned action weight counted after completion or delegation.
- Simplify project action editor and fix Cancel button.
- Accept Persian/Arabic digits in numeric fields and support Enter.
- Added health checks for localized digits and retained capacity.

## 2.1.0 — Build 002
- Added weighted actions and per-day capacity limits.
- Added Tomorrow planning tab and day rollover.
- Compact People list with per-person detail view and assignment timestamps.
- Added live Persian date/time in the app header.
- Migrated state schema to 9.

## 2.1.0 — Build 001
- Added People tab and action delegation.

## 2.0.0 — Build 012
- Stable dual-storage baseline.
