# Repository Agent Instructions: screencast-recorder

## Required reading

Read in this order before planning or implementation:

1. `BUSINESS.md`
2. `SYSTEM.md`
3. `README.md`
4. `TASKS.md`
5. `STATE.json`
6. `ips-adoption.json`
7. `docs/00_constitution/CONSTITUTION.md`
8. `docs/01_vision/VISION.md`
9. `docs/06_architecture/INTEGRATION_CONTRACT.md`
10. active task, goal-impact record, execution plan and validation plan.

## Authority

Git files in this repository are authoritative for project intent and behavior.
Ecosystem authority is defined in the shared documentation authority. The
`register-new-app` onboarding skill is a required gate for new application
onboarding. Do not bypass it.

## Intent preservation system

Preserve:

```text
Vision → Goal Impact → System → Feature → Task → Execution Plan → Code → Validation
```

Do not implement while required intent, integration, invariant or validation
information is unresolved.

## Project-specific rules

1. Phase 1 is Ubuntu-only.
2. Desktop capture runs in a host-bound user agent, not in Kubernetes.
3. The API/UI is the control plane, not the video data path.
4. Displays, cameras, microphones and encoders are discovered at runtime.
5. Each display/webcam/audio source remains an independent track.
6. Start uses NTP/chrony readiness plus a future common `T0`.
7. Do not implement a traditional keylogger. Persist activity metadata only;
   never raw key characters or clipboard contents.
8. Local media is authoritative until MinIO upload and verification succeed.
9. Runtime MinIO access is least-privilege and bucket-scoped.
10. AI, YouTube and raw-footage deletion remain phase-2 concerns.
11. Do not introduce runlayer/BPCP/Temporal into the live capture loop merely to
    orchestrate a local recording process.
12. Never print or commit secrets or raw production media.

## Deployment

Use the shared deployment runner and ecosystem deploy lock. The host agent is
installed separately as a systemd user service and is not a Kubernetes
workload.

## Required final report

Report files changed, validation evidence, validation debt, blockers, deviations
and the next concrete action.

## Safety and operations

- This machine **is** `alfares`. Never `ssh alfares` or `ssh speakasap` from an
  agent session; run `vault`, `kubectl` and `rtk` locally.
- Vault is plain HTTP here: `export VAULT_ADDR=http://127.0.0.1:8200`.
- On the host, `mc` is GNU Midnight Commander, not the MinIO client. The real
  client exists only at `/usr/bin/mc` inside the MinIO pod. Never pipe storage
  operations through host `mc`.
- Never touch `/srv/speakasap-records/speakasap-records/`; it holds roughly
  618 GB of live lesson audio belonging to another service. Never
  `mount --bind` anything over `/srv/speakasap-records`.
- Runtime storage access uses the scoped, non-root MinIO service account.
  MinIO root credentials are used only for one-time provisioning.
- Never print, log, commit or paste a secret value. Key names only.
- Recording sessions can be hours long and are not reproducible. Never delete
  local session media. Deletion happens on exactly two paths, both owner-driven:
  the operator previews a session, judges it unusable and explicitly asks for it
  to be deleted; or the session is published and a real YouTube link exists, at
  which point the sources are replaced by that link and the final video.
  Previewing a session is not itself permission to delete it.
- Auto-deploy is ENABLED for this repository: the deny-list entry was removed
  once the service had application code and a `deploy.config.sh`. The
  post-commit hook was missing until 2026-09-08 and was restored with
  `shared/scripts/deploy-queue/install.sh --hooks`; if commits stop reaching
  the queue, check for `.git/hooks/post-commit` before anything else. A commit
  that fails deploy preflight leaves the shared worker unit FAILED and blocks
  the queue for every other service; recover with
  `systemctl --user reset-failed statex-deploy-queue.service`.
- Service-to-service authentication follows
  `auth-microservice/docs/SERVICE_IDENTITY_CONSUMER_STANDARD.md` without
  exception. If an integration cannot meet it, repair the integration.
