# Contributing to `novatip-backend`

Thanks for your interest. The full contribution guide for every Novatip
repository lives in one place:

**[Novatip contributing guide](https://novatip-docs.pages.dev/contributing)**
([source](https://github.com/Novatip/novatip-docs/blob/main/CONTRIBUTING.md))

Read that first. This page only covers what is specific to this repository.

## Quick start

```bash
git clone https://github.com/YOUR_USERNAME/novatip-backend
cd novatip-backend
git remote add upstream https://github.com/Novatip/novatip-backend
git checkout -b fix/short-description
```

This package resolves `@novatip/sdk` from a sibling checkout, so clone and
build it alongside this repo:

```bash
git clone https://github.com/Novatip/novatip-sdk ../novatip-sdk
(cd ../novatip-sdk && npm ci && npm run build)
npm install
npx prisma generate
```

PostgreSQL and Redis are needed to run the service (not to run the checks).
See the README for the local setup.

## Before you push

CI runs exactly these, so run them locally first:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

### Integration tests

The analytics Postgres integration suite (`npm run test:integration`) runs
against a live database and is skipped locally when `DATABASE_URL` is unset.
CI runs it against a Postgres 16 service after applying migrations. The suite
exercises the raw SQL queries in the analytics service, including type casts,
`date_trunc`, and large i128 amounts.

## Dependency updates

Dependabot opens pull requests for npm packages, GitHub Actions, and the Docker
base image on a weekly schedule. Minor and patch npm updates are grouped
together to reduce noise.

CI runs `npm audit --omit=dev --audit-level=high` to catch known
vulnerabilities in runtime dependencies. Development dependencies are excluded
because they do not ship to production. Findings that cannot be fixed
immediately should be documented in the PR with either a mitigation plan or a
justification for accepting the risk.

## Issue and pull request templates

Use the provided templates when opening issues or pull requests:

- **Bug reports** include Summary, Steps to reproduce, Expected vs Actual
  behavior sections
- **Feature requests** include Summary, Problem/motivation, and Acceptance
  criteria sections
- **Pull requests** should reference the issue they close (`Closes #123`) and
  include the checklist of commands CI runs

Do not report security issues as public issues or pull requests. See
[SECURITY.md](https://github.com/Novatip/novatip-docs/blob/main/SECURITY.md).

Review routing is handled by the `CODEOWNERS` file.

## Opening a pull request

- One issue per pull request, opened against `main`
- Reference the issue so it closes on merge: `Closes #123`
- Use [conventional commits](https://novatip-docs.pages.dev/contributing):
  `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`

## Reporting security issues

Do not open a public issue. See
[SECURITY.md](https://github.com/Novatip/novatip-docs/blob/main/SECURITY.md).
