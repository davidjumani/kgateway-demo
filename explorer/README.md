# kgateway traffic explorer

A read-only page that draws what a kgateway user has in their cluster, one Gateway at a time:
listeners (from the Gateway and its ListenerSets), attached routes (including HTTPRoute delegation),
backends, and the TrafficPolicy, ListenerPolicy, BackendConfigPolicy and GatewayExtension objects
that apply to them. Click any box for its conditions and full YAML.

A request tracer animates how a request would flow: listener selection, route and rule selection by
Gateway API precedence, delegation, filters, policies applied at each hop, and the backend. The result
is an approximation computed in the browser from spec and controller-written status. It does not merge
policies or read Envoy config.

## Run

```bash
../demo.sh ui         # kubectl proxy serves this folder at http://127.0.0.1:8099/ui/
```

URL parameters:

- `gateway=<ns>/<name>` selects a Gateway on load. Default: `kgateway-system/http`, else any Gateway named `http`, else the first.
- `loop=0|5|10` sets the loop (default 10, `0` turns it off): after each trace ends, wait that many seconds, then trace the next route path (all ports and hosts).
- `open=<node id>` opens one node's details on load (for example `p:TrafficPolicy/httpbin/httpbin-headers`).
- `snapshot=<url>` loads a saved JSON dump instead of the live API (`{ "<Kind>": { "apiVersion", "items" } }`).

## Files

- `model.js`: data indexing, per-Gateway view, layout, tracer, YAML rendering. No DOM; runs in node.
- `app.js`: API discovery and fetch, FlowStory wiring, overlay with YAML.
- `images/logo*.svg`: kgateway logos from `kgateway-dev/kgateway.dev` (`static/`), same ones the kgateway README uses.
- `vendor/flowstory`: [noyitz/flowstory](https://github.com/noyitz/flowstory) at commit `9cac6a4` (Apache-2.0).

Visual style is inspired by [rikatz/gatewayapi-diagrams](https://www.rkatz.xyz/gatewayapi-diagrams/).
No code is copied from it (it has no license file).

## Limits (v1)

- Read-only. Load plus manual Refresh, no watches.
- Tracer: HTTP/HTTPS with hostname, path, method, header and query matching; TCP/TLS routes are
  forwarded to the first backend. No policy merge or precedence between multiple TrafficPolicies.
- Not shown yet: ReferenceGrant, BackendTLSPolicy, xDS.
