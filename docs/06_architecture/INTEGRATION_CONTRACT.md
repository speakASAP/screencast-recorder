# Integration Contract

## Purpose

[MISSING: explain how this project participates in the Alfares ecosystem]

## Capability decisions

The machine-readable decisions live in `ips-adoption.json`. This document adds
the human-readable architecture and contract links.

| Capability | Component | Decision | Contract/API/event | Configuration | Failure mode | Validation evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Auth | `auth-microservice` | [MISSING] | [MISSING] | [MISSING] | [MISSING] | [MISSING] |
| PostgreSQL | `db-server-postgres` | [MISSING] | [MISSING] | [MISSING] | [MISSING] | [MISSING] |
| Redis | `db-server-redis` | [MISSING] | [MISSING] | [MISSING] | [MISSING] | [MISSING] |
| Logging | `logging-microservice` | required | [MISSING] | [MISSING] | [MISSING] | [MISSING] |
| Notifications | `notifications-microservice` | [MISSING] | [MISSING] | [MISSING] | [MISSING] | [MISSING] |
| AI | `ai-microservice` | [MISSING] | [MISSING] | [MISSING] | [MISSING] | [MISSING] |
| Payments | `payments-microservice` | [MISSING] | [MISSING] | [MISSING] | [MISSING] | [MISSING] |
| Catalog | `catalog-microservice` | [MISSING] | [MISSING] | [MISSING] | [MISSING] | [MISSING] |
| Orders | `orders-microservice` | [MISSING] | [MISSING] | [MISSING] | [MISSING] | [MISSING] |
| Warehouse | `warehouse-microservice` | [MISSING] | [MISSING] | [MISSING] | [MISSING] | [MISSING] |
| Invoices | `invoices-microservice` | [MISSING] | [MISSING] | [MISSING] | [MISSING] | [MISSING] |
| Object storage | `minio-microservice` | [MISSING] | [MISSING] | [MISSING] | [MISSING] | [MISSING] |
| Events | RabbitMQ | [MISSING] | [MISSING] | [MISSING] | [MISSING] | [MISSING] |
| Documentation retrieval | `docs-rag-microservice` | required | Direct Git ingestion | Repository catalog | Git fallback | Retrieval source check |
| Monitoring | `monitoring-microservice` | required | `GET /health` and probes | K8s manifests | Readiness blocks rollout | Health evidence |
| Backups | `backups-microservice` | [MISSING] | [MISSING] | [MISSING] | [MISSING] | [MISSING] |

## Data ownership

[MISSING: identify the owner of every persistent entity and event]

## Authentication and authorization

[MISSING: identify user and service authentication boundaries]

## Synchronous dependencies

[MISSING: list required HTTP/database/storage dependencies and timeout behavior]

## Asynchronous dependencies

[MISSING: list published and consumed events, idempotency and replay behavior]

## Degraded operation

[MISSING: define behavior when each required dependency is unavailable]

## Validation

[MISSING: link contract, integration, replay and failure-mode evidence]
