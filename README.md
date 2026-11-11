# kgw-demo

Everything needed to stand up the kgateway demo environment from scratch: a kind cluster with
Gateway API, kgateway, the Snellius UI, a set of working and deliberately broken Gateway API
scenarios, and the kgateway traffic explorer.

It is an exact mirror of the `kind-kgw-demo` cluster it was exported from: same versions, same
objects, and the same creation order, so conflicts resolve the same way and every object ends up
with the same status conditions.

## Quick start

```bash
./demo.sh prereqs   # check tools (installs nothing)
./demo.sh up        # about 3 minutes on a laptop
./demo.sh ui        # keep running; Ctrl-C stops it
./demo.sh verify    # in another terminal: 10 request checks against Envoy
```

Then open:

| What | URL |
|------|-----|
| Traffic explorer | http://127.0.0.1:8099/ui/ |
| Snellius | http://127.0.0.1:8098/ |
| Gateway `kgateway-system/http` | `curl -H 'Host: www.example.com' http://127.0.0.1:8080/get` |

`./demo.sh down` deletes the cluster.

## Prerequisites

| Tool | Version | Install (macOS) | Install (Linux) |
|------|---------|-----------------|-----------------|
| Docker | running daemon | Docker Desktop | Docker Engine |
| kind | v0.32.0 (pinned) | `brew install kind` | `curl -Lo kind https://kind.sigs.k8s.io/dl/v0.32.0/kind-linux-amd64` |
| kubectl | >= v1.34 | `brew install kubectl` | https://kubernetes.io/docs/tasks/tools/ |
| helm | >= v4.0 | `brew install helm` | https://helm.sh/docs/intro/install/ |
| curl | any | preinstalled | distro package |
| jq, yq (mikefarah) | any | `brew install jq yq` | distro package / GitHub release |

`jq` and `yq` are only needed for `./demo.sh export`.

## What gets installed

All versions live in `versions.env`.

| Component | Version | Source |
|-----------|---------|--------|
| kind node | Kubernetes v1.36.1 | `kindest/node:v1.36.1@sha256:3489c767...` |
| Gateway API CRDs | v1.7.0, standard channel | `standard-install.yaml` from the GitHub release |
| kgateway | v2.5.1, default values | `oci://cr.kgateway.dev/kgateway-dev/charts/kgateway{-crds}` |
| Snellius | 0.5.1, default values, release `ui` in `snellius` | `oci://ghcr.io/duncandoyle/charts/snellius` |
| Demo backends | `mccutchen/go-httpbin:v2.15.0` | `manifests/` |

## Demo scenarios

Gateway `kgateway-system/http` (listener `http`, HTTP :8080) plus ListenerSets:

| Host / path | Result | Shows |
|-------------|--------|-------|
| `www.example.com/get` | 200 | HTTPRoute `httpbin/httpbin`, TrafficPolicy adds `x-demo` response header |
| `api.example.com/api/orders/*` | 200 | Delegation: `httpbin/api-parent` to child `team-b/api-orders`, URLRewrite |
| `api.example.com/api/x` | 404 | Delegation with no matching child (`team-b/api-misfit` is outside the parent prefix) |
| `a.example.com/v1/*` | 200 | ListenerSet `team-a`, URLRewrite, TrafficPolicy timeouts |
| `a.example.com/` + `x-canary: true` | 200 | Header match, RequestHeaderModifier |
| `b.example.com/` | 200 | ListenerSet `team-b` |
| `missing.example.com/` | 500 | Backend Service does not exist |
| `steal.example.com/` | 500 | Cross-namespace backendRef without a ReferenceGrant |
| `empty.example.com/` | 503 | Service with zero ready endpoints |

Broken on purpose (namespace `broken`):

- ListenerSets `clash` (hostname conflict with `team-a`, loses because it is newer), `proto-clash`,
  `tls-missing-cert`: not accepted.
- Gateway `broken-proxy`: GatewayParameters `bad-image` points at an image tag that does not exist
  (pod stays in ImagePullBackOff).
- Gateway `nack-demo` with HTTPRoute `bad-regex`: invalid regex path (`/items/([`) meant to trigger
  an Envoy config rejection (xDS NACK). The route itself still reports Accepted.
- HTTPRoute `orphan`: parent Gateway `does-not-exist`, so no status is written.
- HTTPRoute `wrong-listener`: `sectionName: https` on a Gateway without that listener
  (Accepted=False, NoMatchingParent).
- TrafficPolicy `dangling-policy`: targets a route that does not exist.
- Deployment `never-ready`: readiness probe never passes.

## Repository layout

```
demo.sh               single entrypoint: prereqs | up | ui | verify | status | export | down
versions.env          pinned versions, cluster name, local ports
kind/cluster.yaml     kind cluster shape (node image comes from versions.env)
manifests/
  00-namespaces.yaml  demo namespaces
  NN-wave.yaml        user-created objects, grouped by original creation time
explorer/             kgateway traffic explorer (static site served through kubectl proxy)
```

### Why waves

Gateway API conflict rules favor the oldest object. In the original cluster `team-a/team-a` was
created 11 seconds before `broken/clash`, so `team-a` owns `a.example.com`. `export` groups objects
by creation second, and `up` applies the groups in order with a one-second gap, so a rebuilt cluster
resolves conflicts the same way. Applying everything at once makes `clash` win instead.

## Refreshing the manifests

Change the source cluster, then:

```bash
./demo.sh export   # rewrites manifests/ from the current kind-kgw-demo cluster
```

`export` keeps only objects a person created. It drops controller- and Helm-managed objects
(proxy Deployments, the default GatewayClass, Helm release Secrets, `oauth2-hmac-secret`) and strips
status, uids, resourceVersions, managedFields and similar server-set fields.

## Overrides

Every setting in `versions.env` that reads `${VAR:-default}` can be overridden from the environment,
for example to run a second copy next to the first:

```bash
CLUSTER_NAME=kgw-demo-2 ./demo.sh up
CLUSTER_NAME=kgw-demo-2 EXPLORER_PORT=18099 SNELLIUS_PORT=18098 GATEWAY_PORT=18080 ./demo.sh ui
```

## Notes

- The explorer is read-only. It reads the cluster through `kubectl proxy` with the current kubeconfig
  credentials, so anyone who can reach the explorer port can read the cluster. It binds to 127.0.0.1.
- FlowStory (`explorer/vendor/flowstory`) is Apache-2.0, pinned at commit `9cac6a4`.
