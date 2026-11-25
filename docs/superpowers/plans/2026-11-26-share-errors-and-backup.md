# Share errors and full backup repair

**Goal:** Show a complete, branded public share page for unavailable links and repair the actual production full-backup failure.

**Approach:** Reuse Vue, Element Plus and the existing public site settings. Keep file and directory shares consistent. Diagnose the production backup record before changing archive logic; preserve all user data and the verified CDN download path.

**Constraints:** No new UI dependencies. Preserve user-staged changes. Production writes remain inside `/www/wwwroot/unified-file-manager`; do not overwrite `.env` or the database, or change other services.

- [x] Reproduce invalid/expired share states with behavioral tests, then implement page loading, error/retry and site-name branding fallbacks for file/custom-path/directory shares.
- [x] Read the failed production backup metadata and relevant logs, reproduce its cause in a regression test, and implement the smallest reliable correction.
- [x] Run regression/plugin tests, API/web builds and desktop/mobile share-page checks; independently review the combined changes.
- [ ] Commit only this task, push GitHub, deploy API/web in the authorized application directory, and verify public pages plus an actual full backup and CDN downloads.

**Review focus:** 404 and expired links never remain in loading state; network errors allow retry; empty/invalid branding has a readable site name; password/download behavior remains intact; backups either produce verifiable complete archives or clearly report the exact failure without claiming success.
