# Preview V1 operations

## Required Cloudflare resources

- One Workers application (`preview`)
- One D1 database (`preview-site`)
- Two custom domains: `preview.carlocaprini.com` and `content.preview.carlocaprini.com`
- Cloudflare Access applications/policies for owner and MCP paths only

Do not protect the entire Worker with Access because public homepage and bearer-link readers must remain reachable.

For the first production release, create the named resources before merging the release stack:

```sh
npx cf d1 create --name preview-site
```

Record the returned D1 UUID as the protected `CLOUDFLARE_D1_DATABASE_ID` GitHub environment secret. The deployment workflow applies migrations to that exact database before the Worker is updated. `cf deploy` resolves the existing named bindings and may provision only a missing supported binding; it never makes Access or billing decisions.

## Secrets and configuration

Set these through Cloudflare secrets or the deployment environment; never commit them:

- `OWNER_EMAIL`
- `MCP_ACCESS_CLIENT_ID`
- `SHARE_SIGNING_KEY` (at least 32 random bytes)
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

The deployment token needs only Workers Scripts, D1, Access application/policy, and DNS/custom-domain permissions scoped to the intended account and zone. Production deployment must fail when any required binding, secret, migration, or domain is missing.

Configure these protected `production` GitHub environment secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_D1_DATABASE_ID`
- `OWNER_EMAIL`
- `MCP_ACCESS_CLIENT_ID`
- `SHARE_SIGNING_KEY`

The final workflow runs only after a push to `main`; pull-request workflows never receive production secrets and never deploy.

## Access policy shape

Create reusable default-deny policies and attach them to hostname/path self-hosted applications:

- Owner policy: allow only the configured owner identity for `preview.carlocaprini.com/admin*`, `preview.carlocaprini.com/api/admin/*`, and `content.preview.carlocaprini.com/preview/*`.
- MCP policy: allow only the dedicated service token for `/mcp` and the upload transfer routes it needs.

Keep public `/`, `/assets/viewer.js`, `/api/public/measure`, application-origin `/s/*`, and content-origin `/s/*` outside Access. The Worker still rejects unauthorized host/path combinations. The public fflate and admin scripts contain no credentials; their corresponding APIs remain independently owner-gated.

Before the first merge, verify the Access applications and policies in the Cloudflare dashboard with an anonymous browser, the configured owner account, and the MCP service token. The Worker check is defense in depth; it does not replace the edge policy.

## Backup and restore

Export the complete D1 database on a regular schedule outside this repository. The export contains metadata and asset payload chunks and must be stored encrypted with retention appropriate to the content.

Restore D1, then verify that every active manifest has a matching payload row and the declared number of chunks before re-enabling share traffic. Perform restore drills against staging; never test a restore in production. Revoking a link removes access but does not erase immutable version payloads, so content deletion and retention remain an explicit owner operation outside V1.

## Release and rollback

Pull requests execute `npm run check` and the responsive Playwright suite without Cloudflare credentials. The owner merges the complete stack once. The push-to-`main` workflow validates secrets, repeats all gates, verifies the API token, applies D1 migrations, deploys, and probes the public, Access, cache, and origin-isolation boundaries.

Worker versions remain available in Cloudflare for code rollback. Database migrations in V1 are additive; do not roll D1 backward destructively. When rollback is required, redeploy the prior Worker version while leaving the additive schema in place, then investigate from redacted Worker logs.

Operational logs must never contain share URLs, query strings, bearer tokens, uploaded filenames, owner email addresses, IP addresses, or request bodies. Automatic invocation logs are disabled because bearer tokens live in URL paths. Application logs emit only method, a redacted route family, event name, and safe error category.

## Cost guardrails

V1 caps a package at 20 MiB expanded, 10 MiB per file, and 50 files. ZIP expansion happens in the authenticated browser or local CLI, never in the Worker. The browser inspects declared ZIP sizes before expansion, and the server independently validates the resulting manifest. Each file is transferred through one authenticated request, bounded to its declared byte count, hashed, and stored as 512 KiB D1 chunks. The service rejects oversize manifests before writes and fails closed when D1 is unavailable.

Cloudflare quotas and billing prerequisites are account-wide and change over time. At the time of this implementation, D1 Free allows 500 MB per database and 5 GB per account; asset payloads count toward that capacity, so monitor database size and define a retention/deletion policy before it approaches the limit. Verify the account's current Workers, D1, Access, billing, and custom-domain state immediately before the first production deployment. No workflow enables a paid plan automatically, and V1 has no R2 dependency.
