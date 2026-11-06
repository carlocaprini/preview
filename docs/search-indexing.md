# Search indexing boundary

Preview uses search metadata for its two public informational pages only:

- `https://preview.carlocaprini.com/`
- `https://preview.carlocaprini.com/about/`

Those URLs have route-specific titles, descriptions, canonical URLs, Open
Graph metadata, and the 1200×627 Preview social image. They are the only entries
in `sitemap.xml`.

The Privacy page remains public but `noindex` and outside the sitemap. Shared
bearer links, unavailable states, login/admin/owner previews, MCP/API routes,
PDF responses, assets, and every content-origin response retain `noindex` via
HTML metadata and/or `X-Robots-Tag`.

Both origins allow crawlers to request routes in `robots.txt`. This is
intentional: a crawler must be able to fetch a response before it can observe
its `noindex` directive. The sitemap remains the positive allowlist and contains
only the two informational URLs above.

Robots directives are not access control. Authentication, signed capabilities,
share-link validation, expiry, revocation, and origin isolation remain the
security boundary.

## Environment and release behavior

Only `ENVIRONMENT=production` makes the home and About pages indexable and
serves the two-URL sitemap. Staging and test environments return `noindex` for
both pages and do not serve a sitemap.

Deploying this change to production makes those two informational pages
eligible for indexing even while the source repository remains private. It does
not add a repository link or expose source code. The source link and repository
visibility remain separate, explicitly controlled release steps.

## Post-deploy verification

The following steps intentionally remain pending until the owning pull request
is merged and deployed:

1. Fetch `/`, `/about/`, `/privacy/`, `/robots.txt`, and `/sitemap.xml` from the
   application origin and verify the expected status, canonical, metadata, and
   indexing directives.
2. Verify an active share link, unavailable share, login/admin route, API route,
   PDF response, and content-origin response all remain noindex and absent from
   the sitemap. Use a synthetic private link and do not record its token.
3. Confirm whether the existing Google Search Console domain property covers
   `preview.carlocaprini.com`.
4. Submit `https://preview.carlocaprini.com/sitemap.xml` only after the deployed
   response passes the checks above.
5. Record coverage and submission evidence without account screenshots or
   secrets. Submission does not promise or imply immediate indexing.

**Current external status:** not submitted and not production-verified. These
are post-deploy steps owned by the final release gate; local implementation does
not claim completion of Search Console work.
