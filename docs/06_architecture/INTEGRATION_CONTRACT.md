# Integration Contract

## Purpose

Define the external contracts that `screencast-recorder` uses in the Alfares
ecosystem. Capture remains host-local; ecosystem services provide control,
identity, storage, observability and later post-production integration.

## Capability decisions

| Capability | Component | Decision | Contract/API/event | Configuration | Failure mode | Validation evidence |
|---|---|---|---|---|---|---|
| Auth | `auth-microservice` | required | Human UI auth; sanctioned service identity for agent/API calls | Auth URL + application/service identity from Vault | UI/API returns controlled auth failure; capture already running continues | authenticated UI and agent heartbeat |
| PostgreSQL | `db-server-postgres` | required | Dedicated DB for agents/sessions/tracks | dedicated DSN from Vault | API becomes unavailable; agent continues local capture | DB connection + migrations + CRUD smoke test |
| Redis | `db-server-redis` | not-applicable | None in phase 1 | None | N/A | adoption profile records N/A |
| Logging | `logging-microservice` | required | Structured application/agent operational events | service URL from Vault/config | local logging fallback; recording must continue | log event visible in ecosystem logging |
| Notifications | `notifications-microservice` | not-applicable | None | None | N/A | adoption profile records N/A |
| AI | `ai-microservice` | not-applicable in phase 1 | Phase-2 edit/render contract only; session manifest is prepared for it | future integration | N/A in capture phase | phase-2 contract test |
| Payments | `payments-microservice` | not-applicable | None | None | N/A | adoption profile records N/A |
| Catalog | `catalog-microservice` | not-applicable | None | None | N/A | adoption profile records N/A |
| Orders | `orders-microservice` | not-applicable | None | None | N/A | adoption profile records N/A |
| Warehouse | `warehouse-microservice` | not-applicable | None | None | N/A | adoption profile records N/A |
| Invoices | `invoices-microservice` | not-applicable | None | None | N/A | adoption profile records N/A |
| Object storage | `minio-microservice` | required | S3-compatible object API; dedicated `screencast-sessions` bucket | endpoint/bucket/scoped credentials from Vault | upload retries; local media retained until verified | upload + HEAD/checksum verification |
| Monitoring | `monitoring-microservice` | required | health/metrics and recording-agent liveness | monitoring URL/config | alerting failure must not stop recording | `/health`, metrics and liveness |
| Docs-RAG | docs-RAG ecosystem | required | indexed service documentation | repository registration | documentation discovery unavailable; runtime capture unaffected | service is indexed and searchable |
| Event bus | RabbitMQ | required | `session.stored` and future lifecycle events | broker config/identity from Vault | event retry/outbox; stored media remains valid | event observed by consumer/test harness |
| runlayer | `runlayer` | not-applicable to live capture | No live capture commands routed through runlayer | None | N/A | architecture review |
| BPCP | business-process orchestrator | phase 2 | Future post-production approvals | future contract | N/A in phase 1 | phase-2 design review |

## MinIO contract

### Bucket

`screencast-sessions` is dedicated to this service. Existing buckets,
especially `speakasap-records`, are outside the service's authorization scope.

### Authentication

Runtime access uses a scoped service account, never MinIO root credentials.
Provisioning may use administrative credentials once.

### API

The implementation should use an S3-compatible SDK. Required operations are:

- PutObject/multipart upload as needed;
- HeadObject;
- ListBucket within the service prefix when needed;
- GetObject for review/verification;
- DeleteObject only under an explicit future retention operation.

### Object layout

```text
sessions/YYYY/MM/DD/<session-id>/
  manifest.json
  <agent>/<track>/seg-00000.<container>
  metadata/events.jsonl
```

### Verification

A Save operation is not successful until all expected objects are present and
the manifest can be read back. Upload retries must be idempotent.

## Future post-production contract

The stored manifest is the stable handoff into phase 2:

```text
session.stored
    → AI analysis
    → edit plan
    → render preview
    → human approval
    → YouTube publication
    → human-approved raw deletion
```

AI editing should consume metadata and media from MinIO rather than querying
the live capture agent.

## Security boundary

No integration is permitted to receive raw keyboard characters, clipboard
contents or secret values merely to improve editing.
