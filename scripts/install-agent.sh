#!/usr/bin/env bash
# Installs the screencast recording agent as a systemd *user* service.
#
# A user service, not a system one: capture needs this login session's X11
# socket, PipeWire socket and /dev/dri. A system unit has none of them, and the
# failure looks like "cannot open display" minutes into a session.
set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  echo "Refusing to run as root: this installs a user service for the seat that records." >&2
  exit 1
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_SRC="${REPO_DIR}/agent"
INSTALL_DIR="${HOME}/.local/lib/screencast-agent"
CONFIG_DIR="${HOME}/.config/screencast-agent"
UNIT_DIR="${HOME}/.config/systemd/user"

API_URL="${SCREENCAST_API_URL:-https://screencast.alfares.cz}"
VAULT_ADDR="${VAULT_ADDR:-http://127.0.0.1:8200}"

echo "==> Building the agent"
cd "$AGENT_SRC"
npm ci --silent
npm run build --silent

echo "==> Installing to ${INSTALL_DIR}"
mkdir -p "$INSTALL_DIR"
rm -rf "${INSTALL_DIR:?}/dist" "${INSTALL_DIR:?}/node_modules"
cp -r dist "$INSTALL_DIR/"
cp package.json "$INSTALL_DIR/"
( cd "$INSTALL_DIR" && npm ci --omit=dev --silent )

echo "==> Vault AppRole enrolment"
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

ROLE_ID="$(VAULT_ADDR="$VAULT_ADDR" vault read -field=role_id auth/approle/role/screencast-agent/role-id)"

# Response-wrapped: the secret_id itself never appears in this shell's history,
# in the process table, or in the terminal. The wrapping token is single-use and
# expires in two minutes.
WRAP_TOKEN="$(VAULT_ADDR="$VAULT_ADDR" vault write -wrap-ttl=120s -f \
  -field=wrapping_token auth/approle/role/screencast-agent/secret-id)"
SECRET_ID="$(VAULT_ADDR="$VAULT_ADDR" VAULT_TOKEN="$WRAP_TOKEN" vault unwrap -field=secret_id)"

CONFIG_FILE="${CONFIG_DIR}/config.json"
umask 077
cat > "$CONFIG_FILE" <<EOF
{
  "apiUrl": "${API_URL}",
  "vaultAddr": "${VAULT_ADDR}",
  "roleId": "${ROLE_ID}",
  "secretId": "${SECRET_ID}",
  "recordingDir": "${HOME}/recordings",
  "minFreeGb": 20,
  "version": "0.1.0"
}
EOF
chmod 600 "$CONFIG_FILE"
unset SECRET_ID WRAP_TOKEN

echo "==> Installing the systemd user unit"
mkdir -p "$UNIT_DIR"
install -m 644 "${AGENT_SRC}/systemd/screencast-agent.service" "${UNIT_DIR}/screencast-agent.service"
systemctl --user daemon-reload

mkdir -p "${HOME}/recordings"

cat <<'EOF'

Installed. To start it:

    systemctl --user enable --now screencast-agent
    systemctl --user status screencast-agent --no-pager
    journalctl --user -u screencast-agent -f

The agent only runs while a graphical session is active, which is correct: it
cannot capture a screen that is not logged in. If you need it to survive
logout, enable lingering with `loginctl enable-linger $USER` -- but note that a
recording still requires a live seat.
EOF
