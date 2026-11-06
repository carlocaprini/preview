# Preview operations

## Required Cloudflare resources

- One Workers application (`preview`)
- One D1 database (`preview-site`)
- Two custom domains: `preview.carlocaprini.com` and `content.preview.carlocaprini.com`
- Worker-native owner and MCP secrets; no Cloudflare Access subscription

For a new independent deployment, create the named resources before enabling
its deployment workflow. The names below describe Carlo's instance and must be
replaced by a fork:

```sh
npx cf d1 create --name preview-site
```

Record the returned D1 UUID as the protected `CLOUDFLARE_D1_DATABASE_ID` GitHub environment secret. The deployment workflow applies migrations to that exact database before the Worker is updated. `cf deploy` resolves the existing named bindings and may provision only a missing supported binding; it never makes Access or billing decisions.

## Secrets and configuration

Set these through Cloudflare secrets or the deployment environment; never commit them:

- `OWNER_PASSWORD` (at least 24 random bytes; store it in a password manager)
- `MCP_BEARER_TOKEN` (at least 32 URL-safe random characters)
- `SHARE_SIGNING_KEY` (at least 32 random bytes)
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Scope the deployment token to the intended account, database, and zone:

- Workers product `Admin` for the first deploy if the `preview` Worker does not exist yet; after creation, `Editor` is sufficient for ordinary deploys.
- D1 `Editor` for `preview-site`, because the workflow applies migrations directly.
- Zone `Workers Routes: Write` for `carlocaprini.com` while connecting or changing the two custom domains.

The CI token does not need Access, billing, or subscription permissions. Production deployment must fail when any required binding, secret, migration, or domain is missing.

Migration `0006_pdf_companion.sql` adds optional companion metadata, 512 KiB PDF chunks, guarded upload sessions, and additive aggregate columns. Apply it after the latest-only retention migration and before deploying code that exposes PDF routes. The migration preserves existing HTML aggregates with zero PDF deliveries.

Configure these protected `production` GitHub environment secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_D1_DATABASE_ID`
- `OWNER_PASSWORD`
- `MCP_BEARER_TOKEN`
- `SHARE_SIGNING_KEY`

The final workflow runs only after a push to `main`; pull-request workflows never receive production secrets and never deploy.

## Authentication boundary

No Cloudflare Access or Zero Trust organization is required. `/login` accepts only `OWNER_PASSWORD`; a successful login returns a 12-hour, host-only `Secure`, `HttpOnly`, `SameSite=Strict` cookie signed with domain separation from `SHARE_SIGNING_KEY`. Changing either secret invalidates existing sessions. Owner mutations also require an exact `Origin` match, preventing uploaded content from using the owner session for cross-site requests.

`/mcp`, `/api/admin/uploads/*`, and the narrow `/api/mcp/*` content/PDF transfer routes accept `Authorization: Bearer <MCP_BEARER_TOKEN>`. The machine routes can only download the current declared asset or transfer a previously staged PDF upload; they do not grant access to arbitrary `/api/admin/*` operations. Owner-preview assets use an expiring signed capability URL, so the owner cookie is never shared with `content.preview.carlocaprini.com`.

Local transfer commands default to `https://preview.carlocaprini.com` as the only origin allowed to receive `PREVIEW_MCP_TOKEN`. Set `PREVIEW_MCP_ORIGIN` to another explicit HTTPS origin only for a controlled staging environment. Transfer-plan URLs and IDs are validated before the helper sends the credential.

Keep public `/`, `/assets/viewer.js`, `/api/public/measure`, application-origin
`/s/*`, and content-origin `/s/*` unauthenticated. Before any new deployment,
verify anonymous rejection, owner login/logout, session expiry, Bearer-token
rejection/acceptance, and content-origin isolation.

## Backup and restore

Export the complete D1 database on a regular schedule outside this repository. The export contains metadata and asset payload chunks and must be stored encrypted with retention appropriate to the content.

Restore D1, then verify that every active manifest has a matching payload row and the declared number of chunks before re-enabling share traffic. Perform restore drills against staging; never test a restore in production. Revoking a link removes access but does not erase the current payload. Superseded HTML payloads are automatically inaccessible and eligible for deletion after 24 hours; migration 0005 assigns that deadline to versions already superseded at rollout. A scheduled Worker event runs hourly and removes at most 20 superseded plus 20 abandoned staging versions per invocation. Monitor the oldest `purge_after` and expired `upload_session.expires_at` values to confirm eventual progress.

PDF replacements and removals detach bytes immediately from every public link. An hourly scheduled cleanup expires abandoned PDF uploads and deletes at most 20 unreferenced companions older than 24 hours per invocation. Monitor expired `pdf_upload_session` rows and unreferenced `pdf_companion` rows to confirm the cleanup backlog continues to fall.

## Release and rollback

Pull requests execute `npm run check` and the responsive Playwright suite without Cloudflare credentials. Each independently reviewable change is merged through its own issue and pull request. The push-to-`main` workflow validates secrets, repeats all gates, verifies the API token, applies D1 migrations, deploys, and probes the public, authentication, cache, and origin-isolation boundaries.

Worker versions remain available in Cloudflare for code rollback. Database migrations in V1 are additive; do not roll D1 backward destructively. When rollback is required, redeploy the prior Worker version while leaving the additive schema in place, then investigate from redacted Worker logs.

Operational logs must never contain share URLs, query strings, bearer tokens, uploaded filenames, owner email addresses, IP addresses, or request bodies. Automatic invocation logs are disabled because bearer tokens live in URL paths. Application logs emit only method, a redacted route family, event name, and safe error category.

## Cost guardrails

An optional companion PDF is capped at 10 MiB and consumes the same D1 database capacity. Uploads validate the declared and actual length plus the `%PDF-` signature; this is format validation, not malware scanning. Stale unreferenced companions receive a 24-hour grace period before opportunistic cleanup so an in-progress download is not broken. Monitor D1 size after enabling companions and reduce the cap if live staging evidence shows unacceptable latency, query, CPU, or storage pressure.

### Unverified remote-platform gate

The automated suite proves lifecycle, concurrency, authorization, chunk
integrity, partial-stream cancellation and query shape with the in-memory
SQLite D1 adapter. It does **not** prove the 10 MiB boundary against a remote
Cloudflare Worker and D1 database: live CPU time, D1 latency/query accounting,
database growth, and cancellation behavior near the cap remain unverified. The
feature is used with this explicit operational limitation; do not claim remote
near-cap validation until an isolated staging probe uploads, replaces, streams,
cancels, and cleans up a representative PDF without production data.

V1 caps a package at 20 MiB expanded, 10 MiB per file, and 50 files. ZIP expansion happens in the authenticated browser or local CLI, never in the Worker. The browser inspects declared ZIP sizes before expansion, and the server independently validates the resulting manifest. Each file is transferred through one authenticated request, bounded to its declared byte count, hashed, and stored as 512 KiB D1 chunks. The service rejects oversize manifests before writes and fails closed when D1 is unavailable.

Cloudflare quotas and billing prerequisites are account-wide and change over time. Asset payloads count toward D1 capacity, so monitor database usage and cleanup backlog before the database approaches its current account limit. Deleting payload rows makes SQLite pages reusable but may not immediately shrink the database's reported file size; verify both row counts and provider-reported usage. Verify the account's current Workers, D1, and custom-domain state immediately before deployment. No workflow enables a paid plan automatically, and V1 has no R2 or Cloudflare Access dependency.
