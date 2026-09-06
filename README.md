# screencast-recorder

[MISSING: one paragraph describing the service and the approved user or
ecosystem outcome it provides]

## Status

- Lifecycle: onboarding
- Production status: not deployed
- Owner: [MISSING: owner]

## Documentation authority

- Business intent: [`BUSINESS.md`](BUSINESS.md)
- System contract: [`SYSTEM.md`](SYSTEM.md)
- Agent instructions: [`AGENTS.md`](AGENTS.md)
- Current work: [`TASKS.md`](TASKS.md)
- Machine-readable state: [`STATE.json`](STATE.json)
- IPS adoption: [`ips-adoption.json`](ips-adoption.json)
- Integration decisions:
  [`docs/06_architecture/INTEGRATION_CONTRACT.md`](docs/06_architecture/INTEGRATION_CONTRACT.md)

Git is authoritative. docs-RAG is a derived discovery index.

## Capabilities

[MISSING: summarize externally visible capabilities without duplicating
`SYSTEM.md`]

## Interfaces

[MISSING: list public/internal APIs, events, jobs or state that users and
services interact with]

## Development

[MISSING: document the supported install, test, lint, build and run commands]

## Configuration

[MISSING: link configuration names and safe examples; never include secret
values]

## Deployment

Deployment uses `deploy.config.sh` and the shared runner:

```bash
../shared/scripts/deploy.sh screencast-recorder --dry-run
```

[MISSING: document service-specific deployment validation]

## Health and observability

[MISSING: document `/health`, probes, logging and monitoring behavior]
