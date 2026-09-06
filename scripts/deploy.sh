#!/bin/bash
# deploy.sh — shim into the shared runner. See shared/docs/DEPLOY_STANDARD.md.
#
# All deploy logic lives in shared/scripts/deploy.sh + shared/scripts/deploy-lib/.
# This file is deliberately not logic: a copied-and-adapted deploy.sh is
# exactly how one template bug (silent no-op tag reuse) spread to 31 services
# before the 2026-07-18 standardization (see DEPLOY_STANDARDIZATION_REPORT.md).
#
# Before this shim will work, screencast-recorder needs a deploy.config.sh next
# to this script's parent directory — copy deploy.config.sh.tpl from this
# same templates/ directory and fill in SERVICE_NAME / IMAGES / DEPLOYMENTS.
# Prove it with `shared/scripts/deploy.sh screencast-recorder --dry-run` before
# relying on this shim.
set -euo pipefail
exec "$(dirname "$0")/../../shared/scripts/deploy.sh" "$(basename "$(cd "$(dirname "$0")/.." && pwd)")" "$@"
