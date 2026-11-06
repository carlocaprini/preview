# Contributing

Preview is a personal reference project rather than a community roadmap. Issues
and pull requests are welcome for consideration on a best-effort basis, but
they may be declined and there is no review, merge, compatibility, or support
guarantee.

## Start with an issue

Open or identify one issue before beginning a change. Keep the proposal small
enough to review independently and state the user-visible or operational
outcome, security/privacy implications, and validation plan.

Default to one issue and one pull request for each independently reviewable
change. Use stacked pull requests only for a genuine dependency chain. State
the graph, base branch, and intended merge order before opening a stack; keep
every PR independently reviewable and current as predecessors merge. Do not
create cumulative or umbrella PRs that make other open PRs obsolete.

## Branch and pull request

- Branch from current `main` unless an approved dependency requires another
  branch as the temporary base.
- Keep unrelated formatting, refactors, dependency updates, and generated
  output out of the change.
- Link the owning issue and describe exactly what the PR does and does not do.
- Document migrations, compatibility effects, failure behavior, and rollback
  when applicable.
- The maintainer retains final review, merge, release, and deployment authority.

## Required verification

Install from the lockfile and run:

```sh
npm ci
npm run check
npm run test:e2e
```

For Cloudflare configuration or deployment-documentation changes, also run:

```sh
npx cf deploy --dry-run
```

Add or update focused tests for behavior changes. Document any check that could
not be run and why; do not describe an unrun check as passing.

## Data and secret safety

- Never commit `.env` files, credentials, tokens, cookies, database/account
  IDs, production artifacts, or live bearer URLs.
- Never use customer content, titles, labels, analytics, screenshots, or logs
  as fixtures or PR evidence.
- Use synthetic examples and reserved domains such as `example.com` or `.test`.
- Redact sensitive values from terminal output and screenshots before posting.
- Report vulnerabilities through the private process in
  [`SECURITY.md`](SECURITY.md), not a public issue or pull request.

## Documentation and design boundaries

Update documentation and tests whenever behavior or configuration changes.
Preserve the two-origin content-isolation model, privacy-minimizing aggregate
semantics, latest-only retention model, and fail-closed authorization unless an
approved issue explicitly changes a boundary.

Repository-owned work is MIT licensed. Contributions are submitted under the
same terms. Independent deployments must replace Carlo Caprini's names,
domains, credentials, production identifiers, and personal-site attribution
and must not imply affiliation or endorsement; see [`LICENSE`](LICENSE) and
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
