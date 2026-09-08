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

## Data ownership

| Entity / event | Owner | Notes |
|---|---|---|
| `agents`, `sessions`, `tracks` | screencast-recorder | Sole writer; no other service mutates capture state. |
| Local session media, pre-Save | the recording agent | Authoritative while a session is live, including during an API outage. |
| Objects under `sessions/…` in `screencast-sessions` | screencast-recorder | Written through the scoped service account; MinIO owns durability, not semantics. |
| `session.stored` | screencast-recorder | Published; consumed later by post-production. |
| Operator identity | `auth-microservice` | Never mirrored into this service's database. |
| Rendered videos, publication state | phase 2 | Not owned here. |

## Authentication and authorization

Two separate lanes, never conflated.

**Human.** Hosted Auth against application `screencast-recorder`, default role
`app:screencast-recorder:user`. Credentials only at `auth.alfares.cz`.

**Machine.** Follow only
[`SERVICE_IDENTITY_CONSUMER_STANDARD.md`](../../../auth-microservice/docs/SERVICE_IDENTITY_CONSUMER_STANDARD.md).
Local inventory: identity
`svc-screencast-agent--screencast-recorder@internal.alfares.cz`, role
`internal:screencast-recorder:agent` on every machine-accessible route. Host agent
reads credentials via Vault AppRole (non-pod delivery path).

Storage authorisation is a policy boundary: the runtime MinIO service account
can address `screencast-sessions` and nothing else.

## Synchronous dependencies

| Dependency | Purpose | Timeout / behavior on failure |
|---|---|---|
| `auth-microservice` | Validate operator sessions and agent service tokens | UI and API return a controlled auth failure; an in-flight recording is unaffected because the agent does not re-authenticate mid-capture |
| `db-server-postgres` | Session, agent and track state | API becomes unavailable; the agent keeps recording locally and reconciles on reconnect |
| `minio-microservice` (S3) | Upload and verification during Save | Save is retried; segments upload independently and a resumed upload skips completed objects; local media is retained |
| `logging-microservice` | Structured operational events | Falls back to local logging; never interrupts a recording |

## Asynchronous dependencies

Published: `session.stored`, once every object of a saved session is verified
present in S3. It carries the session id, the S3 prefix, the track inventory
and the timing manifest reference — enough for a phase-2 consumer to start work
without reading this service's database.

Consumed: none in phase 1.

Delivery is at-least-once, so consumers must be idempotent on session id. A
message carries no caller authority: a handler that needs a privileged action
makes its own authorised HTTP call under
[`SERVICE_IDENTITY_CONSUMER_STANDARD.md`](../../../auth-microservice/docs/SERVICE_IDENTITY_CONSUMER_STANDARD.md).

## Degraded operation

| Unavailable dependency | Behavior |
|---|---|
| API / controller | The agent continues recording. Local files are the source of truth; state reconciles on reconnect. This is why the agent long-polls rather than the API pushing. |
| PostgreSQL | The API is down, which reduces to the row above. |
| MinIO | Save fails and is retried. Nothing local is deleted. |
| Auth | New sessions cannot start; running captures continue. |
| Logging | Local logging only. |
| Event bus | `session.stored` is queued for retry; the session is still marked stored, because storage is verified by S3 readback, not by event delivery. |
| Vault sealed | The pod's ExternalSecret fails and the API does not start; the agent reports "controller unavailable" instead of recording into a void. |

## Validation

- Scoped storage credential: verified able to read and write
  `screencast-sessions`, and denied on `speakasap-records`, on every other
  bucket, and on all admin operations.
- Database role: verified non-superuser, owning every object in `screencast`,
  with `CONNECT` revoked from `PUBLIC`.
- Secret delivery: verified by enumerating the keys of the generated Kubernetes
  Secret, never by reading `Ready=True` alone.
- Service identity: verified by a successful authenticated agent call against a
  role-decorated route, plus a denied call from an undecorated one.
- Capture: verified by a real recording that demonstrates source discovery,
  synchronised start, independent tracks, activity metadata, graceful stop,
  Save and Discard, and verified MinIO storage.
