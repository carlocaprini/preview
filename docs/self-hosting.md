# Self-hosting Preview on Cloudflare

This guide describes a minimal independent personal deployment using the
repository's existing Worker, D1 database, and GitHub Actions workflow. It is
not a one-click installer or a supported hosting product.

The instructions were verified against Node.js 22.18+, `cf@1.0.0-beta.18`, and
the repository revision that introduced this guide. The Cloudflare `cf` CLI is
beta: commands, configuration, and Build Output can change before its stable
release. Check the [official `cf` documentation](https://developers.cloudflare.com/cf/)
and each command's `--help` output before provisioning resources.

## Prerequisites

- A GitHub account able to fork the repository and configure Actions secrets.
- A Cloudflare account with an active zone you control.
- Two unused hostnames in that zone: one for the privileged application and
  one for untrusted uploaded content.
- Node.js 22.18 or newer and npm.
- Permission to create a Worker and D1 database and attach both hostnames.

The two hostnames are a security boundary, not a branding choice. Do not put
uploaded HTML on the application hostname.

## 1. Fork, clone, and install exactly

```sh
git clone https://github.com/YOUR-ACCOUNT/preview.git
cd preview
npm ci
```

Do not copy credentials, database IDs, account IDs, bearer links, or production
identifiers from Carlo's deployment. Repository-owned code is MIT licensed,
but an independent deployment must also replace Carlo Caprini's name, domains,
personal-site attribution, and public metadata and must not imply affiliation
or endorsement. See the [license](../LICENSE) and [third-party
notices](../THIRD_PARTY_NOTICES.md).

## 2. Replace instance-specific public configuration

Review every item before the first deployment:

| Area | Files | Replace |
| --- | --- | --- |
| Worker and D1 names, origins, domains | `cloudflare.config.ts` | Worker name, D1 name, application origin, content origin, and both custom domains |
| Deployment verification origins | `.github/workflows/deploy.yml` | `APP_ORIGIN` and `CONTENT_ORIGIN` |
| Personal-site attribution and UTM destination | `src/domain/site-links.ts` | Site origin and any public attribution intended for your deployment |
| Public page copy | `src/ui/pages.ts` | Owner name, contact context, and deployment-specific wording |
| Public live example | `examples/live-preview/index.html`, `src/ui/pages.ts` | Publish the example on your instance, then replace both values in `canonicalLiveExample` |
| Local MCP transfer default | `scripts/preview-transfer.mjs` | Default application origin, or always set `PREVIEW_MCP_ORIGIN` explicitly |
| Production probes | `scripts/verify-production.mjs` | Default application and content origins |
| Documentation and public metadata | `README.md`, `docs/`, repository About settings | Names, domains, contact context, screenshots, and social metadata |
| Deployment-specific assertions | `tests/site-links.test.ts`, `tests/browser/public.spec.ts`, `tests/preview-transfer.test.ts` | Expected personal-site and default-origin values |

Most other test domains such as `app.test`, `content.test`, and
`preview.example.com` are intentionally synthetic and should remain synthetic.
The owner session cookie name and internal protocol strings may keep the
`preview` product name if your fork still uses that name.

Preserve these production settings unless you have designed and reviewed a
different isolation model:

```ts
workersDev: false,
previewUrls: false,
```

### Publish an instance-local live example

The homepage and About page show **See Preview in action** only when the
configured example belongs to the current application origin. An unchanged fork
therefore omits Carlo's demo instead of sending visitors to Carlo's instance or
recording activity in its aggregates.

To enable the CTA for an independent deployment:

1. publish [`examples/live-preview/index.html`](../examples/live-preview/index.html)
   through the normal owner UI or the MCP `preview_create_content` plus transfer
   workflow described in [MCP publishing](mcp.md);
2. create one separately labelled, non-expiring link with
   `preview_create_share_link` after the HTML version is active;
3. in `src/ui/pages.ts`, replace **both** `canonicalLiveExample.appOrigin` with
   your exact application origin and `canonicalLiveExample.shareUrl` with that
   instance's active `/s/…` URL;
4. keep the source file in the repository and use `preview_upload_version` for
   later updates so the stable link and its aggregate history are preserved.

The application suppresses the CTA when the configured share URL is not on the
configured application origin. Do not reuse Carlo's public link, add a static
`/demo` bypass, seed a database record, or commit MCP credentials.

## 3. Verify locally before authenticating

```sh
npm run check
npm run test:e2e
npx cf deploy --dry-run
```

`cf deploy --dry-run` builds and validates the project without uploading a
Worker and does not require Cloudflare credentials. Treat any missing binding,
invalid domain, build failure, or failed test as a release blocker.

## 4. Create the D1 database

Authenticate interactively with `npx cf auth login`, or set a narrowly scoped
`CLOUDFLARE_API_TOKEN` for unattended use. `cf` maintains its own login and
does not reuse a Wrangler session.

Create the database with your chosen name:

```sh
npx cf d1 create --name YOUR_D1_DATABASE_NAME
```

Save the returned database UUID as `CLOUDFLARE_D1_DATABASE_ID`; never commit it.
Apply the repository migrations to that exact database ID:

```sh
npx cf d1 migrations apply "YOUR_D1_DATABASE_ID" --dir migrations
```

The migration command accepts a database ID, not a name or binding name.
Migration failure is not a partial success: do not deploy or route traffic until
all migrations have applied.

## 5. Create a least-privilege deployment token

Use a dedicated Cloudflare API token limited to the intended account, Worker,
D1 database, and zone wherever the current token UI supports that scope.

The pipeline needs:

- Workers product **Admin** only to create a Worker that does not yet exist;
  reduce it to **Editor** for ordinary deployments after creation.
- Account **D1 Edit** because the workflow applies migrations directly.
- Zone **Workers Routes Write** for the one zone while creating or changing the
  two Custom Domains. An unchanged existing Worker version does not need this
  zone permission merely to upload code.

Do not grant Access, billing, R2, account-wide DNS, or unrelated product
permissions. Cloudflare's permission names and role model can change; confirm
them against [Workers roles and permissions](https://developers.cloudflare.com/workers/authorization/workers/)
and [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/).

## 6. Configure GitHub Actions

Create a GitHub environment named `production` and verify which environment
features are actually effective for the fork's plan and visibility before
relying on them. On GitHub Free, environment secrets are available only to
public repositories. Required reviewers and wait timers are available only to
public repositories on GitHub Free, Pro, and Team; deployment branch/tag rules
are available to all public repositories and to private repositories on GitHub
Pro or Team. A private fork on GitHub Free therefore cannot reproduce this
repository's environment-secret boundary until it becomes public or the
account plan changes. Do not silently replace secrets with variables or weaken
deployment authorization; stop before enabling deployment if the effective
settings do not meet the intended boundary. See GitHub's [deployments and
environments documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).

Once the environment supports the required controls, add these six values as
**environment secrets**, not repository variables:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_D1_DATABASE_ID`
- `OWNER_PASSWORD`
- `MCP_BEARER_TOKEN`
- `SHARE_SIGNING_KEY`

Use independent high-entropy values for the three application secrets. Keep
them in a password manager. The workflow validates presence but never needs a
committed `.env` file.

Review `.github/workflows/deploy.yml` before enabling it. Pull-request CI uses
no production secret and never deploys. A push to `main` runs the production
job, so branch protection and environment approval rules are part of the
deployment authorization boundary.

## 7. Attach two Custom Domains and deploy

The typed `cloudflare.config.ts` declares both Custom Domains. They must belong
to the active zone and must not conflict with existing CNAME records. Cloudflare
creates the required DNS records and certificates when it attaches a Custom
Domain.

The first authorized push to `main` will:

1. validate all required environment values;
2. run dependency, unit, build, and browser checks;
3. verify the Cloudflare token;
4. apply D1 migrations by database ID;
5. upload the three Worker secrets with the new immutable version;
6. deploy the Worker and verify the configured production boundaries.

Do not enable `workers.dev` or preview URLs as a shortcut. A temporary hostname
that does not preserve the app/content split invalidates the security model.

## 8. First-deploy smoke checklist

Use only synthetic content and keep every resulting share URL private.

- The application hostname loads; the content hostname does not serve the
  privileged homepage or owner interface.
- An incorrect owner password fails; a correct password creates the expected
  secure owner session; logout invalidates it.
- A small synthetic HTML package uploads and becomes the current version.
- A share link opens the sandboxed content through the application shell.
- The content origin cannot call privileged application APIs with the owner
  session.
- Expiry and revocation make subsequent viewer and asset requests unavailable.
- A missing or incorrect MCP Bearer token is rejected; the correct token can
  list content without returning stored bytes or share URLs.
- Aggregate measurement excludes the authenticated owner and does not expose a
  reader identity.
- If testing PDF delivery, start with a small synthetic PDF. The remote
  near-10-MiB path remains an explicit unverified gate.

## Current Free-plan boundaries

These figures were checked on 6 November 2026 and are not a promise that the
deployment will remain free:

- Workers Free: 100,000 requests per day, 10 ms CPU time per HTTP request,
  128 MB memory, and 50 subrequests per invocation. Exceeding the daily request
  allowance can return Cloudflare error 1027; repeated CPU overruns can return
  error 1102.
- D1 Free: 10 databases, 500 MB per database, 5 GB total storage, 5 million
  rows read per day, and 100,000 rows written per day. Queries fail after the
  daily read/write allowance is exhausted until the midnight UTC reset. At the
  storage limit, writes and schema changes require cleanup or a plan change.

Preview stores uploaded asset chunks inside D1, so database capacity—not only
row counts—matters. Monitor usage and cleanup backlog. Consult the current
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/), and [D1
pricing](https://developers.cloudflare.com/d1/platform/pricing/) before every
deployment decision.

## Failure and recovery rules

- Missing secrets, bindings, domains, or migrations are failures; never route
  around them or present a partial deployment as healthy.
- D1 unavailability or exhausted limits must fail closed. A public link must
  not bypass authorization because storage is unavailable.
- Roll back Worker code with a prior Worker version. Migrations are additive;
  do not destructively roll D1 backward.
- Back up and restore the complete D1 database as one private boundary because
  it contains metadata and uploaded payload chunks.

See [operations](operations.md) for the deployed lifecycle, backup model, and
the full security and cost guardrails.
