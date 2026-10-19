#!/usr/bin/env bash
# First live Orloom mission on the Hostinger VPS: one approved slice, one lane,
# syntax-check verifier, stops at a certified candidate (no integration/delivery).
#
# Usage (as root, from /opt/orloom):
#   deploy/hostinger/first-mission/bootstrap.sh preflight
#   deploy/hostinger/first-mission/bootstrap.sh runsc
#   deploy/hostinger/first-mission/bootstrap.sh secrets
#   deploy/hostinger/first-mission/bootstrap.sh build
#   deploy/hostinger/first-mission/bootstrap.sh control-plane
#   deploy/hostinger/first-mission/bootstrap.sh mission
#   deploy/hostinger/first-mission/bootstrap.sh check
#   deploy/hostinger/first-mission/bootstrap.sh run
set -euo pipefail

REPO_ROOT=${REPO_ROOT:-/opt/orloom}
HERE="$REPO_ROOT/deploy/hostinger/first-mission"
COMPOSE_DIR="$REPO_ROOT/deploy/hostinger"
STATE=/var/lib/orloom
WORKER="$STATE/worker"
CONF=/etc/orloom-worker
SANDBOX_REPO=${SANDBOX_REPO:-nrsandoval1231-oss/orloom-sandbox}
CHECK_ID=node-validate-syntax
MODEL=${ORLOOM_MODEL:-deepseek-chat}
BUDGET_CENTS=100
# Infisical secret names; override if yours differ.
INF_ENV=${INFISICAL_ENV:-prod}
INF_DEEPSEEK=${INF_DEEPSEEK:-DEEPSEEK_API_KEY}
INF_GH_APP_ID=${INF_GH_APP_ID:-ORLOOM_GITHUB_APP_ID}
INF_GH_INSTALL=${INF_GH_INSTALL:-ORLOOM_GITHUB_INSTALLATION_ID}
INF_GH_KEY=${INF_GH_KEY:-ORLOOM_GITHUB_PRIVATE_KEY}
INF_R2_ACCOUNT=${INF_R2_ACCOUNT:-R2_ACCOUNT_ID}
INF_R2_KEY=${INF_R2_KEY:-R2_ACCESS_KEY_ID}
INF_R2_SECRET=${INF_R2_SECRET:-R2_SECRET_ACCESS_KEY}

compose() { docker compose --project-name orloom -f "$COMPOSE_DIR/compose.yml" -f "$HERE/compose.first-mission.yml" --env-file "$COMPOSE_DIR/.env" "$@"; }
say() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $(id -u) -eq 0 ]] || die "run as root"

preflight() {
  say "Host"
  docker version --format 'docker {{.Server.Version}}'
  docker info --format 'runtimes: {{json .Runtimes}}'
  command -v runsc >/dev/null && runsc --version | head -1 || echo "runsc: NOT INSTALLED (run: bootstrap.sh runsc)"
  command -v node >/dev/null && node --version || echo "node: NOT INSTALLED (build step installs Node 24)"
  command -v infisical >/dev/null && infisical --version || echo "infisical: NOT INSTALLED (secrets step installs it)"
  free -h; df -h / /var/lib/docker 2>/dev/null | sort -u; nproc
  docker ps --format '{{.Names}}\t{{.Status}}'
}

runsc_install() {
  say "Installing gVisor runsc"
  if ! command -v runsc >/dev/null; then
    apt-get update -y && apt-get install -y ca-certificates curl gnupg
    curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" > /etc/apt/sources.list.d/gvisor.list
    apt-get update -y && apt-get install -y runsc
  fi
  # Registers the runtime in /etc/docker/daemon.json without removing existing keys.
  runsc install
  say "Restarting Docker (n8n and Orloom containers restart automatically, ~30s blip)"
  systemctl restart docker
  docker run --rm --runtime=runsc --network=none hello-world >/dev/null && echo "runsc smoke test: OK"
}

secrets() {
  say "Pulling secrets from Infisical into $CONF (root-only)"
  command -v infisical >/dev/null || { curl -1sLf 'https://artifacts-cli.infisical.com/setup.deb.sh' | bash && apt-get install -y infisical; }
  infisical whoami >/dev/null 2>&1 || infisical login
  [[ -f "$CONF/.infisical-project" ]] || { install -d -m 0700 "$CONF"; read -rp "Infisical project ID: " pid; echo "$pid" > "$CONF/.infisical-project"; }
  local pid; pid=$(cat "$CONF/.infisical-project")
  get() { infisical secrets get "$1" --env="$INF_ENV" --projectId="$pid" --plain --silent; }
  install -d -m 0700 "$CONF"
  umask 077
  get "$INF_DEEPSEEK" > "$CONF/deepseek_api_key"
  get "$INF_GH_KEY" > "$CONF/github_private_key.pem"
  get "$INF_R2_KEY" > "$CONF/r2_access_key_id"
  get "$INF_R2_SECRET" > "$CONF/r2_secret_access_key"
  { echo "GH_APP_ID=$(get "$INF_GH_APP_ID")"; echo "GH_INSTALLATION_ID=$(get "$INF_GH_INSTALL")"; echo "R2_ACCOUNT_ID=$(get "$INF_R2_ACCOUNT")"; } > "$CONF/ids.env"
  for f in "$CONF"/*; do [[ -s $f ]] || die "empty secret: $f (check the Infisical name)"; done
  grep -q 'BEGIN .*PRIVATE KEY' "$CONF/github_private_key.pem" || die "GitHub private key is not PEM"
  echo "Secrets written. Values were not printed."
}

build() {
  say "Node 24 for the host worker"
  if ! node --version 2>/dev/null | grep -q '^v24'; then
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs
  fi
  cd "$REPO_ROOT"
  npm ci && npm run build
  say "Worker sandbox image"
  local base; base=$(docker pull -q node:24-bookworm-slim >/dev/null && docker image inspect --format '{{index .RepoDigests 0}}' node:24-bookworm-slim)
  docker build --build-arg ORLOOM_WORKER_NODE_BASE="$base" -f apps/worker/Dockerfile.sandbox -t orloom-worker-sandbox:first .
  say "Verifier image (pinned Node base + Debian snapshot; several minutes)"
  docker build -f infra/verifier-isolation/Dockerfile -t orloom-verifier:first .
  install -d -m 0700 "$CONF"
  { echo "WORKER_IMAGE=$(docker image inspect --format '{{.Id}}' orloom-worker-sandbox:first)"
    echo "VERIFIER_IMAGE=$(docker image inspect --format '{{.Id}}' orloom-verifier:first)"; } > "$CONF/images.env"
  cat "$CONF/images.env"
}

control_plane() {
  say "Control plane + loopback DB bridge"
  cd "$COMPOSE_DIR"
  [[ -f .env ]] || cp .env.example .env
  [[ -d secrets && -s secrets/session_token ]] || ./init-secrets.sh "$(grep ^ORLOOM_HOST= .env | cut -d= -f2)"
  compose up -d --build --wait
  curl -fsS "https://$(grep ^ORLOOM_HOST= .env | cut -d= -f2)/health"; echo
}

origin() { cat "$COMPOSE_DIR/secrets/public_origin"; }
api() { # method path [json]
  local jar="$CONF/cookies"
  curl -fsS -b "$jar" -c "$jar" -H "Origin: $(origin)" -H 'Content-Type: application/json' -X "$1" "$(origin)$2" ${3:+--data "$3"}
}

mission() {
  say "Creating the approved mission on $SANDBOX_REPO"
  install -d -m 0700 "$CONF"; umask 077
  local base
  base=$(git ls-remote "https://github.com/$SANDBOX_REPO.git" refs/heads/main | cut -f1)
  [[ $base =~ ^[0-9a-f]{40}$ ]] || die "could not read $SANDBOX_REPO main (is it public and seeded?)"
  api POST /session "{\"token\":\"$(cat "$COMPOSE_DIR/secrets/session_token")\"}" >/dev/null
  local id
  id=$(api POST /api/missions "$(node -e '
    const [repo, base, budget] = process.argv.slice(1);
    console.log(JSON.stringify({ repository: repo, baseSha: base, budgetCents: Number(budget),
      objective: "Add a CANCELLATION.md file describing how an owner cancels an Orloom mission, and link it from README.md",
      acceptance: ["CANCELLATION.md exists with at least three sentences", "README.md links to CANCELLATION.md", "node scripts/validate.mjs still passes"] }));
  ' "$SANDBOX_REPO" "$base" "$BUDGET_CENTS")" | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
  api POST "/api/missions/$id/plan" "$(node -e '
    console.log(JSON.stringify({ recommendedBy: "owner-authored", slices: [{ id: "slice-1",
      objective: "Create CANCELLATION.md (3+ sentences on owner cancellation) and add a link to it in README.md",
      dependencies: [], owner: "core", scopes: ["CANCELLATION.md", "README.md"], checks: [process.argv[1]], budgetCents: Number(process.argv[2]) }] }));
  ' "$CHECK_ID" "$BUDGET_CENTS")" >/dev/null
  api POST "/api/missions/$id/approve" '{}' >/dev/null
  local plan_digest policy_digest
  plan_digest=$(api GET "/api/missions/$id" | node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { createHash } from "node:crypto";
    const { canonicalJson } = await import(process.argv[1]);
    const r = JSON.parse(readFileSync(0, "utf8"));
    process.stdout.write(createHash("sha256").update(canonicalJson(r.plan.slices)).digest("hex"));
  ' "$REPO_ROOT/dist/packages/judgment/src/canonical.js")
  [[ $plan_digest =~ ^[0-9a-f]{64}$ ]] || die "could not compute plan digest"
  policy_digest=$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(JSON.stringify([process.argv[1]])).digest("hex"))' "$CHECK_ID")
  # shellcheck disable=SC1091
  . "$CONF/images.env"
  node -e '
    const [missionId, repository, baseSha, planDigest, policyDigest, budget, w, v] = process.argv.slice(1);
    console.log(JSON.stringify({ version: "orloom.approved-worker-task.v1", missionId, sliceId: "slice-1", repository, baseSha, planDigest,
      trustedCheckPolicyDigest: policyDigest, maxBudgetCents: Number(budget), expiresAt: new Date(Date.now() + 6 * 3600e3).toISOString(),
      workerImageRef: w, verifierImageRef: v }, null, 2));
  ' "$id" "$SANDBOX_REPO" "$base" "$plan_digest" "$policy_digest" "$BUDGET_CENTS" "$WORKER_IMAGE" "$VERIFIER_IMAGE" > "$CONF/approved-task.json"
  echo "Mission $id approved. Watch it: $(origin)/loom?mission=$id"
  cat "$CONF/approved-task.json"
  write_env
}

write_env() {
  say "Worker environment and protected directories"
  umask 077
  install -d -m 0755 -o root -g root "$STATE"
  install -d -m 0700 "$WORKER" "$WORKER/journal" "$WORKER/admission" "$WORKER/verifier-artifacts" "$WORKER/mirrors"
  install -d -m 0755 "$WORKER/lock"; [[ -f $WORKER/lock/service.lock ]] || install -m 0600 /dev/null "$WORKER/lock/service.lock"
  local mirror="$WORKER/mirrors/orloom-sandbox.git"
  [[ -d $mirror ]] || git clone --mirror "https://github.com/$SANDBOX_REPO.git" "$mirror"
  git -C "$mirror" remote update --prune
  echo '{"'"$CHECK_ID"'":{"executable":"node","args":["--check","scripts/validate.mjs"],"timeoutSeconds":60}}' > "$CONF/check-commands.json"
  # Conservative ceiling above DeepSeek list price; the worker refuses if worst case exceeds the budget.
  node -e '
    const now = Date.now();
    console.log(JSON.stringify({ model: process.argv[1], version: "operator-ceiling-2026-10", source: "https://api-docs.deepseek.com/quick_start/pricing (ceiling)",
      capturedAt: new Date(now - 60e3).toISOString(), expiresAt: new Date(now + 7 * 864e5).toISOString(),
      inputCentsPerMillion: 60, outputCentsPerMillion: 250, reasoningCentsPerMillion: 250, safetyMultiplier: 1.5 }));
  ' "$MODEL" > "$CONF/pricing.json"
  docker info --format '{{json .Runtimes}}' > "$WORKER/capacity-evidence.json"; runsc --version >> "$WORKER/capacity-evidence.json"
  # shellcheck disable=SC1091
  . "$CONF/ids.env"; . "$CONF/images.env"
  local db_url; db_url=$(sed 's#@db:5432/#@127.0.0.1:5433/#' "$COMPOSE_DIR/secrets/database_url")
  printf '%s' "$db_url" > "$CONF/database_url"
  cat > "$CONF/worker.env" <<EOF
ORLOOM_MODE=cloud
ORLOOM_WORKER_MODE=approved-single
ORLOOM_WORKER_APPROVED_TASK_FILE=$CONF/approved-task.json
ORLOOM_DATABASE_URL_FILE=$CONF/database_url
ORLOOM_DEEPSEEK_API_KEY_FILE=$CONF/deepseek_api_key
ORLOOM_GITHUB_APP_ID=$GH_APP_ID
ORLOOM_GITHUB_INSTALLATION_ID=$GH_INSTALLATION_ID
ORLOOM_GITHUB_PRIVATE_KEY_FILE=$CONF/github_private_key.pem
ORLOOM_R2_ACCOUNT_ID=$R2_ACCOUNT_ID
ORLOOM_R2_ACCESS_KEY_ID_FILE=$CONF/r2_access_key_id
ORLOOM_R2_SECRET_ACCESS_KEY_FILE=$CONF/r2_secret_access_key
ORLOOM_R2_BUCKET=orloom-artifacts
ORLOOM_WORKER_SANDBOX_IMAGE_REF=$WORKER_IMAGE
ORLOOM_WORKER_CHECK_COMMANDS_FILE=$CONF/check-commands.json
ORLOOM_WORKER_PRICING_SNAPSHOT_FILE=$CONF/pricing.json
ORLOOM_WORKER_RUNTIME_JOURNAL_ROOT=$WORKER/journal
ORLOOM_WORKER_SERVICE_LOCK_FILE=$WORKER/lock/service.lock
ORLOOM_VERIFIER_IMAGE=$VERIFIER_IMAGE
ORLOOM_VERIFIER_ID=hostinger-verifier-1
ORLOOM_VERIFIER_ARTIFACT_ROOT=$WORKER/verifier-artifacts
ORLOOM_VERIFIER_REPOSITORIES={"$SANDBOX_REPO":{"objectStore":"$mirror","approvedRef":"refs/heads/main"}}
ORLOOM_VERIFIER_LAUNCHER=$REPO_ROOT/infra/verifier-isolation/launch-verifier.sh
ORLOOM_CANDIDATE_ADMISSION_ROOT=$WORKER/admission
ORLOOM_VERIFICATION_POLICY_VERSION=orloom.check-policy.v1
ORLOOM_VERIFIER_CHECK_ID=$CHECK_ID
ORLOOM_TRUSTED_CHECK_POLICY_JSON=["$CHECK_ID"]
ORLOOM_WORKER_ALLOWED_PROVIDERS_JSON=["deepseek"]
ORLOOM_WORKER_ALLOWED_MODELS_JSON=["$MODEL"]
ORLOOM_WORKER_MAX_PROVIDER_CALLS=24
ORLOOM_WORKER_MAX_INPUT_TOKENS=200000
ORLOOM_WORKER_MAX_OUTPUT_TOKENS=20000
ORLOOM_WORKER_MAX_WALL_SECONDS=900
ORLOOM_WORKER_MAX_TOOL_CALLS=48
ORLOOM_MAX_LANES=1
ORLOOM_CAPACITY_SLOTS=1
ORLOOM_CAPACITY_EVIDENCE_VERIFIED=true
ORLOOM_CAPACITY_EVIDENCE_SHA256=$(sha256sum "$WORKER/capacity-evidence.json" | cut -d' ' -f1)
ORLOOM_CAPACITY_EVIDENCE_EXPIRES_AT=$(date -u -d '+2 days' +%Y-%m-%dT%H:%M:%SZ)
ORLOOM_INTEGRATION_ENABLED=false
ORLOOM_DELIVERY_ENABLED=false
EOF
  chmod 0600 "$CONF"/*
  echo "Wrote $CONF/worker.env"
}

check() {
  cd "$WORKER"   # admission/artifact roots must be outside the cwd source tree
  node --env-file="$CONF/worker.env" "$REPO_ROOT/dist/apps/worker/src/main.js" --check-config
}

run() {
  say "LIVE RUN: one DeepSeek-backed slice, budget ${BUDGET_CENTS}c. Ctrl+C requests a clean stop."
  cd "$WORKER"
  node --env-file="$CONF/worker.env" "$REPO_ROOT/dist/apps/worker/src/main.js" 2>&1 | tee -a "$WORKER/run-$(date -u +%Y%m%dT%H%M%SZ).log"
}

case "${1:-}" in
  preflight) preflight ;; runsc) runsc_install ;; secrets) secrets ;; build) build ;;
  control-plane) control_plane ;; mission) mission ;; env) write_env ;; check) check ;; run) run ;;
  *) sed -n '2,14p' "$0"; exit 2 ;;
esac
