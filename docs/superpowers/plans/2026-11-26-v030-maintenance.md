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
- [ ] Push release commits/tag, deploy with rollback data, clean AI orphan indexes and purge requested trash, verify final counts/files/tasks/CDN and record release evidence.

## Review focus

Shared immutable keys and HLS segment membership remain protected; concurrent sync leases cannot recreate removed objects; retired/disabled storage deletion errors remain retryable; expired/exhausted links are not made valid by an enable toggle; SQL can initialize a fresh database and deployed migrations remain unchanged; no credentials appear in logs or release artifacts.

## Verified before release

- 697 regression and 64 plugin tests pass; API/Web/SDK builds and API/Web lint pass. Final logs: `.runtime/v030-final-test.log`, `v030-final-api-build.log`, `v030-final-lint.log`, `ui-final-web-build.log`. Production-build browser acceptance: 6/6.
- Isolated MariaDB validation: 7/7 including all 13 migrations, schema snapshot equivalence, original checksum baselines, repeated deploy and sentinel preservation.
- Production DB snapshot verified (8,872,163 bytes compressed); AI cleanup backed up 87,797 candidate rows and 428 actual objects (106,996,141 bytes), then removed only globally unreferenced candidates. 20 referenced replicas retained, no skipped candidates.
- Both current trash files backed up separately (527,722 bytes) before enabling automatic expiry purge. Two legacy fake-completed retry records corrected to FAILED with original detail preserved and TASK_UPDATE audit.
- Aliyun Drive 1.3.1 resumes verified missing sequential parts; formerly failed object READY, remote size 57,376,988, provider metadata/hash confirmation passes.
- Fresh review fixed failure starvation and restore/recycle deadline races (RED→GREEN). Additional baseline migration-copy race reproduced and fixed with a guarded replica lease (83/83 storage tests).

## Rulings

- Preserve applied migration history and offer a reproducible empty-database schema snapshot instead of deleting/squashing SQL. Rewriting applied migrations would break deployed checksums and existing installations.
- Retain unrelated pre-staged WebDAV plan and `.superpowers/` files. Delete only reference-proven project orphan objects, with metadata and physical backups.
- New retention automation also protects a renewed recycle deadline; manual purge remains an explicit delete. Round-robin progress resets safely after a complete sweep.
- Include the preexisting migration-copy lease gap in this release because automatic purge makes concurrent transfer/deletion safety material; verified by two failing then passing tests.
- Server writes remain inside the application root; external nginx configuration is unchanged.
