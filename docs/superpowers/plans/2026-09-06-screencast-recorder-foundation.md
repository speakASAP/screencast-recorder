# Screencast Recorder — Foundation & Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the `screencast-recorder` repository harness and provision every production dependency — Postgres database, scoped MinIO bucket and non-root credential, Vault path, Auth identities, AppRole — so that API and agent implementation can begin against real infrastructure.

**Architecture:** This plan writes almost no application code. It runs the canonical `register-new-app` onboarding harness, then provisions the four external dependencies the service needs. Each provisioning task ends with a verification command that proves the dependency is reachable with its scoped identity — not that a command exited zero.

**Tech Stack:** `scaffold-new-service.py` (harness), Vault 1.15.6 CLI + AppRole, MinIO `mc` (inside the pod), `provision-service-token.js` (inside the auth pod), PostgreSQL on db-server, Kubernetes (k3s) namespace `statex-apps`.

**Spec:** `docs/superpowers/specs/2026-09-06-screencast-recorder-design.md`

## Global Constraints

- Service name and repository: `screencast-recorder`. Port **3391**. Domain **`screencast.alfares.cz`**. Namespace **`statex-apps`**.
- Port 3391 was verified free against both live Kubernetes Services and `ECOSYSTEM_MAP.md`; **3380–3389 is the reserved `ai` block** and must not be used.
- `export VAULT_ADDR=http://127.0.0.1:8200` — Vault here is plain HTTP. Without it the CLI fails with `http: server gave HTTP response to HTTPS client`.
- **Never SSH.** This machine is `alfares`; run everything locally.
- **Secret values never appear** in Git, documentation, terminal output, logs, or commit messages. Key *names* only.
- **Never touch `/srv/speakasap-records/speakasap-records/`** — ~618 GB of live lesson audio. Never `mount --bind` over `/srv/speakasap-records`.
- On the host, `mc` is **Midnight Commander, not the MinIO client**. The real `mc` exists only at `/usr/bin/mc` inside the MinIO pod. Never invoke host `mc` for storage work.
- Service identity follows only
  `auth-microservice/docs/SERVICE_IDENTITY_CONSUMER_STANDARD.md`. Local pair for
  this service: `svc-screencast-agent--screencast-recorder@internal.alfares.cz`,
  role `internal:screencast-recorder:agent`. Do not document exceptions.
- Every Vault key must have an explicit `data:` entry in `k8s/external-secret.yaml`. A Vault key absent from the ExternalSecret never reaches the pod **while ESO still reports `Synced`**.
- Commits to `main` auto-deploy via the systemd deploy worker. Do not commit application code to `main` until Task 8.

---

### Task 1: Scaffold the repository harness

**Files:**
- Create: entire `screencast-recorder/` harness (generated)
- Preserve: `screencast-recorder/docs/superpowers/specs/2026-09-06-screencast-recorder-design.md`, `screencast-recorder/docs/superpowers/plans/` (both already exist — the scaffolder never overwrites existing files)

**Interfaces:**
- Consumes: nothing
- Produces: a Git repository at `/home/ssf/Documents/Github/screencast-recorder` containing `ips-adoption.json`, `README.md`, `BUSINESS.md`, `SYSTEM.md`, `AGENTS.md`, `CLAUDE.md`, `AGENT_OPERATIONS.md`, `TASKS.md`, `STATE.json`, `docs/00_constitution/CONSTITUTION.md`, `k8s/`, `deploy.config.sh`, `.gitignore`, `.env.example`

- [ ] **Step 1: Confirm the working tree is not yet a repository**

```bash
cd /home/ssf/Documents/Github/screencast-recorder && git rev-parse --is-inside-work-tree
```

Expected: `fatal: not a git repository`. If it IS already a repository, stop and report — the scaffolder's `--no-git-init` behaviour must then be considered instead of assuming a clean slate.

- [ ] **Step 2: Dry-read the scaffolder's options**

```bash
python3 scripts/scaffold-new-service.py --help
```

Expected: usage listing `--port`, `--domain`, `--with-secrets`, `--register-catalog`. Confirms the flags used below exist in this version.

- [ ] **Step 3: Run the harness with the verified port, domain and secrets**

```bash
cd /home/ssf/Documents/Github/shared && python3 scripts/scaffold-new-service.py screencast-recorder \
  --repository https://github.com/speakASAP/screencast-recorder \
  --port 3391 \
  --domain screencast.alfares.cz \
  --with-secrets
```

`--register-catalog` is deliberately omitted here; catalog registration happens in Task 8 after the GitHub remote exists.

- [ ] **Step 4: Verify the harness and that the spec survived**

```bash
cd /home/ssf/Documents/Github/screencast-recorder && ls ips-adoption.json SYSTEM.md k8s/external-secret.yaml deploy.config.sh && test -f docs/superpowers/specs/2026-09-06-screencast-recorder-design.md && echo SPEC_INTACT
```

Expected: all files listed, then `SPEC_INTACT`.

- [ ] **Step 5: Commit**

```bash
cd /home/ssf/Documents/Github/screencast-recorder
git add -A
git commit -m "chore: scaffold screencast-recorder harness on port 3391"
```

---

### Task 2: Provision the PostgreSQL database and least-privilege role

**Files:**
- Modify: none in this repo yet (the DSN lands in Vault in Task 5)

**Interfaces:**
- Consumes: nothing
- Produces: database `screencast_recorder`, role `screencast_recorder_app`, and a DSN of the form `postgresql://screencast_recorder_app:<password>@db-server-postgres:5432/screencast_recorder`

- [ ] **Step 1: Read the per-app role convention before creating anything**

```bash
ls /home/ssf/Documents/Github/shared/scripts/db-roles/
```

Read the scripts there and follow the established convention. Do **not** invent a new role-naming scheme — a service-prefixed DSN trap is a known hazard in this ecosystem.

- [ ] **Step 2: Confirm the database does not already exist**

Use the postgres MCP tool `postgres_list_databases`.
Expected: no `screencast_recorder` entry. If it exists, stop and report rather than dropping anything.

- [ ] **Step 3: Create the database and least-privilege role**

Follow the convention found in Step 1. The role owns only the `screencast_recorder` database, has no superuser attribute, and no access to other services' databases. Generate the password with `openssl rand -base64 32` and **do not echo it** — pipe it directly into the Vault write in Task 5, or store it in a `0600` scratch file under the session scratchpad and delete it after Task 5.

- [ ] **Step 4: Verify the role can connect and the database is empty**

Connect as `screencast_recorder_app` and run `SELECT current_database(), current_user;` then `\dt`.
Expected: the correct database and user, and zero tables. Also verify the role **cannot** read another service's database — attempt a connection to `cv_tuning` and expect permission denied.

- [ ] **Step 5: Record the outcome (no values)**

```bash
cd /home/ssf/Documents/Github/screencast-recorder
cat >> TASKS.md <<'EOF'

- [x] Postgres database `screencast_recorder` and role `screencast_recorder_app` provisioned; cross-database access denied (verified).
EOF
git add TASKS.md && git commit -m "docs: record postgres provisioning for screencast-recorder"
```

---

### Task 3: Create the MinIO bucket, non-root user and scoped service account

**Files:**
- Create: `scripts/provision-minio.sh` in **`minio-microservice`** (not this repo)

**Interfaces:**
- Consumes: nothing
- Produces: bucket `screencast-sessions`, policy `screencast-rw`, MinIO user `screencast-recorder`, and a service account whose access key and secret key go to Vault in Task 5

- [ ] **Step 1: Confirm the real `mc` is only inside the pod**

```bash
command -v mc && mc --version 2>&1 | head -1
kubectl exec -n statex-apps deploy/minio-microservice -- mc --version | head -1
```

Expected: the host `mc` reports **GNU Midnight Commander**; the pod reports `mc version RELEASE...`. This is why every step below runs via `kubectl exec`.

- [ ] **Step 2: Confirm the bucket does not exist and the live data is untouched**

```bash
ls /srv/speakasap-records/
```

Expected: `backups catalog-media cv-uploads school-committee speakasap-records wisdom-quotes` and **no** `screencast-sessions`. Confirm `speakasap-records/` is present — it must remain untouched throughout.

- [ ] **Step 3: Write the provisioning script**

Create `/home/ssf/Documents/Github/minio-microservice/scripts/provision-minio.sh`:

```bash
#!/usr/bin/env bash
# Provision the screencast-sessions bucket with a scoped, non-root identity.
#
# Root credentials are required once, here, because MinIO admin operations
# demand them. Nothing at runtime uses root: the service authenticates as a
# service account whose policy cannot address any other bucket.
set -euo pipefail

NS=statex-apps
DEPLOY=deploy/minio-microservice
BUCKET=screencast-sessions
POLICY=screencast-rw
USER=screencast-recorder

mck() { kubectl exec -n "$NS" "$DEPLOY" -- mc "$@"; }

# The pod's `local` alias has no stored credentials; set it from the running
# MinIO's own root env so the secret never crosses the host boundary.
kubectl exec -n "$NS" "$DEPLOY" -- sh -c \
  'mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null'

mck mb --ignore-existing "local/${BUCKET}"

kubectl exec -n "$NS" "$DEPLOY" -- sh -c "cat > /tmp/${POLICY}.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": ["arn:aws:s3:::${BUCKET}"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": ["arn:aws:s3:::${BUCKET}/*"]
    }
  ]
}
EOF

mck admin policy create local "$POLICY" "/tmp/${POLICY}.json" || \
  echo "policy ${POLICY} already exists; continuing"

echo "Created bucket ${BUCKET}, policy ${POLICY}."
echo "Next: create user ${USER} and its service account (see script comments)."
```

```bash
chmod +x /home/ssf/Documents/Github/minio-microservice/scripts/provision-minio.sh
```

- [ ] **Step 4: Run it and create the non-root user plus service account**

```bash
/home/ssf/Documents/Github/minio-microservice/scripts/provision-minio.sh
```

Then create the user and bind the policy, generating the password without echoing it:

```bash
kubectl exec -n statex-apps deploy/minio-microservice -- sh -c \
  'MC_PW=$(openssl rand -base64 24); \
   mc admin user add local screencast-recorder "$MC_PW" >/dev/null && \
   mc admin policy attach local screencast-rw --user screencast-recorder && \
   echo USER_CREATED'
```

Expected: `USER_CREATED`. Then create the service account, which is the only credential the application ever uses:

```bash
kubectl exec -n statex-apps deploy/minio-microservice -- \
  mc admin user svcacct add local screencast-recorder --json
```

Capture `accessKey` and `secretKey` from the JSON into a `0600` scratch file for Task 5. Do not paste them into the transcript.

- [ ] **Step 5: Verify the scope — this is the whole point of the task**

The service account must reach `screencast-sessions` and **must not** reach `speakasap-records`:

```bash
kubectl exec -n statex-apps deploy/minio-microservice -- sh -c \
  'mc alias set scoped http://localhost:9000 "$SC_AK" "$SC_SK" >/dev/null && \
   mc ls scoped/screencast-sessions && echo SCOPED_READ_OK; \
   mc ls scoped/speakasap-records && echo "FAIL: reached speakasap-records" || echo DENIED_AS_EXPECTED'
```

(Pass `SC_AK`/`SC_SK` into the exec environment; do not hardcode them.)
Expected: `SCOPED_READ_OK` followed by `DENIED_AS_EXPECTED`. If `speakasap-records` is readable, the policy is wrong — fix it before continuing.

- [ ] **Step 6: Commit the script to minio-microservice**

```bash
cd /home/ssf/Documents/Github/minio-microservice
git add scripts/provision-minio.sh
git commit -m "feat: add scoped provisioning for screencast-sessions bucket"
```

Do **not** push to `main` yet — pushing triggers auto-deploy of minio-microservice, which is unnecessary for a script-only change. Report to the owner and let them decide.

---

### Task 4: Register Auth identities (human application and service principal)

**Files:**
- Modify: none in this repo

**Interfaces:**
- Consumes: nothing
- Produces: Auth application `screencast-recorder` with default role `app:screencast-recorder:user`; service principal `svc-screencast-agent--screencast-recorder@internal.alfares.cz` with role `internal:screencast-recorder:agent`; the minted RS256 token written to a file for Task 5

- [ ] **Step 1: Read the standard before minting anything**

```bash
sed -n '1,90p' /home/ssf/Documents/Github/auth-microservice/docs/SERVICE_IDENTITY_CONSUMER_STANDARD.md
```

Confirm the identity shape and that `provision-service-token.js` is the only sanctioned minting path.

- [ ] **Step 2: Register the user-facing application**

Call `POST /auth/admin/applications/register` as a platform administrator with `name: screencast-recorder`, `type: user_facing`, domain `screencast.alfares.cz`, a display name and description. Obtain the admin JWT via `/home/ssf/Documents/Github/shared/scripts/get-admin-jwt.sh`.

Then create and activate the application-scoped default role `app:screencast-recorder:user`. Without this exact role a valid password or one-time code fails **after** verification — the login appears to accept the credential and then rejects the session.

- [ ] **Step 3: Dry-run the service-token mint**

```bash
kubectl exec -n statex-apps deploy/auth-microservice -c app -- \
  node scripts/provision-service-token.js \
  --email=svc-screencast-agent--screencast-recorder@internal.alfares.cz \
  --service-name=screencast-agent \
  --role=internal:screencast-recorder:agent \
  --dry-run
```

Expected: a dry-run summary with no writes and no token emitted. Confirm the role string is exactly `internal:screencast-recorder:agent` and that it is not `global:superadmin`.

- [ ] **Step 4: Mint for real**

Re-run Step 3 without `--dry-run`, following the script's confirmation gates and its secure output handling. The token is written to a file inside the pod; retrieve it without printing it to the transcript, and hold it for Task 5.

- [ ] **Step 5: Verify the token is RS256 and carries the right claims**

Decode only the header and the `role`/`email` claims (never the signature) and confirm `alg: RS256`, the expected identity, and the expected role. A token that looks healthy but is HS256 is a known ecosystem failure — every verifier rejects it while dashboards show it as valid.

- [ ] **Step 6: Record the outcome (no values)**

```bash
cd /home/ssf/Documents/Github/screencast-recorder
cat >> TASKS.md <<'EOF'
- [x] Auth application `screencast-recorder` + role `app:screencast-recorder:user` registered.
- [x] Service principal `svc-screencast-agent--screencast-recorder` minted RS256 with role `internal:screencast-recorder:agent`.
EOF
git add TASKS.md && git commit -m "docs: record auth identity provisioning"
```

---

### Task 5: Write the Vault path and wire every key into the ExternalSecret

**Files:**
- Modify: `k8s/external-secret.yaml`
- Modify: `.env.example`

**Interfaces:**
- Consumes: the Postgres DSN (Task 2), the MinIO service-account keys (Task 3), the RS256 agent token (Task 4)
- Produces: Vault path `secret/prod/screencast-recorder` populated, and a Kubernetes Secret `screencast-recorder-secret` containing every key

- [ ] **Step 1: Confirm Vault is unsealed**

```bash
export VAULT_ADDR=http://127.0.0.1:8200
curl -s $VAULT_ADDR/v1/sys/seal-status | grep -o '"sealed":[a-z]*'
```

Expected: `"sealed":false`. If sealed, unseal with the key at `vault-microservice/.vault-init` before continuing — a sealed Vault fails deploys with an ExternalSecret error that never mentions Vault.

- [ ] **Step 2: Write the keys**

```bash
export VAULT_ADDR=http://127.0.0.1:8200
vault kv put secret/prod/screencast-recorder \
  SCREENCAST_DATABASE_URL=@/dev/stdin-or-scratch-file \
  MINIO_ENDPOINT_URL=https://minio.alfares.cz \
  MINIO_BUCKET=screencast-sessions \
  MINIO_ACCESS_KEY=... MINIO_SECRET_KEY=... \
  AGENT_BEARER=... \
  LOGGING_SERVICE_URL=http://logging-microservice:3367 \
  AUTH_SERVICE_URL=http://auth-microservice:3370 \
  MONITORING_SERVICE_URL=http://monitoring-microservice:3395
```

Read each secret value from the `0600` scratch files created in Tasks 2–4 rather than typing them inline, so no value enters shell history. Note `vault kv put` replaces the whole document — write all keys in one call.

- [ ] **Step 3: Verify the key names landed (names only, never values)**

```bash
export VAULT_ADDR=http://127.0.0.1:8200
vault kv get -format=json secret/prod/screencast-recorder | \
  python3 -c "import sys,json;print(sorted(json.load(sys.stdin)['data']['data'].keys()))"
```

Expected: all nine key names. **Never** print values.

- [ ] **Step 4: Give every key an explicit entry in the ExternalSecret**

Edit `k8s/external-secret.yaml` so that `spec.data` contains one entry per key:

```yaml
    - secretKey: SCREENCAST_DATABASE_URL
      remoteRef:
        key: secret/prod/screencast-recorder
        property: SCREENCAST_DATABASE_URL
```

Repeat for `MINIO_ENDPOINT_URL`, `MINIO_BUCKET`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `AGENT_BEARER`, `LOGGING_SERVICE_URL`, `AUTH_SERVICE_URL`, `MONITORING_SERVICE_URL`. There is no wildcard form — a key you omit here silently never reaches the pod while ESO still reports `Synced`.

- [ ] **Step 5: Apply and verify the Secret actually contains all nine keys**

```bash
kubectl apply -f k8s/external-secret.yaml
kubectl get externalsecret screencast-recorder-secret -n statex-apps \
  -o jsonpath='{.status.conditions[0].status}{"\n"}'
kubectl get secret screencast-recorder-secret -n statex-apps \
  -o jsonpath='{range $k,$v := .data}{$k}{"\n"}{end}' | sort
```

Expected: `True`, then all nine key names. Checking `Ready=True` alone is insufficient — enumerate the keys.

- [ ] **Step 6: Commit**

```bash
cd /home/ssf/Documents/Github/screencast-recorder
git add k8s/external-secret.yaml .env.example
git commit -m "feat: declare screencast-recorder secrets via ESO"
```

---

### Task 6: Create the agent's Vault AppRole

**Files:**
- Create: `scripts/provision-agent-approle.sh`

**Interfaces:**
- Consumes: Vault path from Task 5
- Produces: AppRole `screencast-agent` with policy `screencast-agent-policy`, a `role_id`, and a response-wrapped `secret_id` issuing procedure

- [ ] **Step 1: Confirm AppRole is the established host-side pattern**

```bash
export VAULT_ADDR=http://127.0.0.1:8200
vault list auth/approle/role
```

Expected: `allegro aukro bazos flipflop heureka`. This confirms AppRole is the ecosystem's existing path for non-pod consumers, not a new protocol.

- [ ] **Step 2: Write the provisioning script**

Create `scripts/provision-agent-approle.sh`:

```bash
#!/usr/bin/env bash
# Vault AppRole for the host-side screencast agent.
#
# The agent runs outside Kubernetes and so has no Secret to mount. It reaches
# the same Vault by AppRole, the path already used by allegro/aukro/bazos/
# flipflop/heureka. It reads the Auth-minted pair token; it never mints or
# self-signs a credential.
set -euo pipefail
export VAULT_ADDR=http://127.0.0.1:8200

vault policy write screencast-agent-policy - <<'EOF'
path "secret/data/prod/screencast-recorder" {
  capabilities = ["read"]
}
EOF

vault write auth/approle/role/screencast-agent \
  token_policies=screencast-agent-policy \
  token_ttl=1h \
  token_max_ttl=24h \
  secret_id_ttl=0 \
  secret_id_num_uses=0

echo "role_id:"
vault read -field=role_id auth/approle/role/screencast-agent/role-id
```

```bash
chmod +x scripts/provision-agent-approle.sh && ./scripts/provision-agent-approle.sh
```

- [ ] **Step 3: Issue a response-wrapped secret_id**

```bash
export VAULT_ADDR=http://127.0.0.1:8200
vault write -wrap-ttl=120s -f auth/approle/role/screencast-agent/secret-id
```

The wrapping token is single-use and expires in 120 seconds; the agent unwraps it at enrollment. Do not store the unwrapped `secret_id`.

- [ ] **Step 4: Verify the AppRole can read the path and nothing else**

Log in with the `role_id` and an unwrapped `secret_id`, then confirm the resulting token reads `secret/prod/screencast-recorder` **and is denied** on another service's path:

```bash
export VAULT_ADDR=http://127.0.0.1:8200
VAULT_TOKEN=<approle-token> vault kv get -field=MINIO_BUCKET secret/prod/screencast-recorder
VAULT_TOKEN=<approle-token> vault kv get secret/prod/cv-tuning 2>&1 | grep -qi "permission denied" && echo DENIED_AS_EXPECTED
```

Expected: `screencast-sessions`, then `DENIED_AS_EXPECTED`.

- [ ] **Step 5: Commit**

```bash
git add scripts/provision-agent-approle.sh
git commit -m "feat: add Vault AppRole provisioning for the host agent"
```

---

### Task 7: Complete the integration contract and pass the planning gate

**Files:**
- Modify: `ips-adoption.json`
- Modify: `docs/06_architecture/INTEGRATION_CONTRACT.md`
- Modify: `SYSTEM.md`, `BUSINESS.md`

**Interfaces:**
- Consumes: the capability decisions table in the spec
- Produces: an adoption profile that passes `validate_adoption_profile.py --phase planning`

- [ ] **Step 1: Run the gate first to see what it demands**

```bash
cd /home/ssf/Documents/Github/screencast-recorder
python3 ../intent-preservation-system/scripts/validate_adoption_profile.py --root . --phase planning
```

Expected: FAIL, listing unresolved capabilities. Record the exact list — it drives Step 2.

- [ ] **Step 2: Mark every capability using the spec's table verbatim**

In `ips-adoption.json` and `docs/06_architecture/INTEGRATION_CONTRACT.md`, mark: `auth`, `postgres`, `object-storage`, `logging`, `monitoring`, `docs-rag`, `event-bus` as **required**; `ai` as **not-applicable** with reason "editing is phase 2; becomes required then"; `notifications` as **not-applicable** ("a single operator watches a live UI"); `redis` ("no queueing, leasing or dedup requirement"); `backups` ("raw media is deliberately not backed up"); and `payments`, `catalog`, `orders`, `warehouse`, `invoices` ("no domain relationship").

Every required integration must state its contract, configuration, failure mode and validation. No capability may be left undecided.

- [ ] **Step 3: Re-run the gate**

```bash
python3 ../intent-preservation-system/scripts/validate_adoption_profile.py --root . --phase planning
```

Expected: PASS. Implementation code must not be written while this gate fails.

- [ ] **Step 4: Commit**

```bash
git add ips-adoption.json docs/06_architecture/INTEGRATION_CONTRACT.md SYSTEM.md BUSINESS.md
git commit -m "docs: complete integration contract; planning gate passes"
```

---

### Task 8: Register the ecosystem identity

**Files:**
- Modify: `shared/config/ecosystem-repositories.json`
- Modify: `shared/ECOSYSTEM_MAP.md`

**Interfaces:**
- Consumes: a GitHub remote for the repository
- Produces: a catalog entry with `ipsAdoptionRequired: true`, an ecosystem-map row, and generated Copilot pointer files

- [ ] **Step 1: Create the GitHub repository and set the remote**

```bash
cd /home/ssf/Documents/Github/screencast-recorder
gh repo create speakASAP/screencast-recorder --private --source=. --remote=origin
git push -u origin main
```

Pushing `main` triggers the deploy queue. At this point the repository contains harness and docs only, so a deploy attempt is expected to be a no-op or to fail cleanly on a missing image — verify which, and do not treat a failure here as a code defect.

- [ ] **Step 2: Add the ecosystem-map row**

Add `screencast-recorder` to the service table in `shared/ECOSYSTEM_MAP.md` with port `3391` and domain `screencast.alfares.cz`, and extend the `33xx core` port-reference line to record 3391 as taken. Note in that line that 3380–3389 remains the `ai` block.

- [ ] **Step 3: Re-run the scaffolder with catalog registration**

```bash
cd /home/ssf/Documents/Github/shared && python3 scripts/scaffold-new-service.py screencast-recorder \
  --repository https://github.com/speakASAP/screencast-recorder \
  --port 3391 \
  --register-catalog
```

- [ ] **Step 4: Verify the catalog validator accepts the new entry**

```bash
cd /home/ssf/Documents/Github/shared
python3 -c "
import json;d=json.load(open('config/ecosystem-repositories.json'))
e=[r for r in d['repositories'] if r['id']=='screencast-recorder']
print(e)
assert e and e[0].get('ipsAdoptionRequired') is True, 'missing ipsAdoptionRequired'
print('CATALOG_OK')"
python3 scripts/validate-ecosystem-catalog.py
```

Expected: the entry printed, `CATALOG_OK`, and a passing validator. The validator rejects a newly added repository without `ipsAdoptionRequired`.

- [ ] **Step 5: Commit the shared changes**

```bash
cd /home/ssf/Documents/Github/shared
git add config/ecosystem-repositories.json ECOSYSTEM_MAP.md
git commit -m "feat: register screencast-recorder on port 3391"
```

Do not push `shared` without the owner's go-ahead; it is a widely consumed repository.

---

## Definition of done

- The repository is a Git repo with the full harness, and the spec and plans survived scaffolding.
- Postgres `screencast_recorder` exists with a role that is verified unable to read another service's database.
- Bucket `screencast-sessions` exists; the runtime service account reads it and is **verified denied** on `speakasap-records`; nothing at runtime uses root.
- Auth holds the user-facing application with `app:screencast-recorder:user`, and
  a service principal with local role `internal:screencast-recorder:agent` per
  `SERVICE_IDENTITY_CONSUMER_STANDARD.md`.
- All nine Vault keys are present, each has an explicit ExternalSecret entry, and the Kubernetes Secret is verified to contain all nine by enumeration.
- The AppRole reads only `secret/prod/screencast-recorder` and is verified denied elsewhere.
- The planning gate passes and the catalog validator accepts the entry.

---

## Execution record (2026-09-06)

What the plan predicted, and what the live systems actually required.

### Deviations from the plan

| Planned | Actual | Why |
|---|---|---|
| Database `screencast_recorder`, role `screencast_recorder_app` | Database `screencast`, role `screencast_app` | The 45 live databases use short names (`cv`, `ai`, `bpcp`, `runlayer`). Matching the convention beat matching the plan. |
| `mkrole.sh` not mentioned | Used `shared/scripts/db-roles/mkrole.sh` | It is the established convention: creates the role, transfers ownership across every non-system schema, stages the password in Vault without printing it, and reports unowned objects. Writing new SQL would have duplicated it worse. |
| Vault path written once in Task 5 | Created in Task 2, patched thereafter | `mkrole.sh` writes `DB_PASSWORD_NEW` into an existing path, so the path had to exist first. `kv put` replaces a whole document; every later write used `kv patch`. |
| `openssl` inside the MinIO pod | Generated on the host, passed via `env` | The pod has no `openssl`. The first attempt created a user with an empty password and still printed its success line, because the `echo` was not gated on the command's exit status. |
| Auth application via `register-application.sh` | Wrote `seed-screencast-recorder-roles.js` | Public registration is closed (correct hardening), and the authenticated path needs an admin JWT. The ecosystem's actual pattern is a per-service seed script run inside the auth pod; this one follows `seed-docs-rag-roles.js`. |
| One service principal | Application + two roles, then the principal | `provision-service-token.js` refuses to mint until the target application and role exist: *"Application not found ... Run seed first."* Then it refuses again until the principal exists: *"Re-run with `--create-if-missing` after owner approval."* Both gates are correct. |
| Nine Vault keys | Thirteen | The DSN was split into `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` to match `mkrole.sh`'s output and the ecosystem's `DB_*` convention. |

### Findings worth keeping

- **The scaffolder emits a `STATE.json` its own pre-commit hook rejects.**
  `scaffold-new-service.py` writes the legacy narrative keys (`activeTask`,
  `blockers`, `deployment`, `health`, ...) while the hook enforces the
  wave-projection contract. Every newly scaffolded repository fails its first
  commit until the file is rewritten. This is a bug in `shared`.

- **A commit to a code-less repository wedges the shared deploy worker.** The
  IPS preflight correctly refuses to deploy a repo full of placeholders, but
  the failure fires an alert and leaves `statex-deploy-queue.service` in
  `FAILED`, which blocks the queue for every other service until someone runs
  `systemctl --user reset-failed statex-deploy-queue.service`. Resolved by
  adding a temporary, commented deny-list entry; remove it once phase-1 code
  exists.

- **Thirteen databases still grant `PUBLIC` CONNECT.** `auth`, `backups`,
  `bpcp`, `cv`, `growth_core`, `marathon`, `minio`, `monitoring`, `orders`,
  `payment`, `postgres`, `scratch_alert_mig`, `warehouse_db`. Any login role
  can connect to them; table grants still apply, so the exposure is catalog
  metadata and a connection slot rather than row data. The 33 restricted
  databases are the ones that went through `mkrole.sh`. Out of scope here.

- **`Ready=True` on an ExternalSecret proves nothing about key coverage.**
  Verification enumerated all thirteen keys of the generated Secret.

### Verification evidence

| Claim | Evidence |
|---|---|
| DB role is scoped | `rolsuper/rolcreaterole/rolcreatedb` all false; owns every object; `CONNECT` revoked from `PUBLIC` on `screencast` |
| Storage credential is scoped | Reads and writes `screencast-sessions`; denied on `speakasap-records`, `backups`, `cv-uploads`, `catalog-media`, `wisdom-quotes`, `school-committee`, and `mc admin` |
| Token is genuine RS256 | Header decoded: `alg=RS256`, `kid=a975635403084850`, `type=service`, exactly one role `internal:screencast-recorder:agent` |
| Secret reaches the pod | All thirteen keys enumerated from the live Secret, none missing, none extra |
| AppRole is least privilege | Wrapped `secret_id` → unwrap → login → read own path; denied on `secret/prod/cv-tuning` and `secret/prod/minio-microservice`; denied write to its own path |

### Still open

- Task 7 (planning gate) fails only on owner approval of `BUSINESS.md`,
  `CONSTITUTION.md` and `VISION.md`. Everything an agent may legitimately
  complete is complete.
- Task 8 (GitHub remote, ecosystem map, catalog registration) is not started;
  it awaits the owner's go-ahead to create the public repository.
