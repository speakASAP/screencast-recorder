# deploy.config.sh — declaration consumed by shared/scripts/deploy.sh.
# See shared/docs/DEPLOY_STANDARD.md for the full format and permanent hooks.
# Replace every __PLACEHOLDER__, delete any unused optional hooks, then prove
# it with `shared/scripts/deploy.sh screencast-recorder --dry-run` before relying
# on scripts/deploy.sh (the shim) for a real deploy.

SERVICE_NAME="screencast-recorder"
PORT="3391"
IPS_ADOPTION_REQUIRED="1"
# NAMESPACE="statex-apps"    # optional, this is already the default
# REGISTRY="localhost:5000"  # optional, this is already the default

# image[i] = "image-name|build-context|dockerfile|extra-docker-args"
# build-context and dockerfile are both relative to the repo root; an empty
# dockerfile defaults to "<build-context>/Dockerfile".
IMAGES=(
  "screencast-recorder|.||"
)

# deployment[i] = "k8s-deployment|container|image-name"
# Leave image-name empty ("k8s-deployment|container|") only if a
# deploy_post_manifests hook already sets this deployment's image (e.g. a
# sed-templated deployment.yaml) — the runner will still wait for its
# rollout, just skip the redundant `kubectl set image`.
DEPLOYMENTS=(
  "screencast-recorder|app|screencast-recorder"
)

# MANIFESTS defaults to (configmap.yaml external-secret.yaml deployment.yaml
# service.yaml ingress.yaml) applied in that order from <service>/k8s/ — only
# set this if your manifest set or order genuinely differs.
# MANIFESTS=(configmap.yaml external-secret.yaml deployment.yaml service.yaml ingress.yaml)

# Optional hooks — uncomment and implement only what you actually need.
# None of them can skip preflight or the rollout wait.

# deploy_preflight() {
#   # Runs before build. Use for contract tests, dependency checks, or
#   # bootstrapping a secret/database that must exist before this deploy.
#   :
# }

# deploy_post_manifests() {
#   # Runs after MANIFESTS apply, before kubectl set image. Use for:
#   # waiting on an ExternalSecret, a sed/envsubst-templated deployment apply,
#   # a DB migration Job, or waiting on a dependency StatefulSet.
#   :
# }

# deploy_post_verify() {
#   # Runs after the built-in pod-readiness check. Use for a real HTTP smoke
#   # test, a post-deploy config patch, or anything else that should run once
#   # the new pods are confirmed ready.
#   :
# }
