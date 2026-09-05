# LetheBot Quick Start

The documentation index at [docs/README.md](docs/README.md) is the authoritative
map. The current evidence, remaining external gates, and repository sync status
are recorded in [docs/long-running-goal-state.md](docs/long-running-goal-state.md).

## Prerequisites

- Node.js 22.19 or newer
- pnpm 11.18.0

## Credential-Free Verification

```bash
pnpm install --frozen-lockfile
pnpm ci:check
```

This runs the deterministic type, lint, build, smoke, coverage, packaging, and
test gates. It does not contact a real Provider, QQ, or OneBot deployment.

## Local Runtime

Copy `.env.example` to `.env` only when starting a local runtime. The example
uses the Mock Pi provider by default; review the selected OneBot transport and
listener settings before starting it:

```bash
cp .env.example .env
pnpm dev:env
```

Use [Deployment](docs/deployment.md) for process-manager, Docker, transport,
database, and production configuration. Reverse HTTP ingress requires explicit
configuration and authentication; do not use an ad hoc curl payload as an
acceptance test.

## Controlled Acceptance

Real Provider or QQ traffic is opt-in and requires the controlled procedures in
[Local Container Acceptance](docs/local-container-acceptance.md) and the
[Provider E2E guide](tests/e2e/README.md). Deterministic tests and healthy
containers do not establish production readiness.

## Common Runbooks

- [Operations](docs/operations.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Test Strategy](docs/test-strategy.md)
- [Security and Privacy](docs/security-privacy.md)
