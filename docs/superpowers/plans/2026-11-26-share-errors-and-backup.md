# Share errors and full backup repair

**Goal:** Show a complete, branded public share page for unavailable links and repair the actual production full-backup failure.

**Approach:** Reuse Vue, Element Plus and the existing public site settings. Keep file and directory shares consistent. Diagnose the production backup record before changing archive logic; preserve all user data and the verified CDN download path.

**Constraints:** No new UI dependencies. Preserve user-staged changes. Production writes remain inside `/www/wwwroot/unified-file-manager`; do not overwrite `.env` or the database, or change other services.

- [x] Reproduce invalid/expired share states with behavioral tests, then implement page loading, error/retry and site-name branding fallbacks for file/custom-path/directory shares.
- [x] Read the failed production backup metadata and relevant logs, reproduce its cause in a regression test, and implement the smallest reliable correction.
- [x] Run regression/plugin tests, API/web builds and desktop/mobile share-page checks; independently review the combined changes.
- [x] Commit only this task, push GitHub, deploy API/web in the authorized application directory, and verify public pages plus an actual full backup and CDN downloads.

**Review focus:** 404 and expired links never remain in loading state; network errors allow retry; empty/invalid branding has a readable site name; password/download behavior remains intact; backups either produce verifiable complete archives or clearly report the exact failure without claiming success.

## Deployment and verification — 2026-11-26

- Runtime deployed at `d945b4a847baff3df0ba0ae030ca58f95ddccc8f` on `feature/aliyun-drive-node`; both API and web are healthy with zero container restarts after replacement.
- Full suite: 644 regression tests and 56 plugin tests pass. The gateway regression reproduces the failure with the previous configuration and passes with the scoped backup location. The built nginx image and running service both pass `nginx -t`.
- Backup gateway read/send timeouts are 1,800 seconds for `/api/backups` and its child routes. Ordinary API requests remain at 300 seconds. The external host reverse proxy remains at its existing 600-second timeout; requests lasting longer than ten minutes can still time out at that layer. Host configuration outside the authorized application directory was not changed.
- Actual full backup `cmwwrnm8q001urg01dkn7c8oz` succeeded in 315 seconds: 27 tables, 40 LOCAL files, 145,952,261 compressed bytes, and cloud destination `VERIFIED` based on provider metadata, size and content hash. No warnings were returned. The backup includes all 88,181 replica rows.
- After API/web replacement, the retained archive remains available through the management API and matches SHA256 `12fb7d71f2a2f3b0b77191d4cada47a16bb6bd1dc0b2e734d2ad4d91d8f27b26`. Its gzip integrity also passes. The persistent archive directory is writable by the unprivileged runtime user.
- All six live public-share checks pass after deployment across desktop/mobile and file/folder/custom paths. The CDN entry still returns 302 from `files.shifuf.com` to `yp.shifuf.com`, where the downloaded sample matches its checksum. Range returns the correct 32 bytes with HTTP 206.
- Replica investigation establishes that most rows represent distinct historical synchronization object keys, with many no longer referenced by current files or versions. A historical WebDAV cleanup defect was corrected in `fef0980`, but the evidence does not attribute every historical orphan to that path. No bulk index or object deletion was performed.

Detailed local evidence: `.runtime/share-backup-final-verification.json`, `.runtime/share-backup-resume-tests.log`, `.runtime/share-backup-resume-remote.jsonl`, and `.runtime/share-backup-live-ui/results.json`. Rollback material and a verified database snapshot are retained under the application directory at `.deploy/share-backup-20261126-gateway/backup`.
