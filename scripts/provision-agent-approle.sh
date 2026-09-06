#!/usr/bin/env bash
# Vault AppRole for the host-side screencast recording agent.
#
# The agent runs outside Kubernetes -- it needs the X11 socket, the PipeWire
# socket and /dev/dri -- so it has no Kubernetes Secret to mount and cannot use
# the Vault -> ExternalSecret -> Secret -> secretKeyRef path that the pod uses.
# AppRole is the ecosystem's established path for a non-pod consumer; allegro,
# aukro, bazos, flipflop and heureka already reach Vault this way.
#
# This is not an alternative credential protocol. The agent reads the same
# Auth-minted, Auth-signed RS256 pair token
# (svc-screencast-agent--screencast-recorder) that the standard requires. It
# never mints, never self-signs, and never holds a static credential file.
#
# A dedicated policy rather than the shared `service-auth` policy: that one
# grants secret/services/+/{database,redis,external,config}, which does not
# cover secret/prod/screencast-recorder, and widening it would grant every
# AppRole consumer access to this path.
set -euo pipefail
export VAULT_ADDR=http://127.0.0.1:8200

ROLE=screencast-agent
POLICY=screencast-agent-policy
VAULT_PATH=secret/prod/screencast-recorder

vault policy write "$POLICY" - <<EOF
# Read-only, and only this one path. The agent needs AGENT_BEARER plus the
# MinIO credentials it uploads with; it has no reason to read any other
# service's secrets.
path "secret/data/prod/screencast-recorder" {
  capabilities = ["read"]
}

path "secret/metadata/prod/screencast-recorder" {
  capabilities = ["read"]
}
EOF

vault write "auth/approle/role/${ROLE}" \
  token_policies="$POLICY" \
  token_ttl=1h \
  token_max_ttl=4h \
  secret_id_ttl=0 \
  secret_id_num_uses=0 >/dev/null

echo "AppRole ${ROLE} written with policy ${POLICY} on ${VAULT_PATH}."
echo
echo "role_id (not a secret on its own; the secret_id is the credential):"
vault read -field=role_id "auth/approle/role/${ROLE}/role-id"
echo
echo "Issue a response-wrapped secret_id for enrollment with:"
echo "  vault write -wrap-ttl=120s -f auth/approle/role/${ROLE}/secret-id"
echo "The wrapping token is single-use and expires in 120 seconds; the agent"
echo "unwraps it once at enrollment. Do not store the unwrapped secret_id."
