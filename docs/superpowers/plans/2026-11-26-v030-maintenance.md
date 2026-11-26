# v0.3.0 storage and management repair

**Goal:** Complete the user's 2026-11-26 maintenance list, verify it end to end, and publish to GitHub and the existing application server.

**Architecture:** Keep Vue/Element Plus, NestJS/Prisma and the existing storage adapters. Use the same immutable-key deletion and verified cloud-priority read paths across manual purge, retries and retention. Preserve applied migrations; provide a reproducible consolidated installation SQL rather than rewriting migration history.

**Execution:** User explicitly requested implementation, cleanup, testing and deployment in this session. Use reasonable professional defaults, v0.3.0, and independent parallel tasks with disjoint files. Do not stop for a repeated design or publishing approval.

## Constraints

- Preserve existing staged WebDAV plan changes, .env, database and file backups.
- Production application writes stay under `/www/wwwroot/unified-file-manager`.
- Back up database and metadata before destructive maintenance; delete only AI站点数据 replicas proven unreferenced by current heads, versions, derivatives and HLS manifests. Never bulk-delete based solely on a failed/disabled state.
- Disabling storage prevents new transfers/reads, not authorized deletion with its existing credentials. Failed physical deletion must retain durable metadata and report failure.
- No success state until the requested side effect has actually succeeded; unsupported historical retries must be rejected clearly.

## Work

- [x] Inspect live replica/task/trash state; snapshot and construct bounded cleanup candidates and reference guards.
- [x] Repair real delete retries with persistent file IDs and worker leases; exercise partial failure and retry tests.
- [x] Restore retention-day expiry scanning and schedule; support deletion from disabled adapters without enabling them.
- [x] Add share enable/pause/permanent delete; align displayed storage route with eligible verified cloud priority and LOCAL fallback.
- [x] Diagnose and repair the one required cloud object failure with verified bytes, or retain an explicit missing-source failure if no copy exists.
- [x] Refresh SVG branding, add responsive global footer, and browser-test management/public surfaces.
- [x] Consolidate distributable SQL without altering applied migrations; remove demonstrably obsolete artifacts and unify version/changelog.
- [x] Run regression/plugin suites, lint/build and focused browser/live API checks; review combined changes.
- [x] Push release commits/tag, deploy with rollback data, clean AI orphan indexes and purge requested trash, verify final counts/files/tasks/CDN and record release evidence.

## Review focus

Shared immutable keys and HLS segment membership remain protected; concurrent sync leases cannot recreate removed objects; retired/disabled storage deletion errors remain retryable; expired/exhausted links are not made valid by an enable toggle; SQL can initialize a fresh database and deployed migrations remain unchanged; no credentials appear in logs or release artifacts.

## Verified before release

- 697 regression and 64 plugin tests pass; API/Web/SDK builds and API/Web lint pass. Final logs: `.runtime/v030-final-test.log`, `v030-final-api-build.log`, `v030-final-lint.log`, `ui-final-web-build.log`. Production-build browser acceptance: 6/6.
- Isolated MariaDB validation: 7/7 including all 13 migrations, schema snapshot equivalence, original checksum baselines, repeated deploy and sentinel preservation.
- Production DB snapshot verified (8,872,163 bytes compressed); AI cleanup backed up 87,797 candidate rows and 428 actual objects (106,996,141 bytes), then removed only globally unreferenced candidates. 20 referenced replicas retained, no skipped candidates.
- Both current trash files backed up separately (527,722 bytes) before enabling automatic expiry purge. Two legacy fake-completed retry records corrected to FAILED with original detail preserved and TASK_UPDATE audit.
- Aliyun Drive 1.3.1 resumes verified missing sequential parts; formerly failed object READY, remote size 57,376,988, provider metadata/hash confirmation passes.
- Fresh review fixed failure starvation and restore/recycle deadline races (RED→GREEN). Additional baseline migration-copy race reproduced and fixed with a guarded replica lease (83/83 storage tests).

## Production release completed

- Published application commit `c67e777351edee410ff8043f401ad5bbd54f0a3a` to GitHub main and feature branch, annotated tag `v0.3.0`, and the formal GitHub release. Main validation and tag validation/API/Web image publishing all succeeded.
- Deployed that exact release under `/www/wwwroot/unified-file-manager`; API and Web are healthy. Verified all 1,002 packaged source/build files against SHA-256, retained the existing environment, and verified both database archives. Removed 135 obsolete generated Web assets only after archiving and checking their bytes.
- Fresh local verification: 697/697 regression, 64/64 plugin, lint and full API/Web/SDK build, 6/6 local browser acceptance, and 7/7 isolated database distribution checks. Live public desktop/mobile coverage passed 10/10 pages without overflow or script errors.
- Live functional acceptance passed 12 checks: real upload and cloud synchronization, matching share-list/download routes through UPYUN → R2 → LOCAL, share pause/enable/permanent deletion, rejection of non-executable legacy retries, an actual FAILED retry preserving an active file, and a subsequent COMPLETED retry deleting local plus both disabled cloud objects. Acceptance project/configuration fixtures were removed.
- Automatic retention removed the two backed-up trash files (`scanned=2 purged=2 failed=0`); local and cloud absence was verified. Final recycle count is zero. AI project retains 11 file records and 20 referenced replicas, with zero orphan indexes.
- The originally failed required Aliyun Drive object is READY and passes remote backup verification at 57,376,988 bytes with plugin 1.3.1. Five unrelated preexisting MISSING keys refer only to an already-DELETED record or no file/version/derivative; no active/recycled file is affected and no successful restoration was fabricated.
- Preserved 16 older migration-history records and 2 rolled-back attempts. All 13 shipped successful migrations retain equivalent original SQL content; historical LF/CRLF checksum differences were identified without modifying stored checksums or migration history.

Detailed verification and backup locations: `docs/releases/v0.3.0-verification.md`.

## Rulings

- Preserve applied migration history and offer a reproducible empty-database schema snapshot instead of deleting/squashing SQL. Rewriting applied migrations would break deployed checksums and existing installations.
- Retain unrelated pre-staged WebDAV plan and `.superpowers/` files. Delete only reference-proven project orphan objects, with metadata and physical backups.
- New retention automation also protects a renewed recycle deadline; manual purge remains an explicit delete. Round-robin progress resets safely after a complete sweep.
- Include the preexisting migration-copy lease gap in this release because automatic purge makes concurrent transfer/deletion safety material; verified by two failing then passing tests.
- Server writes remain inside the application root; external nginx configuration is unchanged.
