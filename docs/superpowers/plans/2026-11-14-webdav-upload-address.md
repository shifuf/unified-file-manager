# WebDAV Upload and Address Implementation Plan

User approved docs/superpowers/specs/2026-11-14-webdav-upload-address-design.md and continuous v0.2.2 publication. Work in the existing checkout, preserve files/configuration and the published v0.2.1 tag.

- [x] Reproduce PUT synthetic principal foreign-key failure in behavioral service and verb tests; set uploadedById=null while retaining event/quota actor.
- [ ] Add failing address policy, settings, project, middleware, PROPFIND and COPY/MOVE isolation tests.
- [ ] Add unique nullable Project.webdavSlug and enabled-project randomized backfill migration. Shared policy handles validation, random cryptographic generation, preservation/clear, collision including recycled projects and IDs.
- [ ] Update settings and atomic project create/update contracts; map slug uniqueness races to409. Middleware resolves alias or legacy project ID and uses actual project for authorization/data, request mount for href and Destination.
- [ ] Add address input and truthful preview to Projects.vue, protect late settings reads on dialog/project switches. Keep credentials unchanged.
- [ ] Generate Prisma, deploy local migration; run all regression/lint/build and real local DAV create/write/read/overwrite/range/copy/move tests, retain fixtures.
- [ ] Bump root/API/Web/SDK+lock to0.2.2, changelog/README, commit and push main+v0.2.2. Wait for GitHub validation/publication.
- [ ] Package exact commit; new consistent server backup, rebuild api/web only using full current overlay; update runtime/env version. Verify real user's DAV project plus custom/random numeric/alphabetic mounts, original ID compatibility, byte hashes and unchanged existing files. Clean user sub directory only if empty, preserve new acceptance data.
- [ ] Record report/evidence; verify final source/health/version/Git remote and close credential-bearing sessions.
