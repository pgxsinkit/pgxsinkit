# 0004 — Registry-driven data-subject export (GDPR Art. 15/20)

Status: candidate
Opened: 2026-07-10 · Area: server / contracts
Reopen trigger: a consuming application needs to answer a "give me all my personal data"
request, or any compliance requirement lands that demands a data-subject export.

## The item

A "give me all my personal data" (GDPR Art. 15 access / Art. 20 portability) export. Considered
during the client-side PGlite export design (2026-07-10) and deliberately kept out of it.

Why the client-side export is the wrong artefact for this:

1. **Too small**: the local store is a per-device read cache — only what this device's shapes have
   synced, post row-filter, post per-client projection (ADR-0025 may redact/transform columns).
   The controller's obligation covers the authoritative server data, including rows that never
   synced to any device.
2. **Too big**: the synced tables hold everything the user _can see_ — including other users'
   personal data (e.g. others' discussion posts). "All data visible to me" ≠ "my personal data";
   shipping raw synced tables as a GDPR response would itself be a disclosure problem.
3. **Wrong authority**: a legal obligation cannot be served from a cache the device may never have
   synced or may have already wiped.

## The shape when picked up

A **server-side** capability against the authoritative Postgres, keyed by **data subject** (not by
visibility). The genuine pgxsinkit hook: the registry (`packages/contracts`) is already the shared,
machine-readable enumeration of every synced table — a data-subject exporter could hang off registry
annotations (e.g. per-column "personal data, owned by the row's subject" markers) so applications
declare PII once, next to the schema they already declare. Output format would be Art. 20's
"structured, commonly used, machine-readable" (JSON/CSV), not a pg_dump artefact.
