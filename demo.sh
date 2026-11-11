#!/usr/bin/env bash
# kgateway demo environment: kind + Gateway API + kgateway + Snellius + demo workloads,
# plus the kgateway traffic explorer UI. Mirrors the original kind-kgw-demo cluster.
#
# Usage: ./demo.sh <command>
#   prereqs   check required tools and versions (installs nothing)
#   up        create the cluster and install everything (idempotent)
#   ui        port-forward the explorer, Snellius and the Gateway (Ctrl-C stops)
#   verify    send test requests through the Gateway and compare status codes
#   status    show Gateways, ListenerSets, routes and policies
#   export    re-export manifests/ from the current cluster (needs jq, yq)
#   down      delete the kind cluster
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=versions.env
source "$ROOT/versions.env"
CTX="kind-${CLUSTER_NAME}"
K=(kubectl --context "$CTX")

c_red=$'\033[31m'; c_grn=$'\033[32m'; c_ylw=$'\033[33m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
log()  { printf '%s==>%s %s\n' "$c_grn" "$c_off" "$*"; }
warn() { printf '%sWARN:%s %s\n' "$c_ylw" "$c_off" "$*" >&2; }
die()  { printf '%sERROR:%s %s\n' "$c_red" "$c_off" "$*" >&2; exit 1; }

# ver_ge A B: true if version A >= version B (leading "v" ignored).
ver_ge() { [ "$(printf '%s\n%s\n' "${1#v}" "${2#v}" | sort -V | head -1)" = "${2#v}" ]; }

os_arch() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"; [ "$arch" = "x86_64" ] && arch=amd64; [ "$arch" = "aarch64" ] && arch=arm64
  echo "${os}-${arch}"
}

# ---------------------------------------------------------------------------
# prereqs
# ---------------------------------------------------------------------------
prereqs() {
  local missing=0 v
  log "Checking tools"

  if ! command -v docker >/dev/null; then
    warn "docker not found. Install Docker Desktop (https://docs.docker.com/get-docker/) or another Docker engine."; missing=1
  elif ! docker info >/dev/null 2>&1; then
    warn "docker is installed but the daemon is not running. Start Docker Desktop."; missing=1
  else
    echo "  docker   $(docker version --format '{{.Server.Version}}')"
  fi

  if ! command -v kind >/dev/null; then
    warn "kind not found. Install ${KIND_VERSION}:"
    echo "    curl -Lo kind https://kind.sigs.k8s.io/dl/${KIND_VERSION}/kind-$(os_arch) && chmod +x kind && sudo mv kind /usr/local/bin/"
    missing=1
  else
    v="$(kind version | awk '{print $2}')"
    echo "  kind     $v"
    [ "$v" = "$KIND_VERSION" ] || warn "kind $v differs from pinned ${KIND_VERSION} (usually fine; pinned node image is used either way)."
  fi

  if ! command -v kubectl >/dev/null; then
    warn "kubectl not found. Install: brew install kubectl  (or https://kubernetes.io/docs/tasks/tools/)"; missing=1
  else
    v="$(kubectl version --client 2>/dev/null | awk '/Client Version/{print $3}')"
    echo "  kubectl  $v"
    ver_ge "$v" "$KUBECTL_MIN_VERSION" || warn "kubectl $v is older than ${KUBECTL_MIN_VERSION}."
  fi

  if ! command -v helm >/dev/null; then
    warn "helm not found. Install: brew install helm  (or https://helm.sh/docs/intro/install/)"; missing=1
  else
    v="$(helm version --short | sed 's/+.*//')"
    echo "  helm     $v"
    ver_ge "$v" "$HELM_MIN_VERSION" || { warn "helm $v is older than ${HELM_MIN_VERSION} (OCI charts and server-side apply need helm 4)."; missing=1; }
  fi

  for t in jq yq curl; do
    if command -v "$t" >/dev/null; then echo "  $t$(printf '%*s' $((8 - ${#t})) '') ok"
    else warn "$t not found (only needed for 'export'$([ "$t" = curl ] && echo " and 'verify'")). Install: brew install $t"; fi
  done

  [ "$missing" = 0 ] || die "Install the missing tools above, then re-run."
}

# ---------------------------------------------------------------------------
# up
# ---------------------------------------------------------------------------
up() {
  prereqs

  if kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME"; then
    log "kind cluster ${CLUSTER_NAME} already exists, reusing it"
  else
    log "Creating kind cluster ${CLUSTER_NAME} (${KIND_NODE_IMAGE%@*})"
    kind create cluster --name "$CLUSTER_NAME" --image "$KIND_NODE_IMAGE" --config "$ROOT/kind/cluster.yaml" --wait 120s
  fi

  log "Installing Gateway API ${GATEWAY_API_VERSION} CRDs (standard channel)"
  "${K[@]}" apply --server-side -f "https://github.com/kubernetes-sigs/gateway-api/releases/download/${GATEWAY_API_VERSION}/standard-install.yaml"

  log "Installing kgateway ${KGATEWAY_VERSION}"
  helm upgrade --install kgateway-crds "${KGATEWAY_CHART_REPO}/kgateway-crds" --version "$KGATEWAY_VERSION" \
    --kube-context "$CTX" --namespace kgateway-system --create-namespace
  helm upgrade --install kgateway "${KGATEWAY_CHART_REPO}/kgateway" --version "$KGATEWAY_VERSION" \
    --kube-context "$CTX" --namespace kgateway-system --create-namespace --wait --timeout 5m

  log "Installing Snellius ${SNELLIUS_VERSION}"
  helm upgrade --install ui "$SNELLIUS_CHART" --version "$SNELLIUS_VERSION" \
    --kube-context "$CTX" --namespace snellius --create-namespace --wait --timeout 5m

  log "Waiting for the GatewayClass"
  for _ in $(seq 1 60); do "${K[@]}" get gatewayclass kgateway >/dev/null 2>&1 && break; sleep 2; done

  log "Applying demo manifests in original creation order"
  "${K[@]}" apply -f "$ROOT/manifests/00-namespaces.yaml"
  for f in "$ROOT"/manifests/[0-9][0-9]-wave.yaml; do
    echo "  $(basename "$f")"
    "${K[@]}" apply -f "$f"
    sleep 1.2 # distinct creationTimestamp (second granularity) for the next wave
  done

  log "Waiting for workloads (broken/never-ready and broken/broken-proxy stay unready on purpose)"
  for ns in httpbin team-a team-b; do
    "${K[@]}" -n "$ns" rollout status deploy --timeout=180s
  done
  "${K[@]}" -n kgateway-system wait --for=condition=Programmed gateway/http --timeout=180s
  "${K[@]}" -n kgateway-system rollout status deploy/http --timeout=180s

  log "Done. Next: ./demo.sh ui   (and ./demo.sh verify in another terminal)"
}

# ---------------------------------------------------------------------------
# ui
# ---------------------------------------------------------------------------
ui() {
  "${K[@]}" get ns kgateway-system >/dev/null 2>&1 || die "Cluster ${CLUSTER_NAME} not reachable. Run ./demo.sh up first."
  mkdir -p "$ROOT/.run"
  UI_PIDS=()
  "${K[@]}" proxy --port="$EXPLORER_PORT" --www="$ROOT/explorer" --www-prefix=/ui/ >"$ROOT/.run/explorer.log" 2>&1 & UI_PIDS+=($!)
  "${K[@]}" -n snellius port-forward svc/ui-snellius "${SNELLIUS_PORT}:80" >"$ROOT/.run/snellius.log" 2>&1 & UI_PIDS+=($!)
  "${K[@]}" -n kgateway-system port-forward svc/http "${GATEWAY_PORT}:8080" >"$ROOT/.run/gateway.log" 2>&1 & UI_PIDS+=($!)
  trap 'kill "${UI_PIDS[@]}" 2>/dev/null; exit 0' INT TERM
  trap 'kill "${UI_PIDS[@]}" 2>/dev/null' EXIT
  sleep 2
  for p in "${UI_PIDS[@]}"; do kill -0 "$p" 2>/dev/null || { cat "$ROOT"/.run/*.log; die "A port-forward failed (port busy?). Logs above."; }; done
  cat <<EOF

  Traffic explorer  http://127.0.0.1:${EXPLORER_PORT}/ui/
  Snellius          http://127.0.0.1:${SNELLIUS_PORT}/
  Gateway (http)    curl -H 'Host: www.example.com' http://127.0.0.1:${GATEWAY_PORT}/get

  ${c_dim}Logs in .run/. Ctrl-C stops all three.${c_off}
EOF
  wait
}

# ---------------------------------------------------------------------------
# verify: same request set that was checked against Envoy in the original env
# ---------------------------------------------------------------------------
VERIFY_CASES="
www.example.com     /get            200  httpbin route + TrafficPolicy header
api.example.com     /api/orders/1   200  delegation api-parent -> team-b/api-orders
api.example.com     /api/x          404  delegation, no child matches
a.example.com       /v1/x           200  ListenerSet team-a, URLRewrite
a.example.com       /               404  team-a needs x-canary header
b.example.com       /               200  ListenerSet team-b
nope.example.com    /               404  no route for host
missing.example.com /               500  backend Service missing
steal.example.com   /               500  cross-namespace ref without ReferenceGrant
empty.example.com   /               503  Service with 0 ready endpoints
"

verify() {
  command -v curl >/dev/null || die "curl is required"
  VERIFY_PF=""; local fails=0
  if ! curl -s -o /dev/null "http://127.0.0.1:${GATEWAY_PORT}/" 2>/dev/null; then
    "${K[@]}" -n kgateway-system port-forward svc/http "${GATEWAY_PORT}:8080" >/dev/null 2>&1 & VERIFY_PF=$!
    trap '[ -n "${VERIFY_PF:-}" ] && kill "$VERIFY_PF" 2>/dev/null' EXIT
    for _ in $(seq 1 20); do curl -s -o /dev/null "http://127.0.0.1:${GATEWAY_PORT}/" 2>/dev/null && break; sleep 0.5; done
  fi
  log "Sending requests to http://127.0.0.1:${GATEWAY_PORT}"
  while read -r host path want desc; do
    [ -z "$host" ] && continue
    got="$(curl -s -o /dev/null -w '%{http_code}' -H "Host: ${host}" "http://127.0.0.1:${GATEWAY_PORT}${path}")"
    if [ "$got" = "$want" ]; then printf '  %sPASS%s %-20s %-15s %s  %s%s%s\n' "$c_grn" "$c_off" "$host" "$path" "$got" "$c_dim" "$desc" "$c_off"
    else printf '  %sFAIL%s %-20s %-15s got %s want %s  %s\n' "$c_red" "$c_off" "$host" "$path" "$got" "$want" "$desc"; fails=$((fails + 1)); fi
  done <<<"$VERIFY_CASES"
  [ "$fails" = 0 ] && log "All checks passed" || die "${fails} check(s) failed"
}

# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------
status() {
  "${K[@]}" get gatewayclasses,gateways,listenersets -A
  echo
  "${K[@]}" get httproutes,referencegrants -A
  echo
  "${K[@]}" get trafficpolicies,listenerpolicies,backendconfigpolicies,gatewayparameters -A
}

# ---------------------------------------------------------------------------
# export: snapshot user-created objects into manifests/
# ---------------------------------------------------------------------------
JQ_DEFS='
def excluded:
  ((.metadata.ownerReferences // []) | length > 0)
  or (((.metadata.labels // {})["app.kubernetes.io/managed-by"] // "") as $m | $m == "Helm" or $m == "kgateway")
  or (.kind == "Secret" and ((.type // "") | startswith("helm.sh/")))
  or (.kind == "Secret" and .metadata.name == "oauth2-hmac-secret")
  or (.kind == "ConfigMap" and .metadata.name == "kube-root-ca.crt")
  or (.kind == "ServiceAccount" and .metadata.name == "default")
  or (.kind == "Service" and .metadata.name == "kubernetes");
def clean:
  del(.status, .metadata.uid, .metadata.resourceVersion, .metadata.generation,
      .metadata.creationTimestamp, .metadata.managedFields, .metadata.selfLink)
  | .metadata.annotations = ((.metadata.annotations // {}) | with_entries(select(.key
      | IN("kubectl.kubernetes.io/last-applied-configuration", "deployment.kubernetes.io/revision") | not)))
  | if .metadata.annotations == {} then del(.metadata.annotations) else . end
  | if .kind == "Service" then del(.spec.clusterIP, .spec.clusterIPs) else . end
  | if .kind == "Deployment" then del(.spec.template.metadata.creationTimestamp) else . end
  | if .kind == "Namespace" then del(.spec) | .metadata.labels |= del(.["kubernetes.io/metadata.name"])
      | if .metadata.labels == {} then del(.metadata.labels) else . end else . end;
def order: .kind as $k | ["Namespace","ServiceAccount","ConfigMap","Secret","Service","Deployment","GatewayParameters",
  "GatewayExtension","Backend","DirectResponse","Gateway","ListenerSet","ReferenceGrant","HTTPRoute",
  "GRPCRoute","TCPRoute","TLSRoute","UDPRoute","TrafficPolicy","ListenerPolicy","BackendConfigPolicy"]
  | (index($k) // 99);
'
JQ_EXPORT="${JQ_DEFS}"'[.items[] | select(excluded | not)]'
# Group objects into waves by original creation second, oldest first. Conflict
# resolution in Gateway API (for example two ListenerSets claiming one hostname)
# favors the oldest object, so replaying creation order reproduces the same winners.
JQ_WAVES="${JQ_DEFS}"'
[group_by(.metadata.creationTimestamp)[]
  | { created: .[0].metadata.creationTimestamp,
      items: (map(clean) | sort_by(.metadata.namespace, (. | order), .metadata.name)) }]
'

export_manifests() {
  command -v jq >/dev/null || die "jq is required for export"
  command -v yq >/dev/null || die "yq (mikefarah) is required for export"
  "${K[@]}" get ns >/dev/null || die "Cluster context ${CTX} not reachable"
  local types tmp n i
  types="$("${K[@]}" api-resources --verbs=list --namespaced -o name \
    | grep -vE '^(events|events\.events\.k8s\.io|endpoints|endpointslices\.discovery\.k8s\.io|pods|replicasets\.apps|controllerrevisions\.apps|leases\.coordination\.k8s\.io|pods\.metrics\.k8s\.io|jobs\.batch|csistoragecapacities\.storage\.k8s\.io)$' \
    | paste -sd, -)"
  tmp="$(mktemp -d)"
  log "Exporting namespaces: ${DEMO_NAMESPACES}"
  # shellcheck disable=SC2086
  "${K[@]}" get ns $DEMO_NAMESPACES -o json | jq "$JQ_EXPORT | map(clean)" | yq -p json -o yaml '.[] | split_doc' >"$tmp/00-namespaces.yaml"
  echo '[]' >"$tmp/all.json"
  for ns in $DEMO_NAMESPACES; do
    "${K[@]}" get "$types" -n "$ns" -o json | jq "$JQ_EXPORT" >"$tmp/ns.json"
    jq -s '.[0] + .[1]' "$tmp/all.json" "$tmp/ns.json" >"$tmp/merged.json" && mv "$tmp/merged.json" "$tmp/all.json"
  done
  jq "$JQ_WAVES" "$tmp/all.json" >"$tmp/waves.json"
  n="$(jq length "$tmp/waves.json")"
  for i in $(seq 0 $((n - 1))); do
    local out
    out="$tmp/$(printf '%02d' $((i + 1)))-wave.yaml"
    {
      echo "# Wave $((i + 1)) of ${n}: objects originally created at $(jq -r ".[$i].created" "$tmp/waves.json")."
      echo "# ./demo.sh up applies waves in order, one second apart, to keep the original creation order."
      jq ".[$i].items" "$tmp/waves.json" | yq -p json -o yaml '.[] | split_doc'
    } >"$out"
    echo "  $(basename "$out")  $(jq -r ".[$i].items | map(.metadata.namespace + \"/\" + .kind) | group_by(.) | map(\"\(length) \(.[0])\") | join(\", \")" "$tmp/waves.json")"
  done
  rm -f "$tmp"/*.json
  rm -rf "$ROOT/manifests"
  mv "$tmp" "$ROOT/manifests"
  log "Wrote manifests/ ($(find "$ROOT/manifests" -name '*.yaml' | wc -l | tr -d ' ') files)"
}

down() {
  log "Deleting kind cluster ${CLUSTER_NAME}"
  kind delete cluster --name "$CLUSTER_NAME"
}

case "${1:-}" in
  prereqs) prereqs ;;
  up) up ;;
  ui) ui ;;
  verify) verify ;;
  status) status ;;
  export) export_manifests ;;
  down) down ;;
  *) sed -n '5,14p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
