// Pure data logic for the kgateway traffic explorer: indexing cluster objects,
// building the per-Gateway view, laying it out, and tracing a request.
// No DOM access here so it can be unit-tested with plain node.

export const GW = 'gateway.networking.k8s.io';
export const KGW = 'gateway.kgateway.dev';
const DELEGATION_GROUP = 'delegation.kgateway.dev';
const DELEGATION_LABEL = 'delegation.kgateway.dev/label';

export const KINDS = [
  { kind: 'GatewayClass', group: GW, plural: 'gatewayclasses' },
  { kind: 'Gateway', group: GW, plural: 'gateways' },
  { kind: 'ListenerSet', group: GW, plural: 'listenersets' },
  { kind: 'HTTPRoute', group: GW, plural: 'httproutes' },
  { kind: 'GRPCRoute', group: GW, plural: 'grpcroutes' },
  { kind: 'TLSRoute', group: GW, plural: 'tlsroutes' },
  { kind: 'TCPRoute', group: GW, plural: 'tcproutes' },
  { kind: 'TrafficPolicy', group: KGW, plural: 'trafficpolicies' },
  { kind: 'ListenerPolicy', group: KGW, plural: 'listenerpolicies' },
  { kind: 'BackendConfigPolicy', group: KGW, plural: 'backendconfigpolicies' },
  { kind: 'GatewayExtension', group: KGW, plural: 'gatewayextensions' },
  { kind: 'Backend', group: KGW, plural: 'backends' },
  { kind: 'DirectResponse', group: KGW, plural: 'directresponses' },
  { kind: 'Service', group: '', plural: 'services' },
  { kind: 'EndpointSlice', group: 'discovery.k8s.io', plural: 'endpointslices' },
];

const ROUTE_KINDS = ['HTTPRoute', 'GRPCRoute', 'TLSRoute', 'TCPRoute'];
const ROUTE_PROTOCOLS = {
  HTTPRoute: ['HTTP', 'HTTPS'], GRPCRoute: ['HTTP', 'HTTPS'], TLSRoute: ['TLS'], TCPRoute: ['TCP'],
};
const POLICY_KINDS = ['TrafficPolicy', 'ListenerPolicy', 'BackendConfigPolicy'];

export const COLORS = {
  request: '#58a6ff', response: '#3fb950', listener: '#79c0ff', route: '#58a6ff',
  backend: '#56d4dd', policy: '#f0883e', extension: '#d2a8ff', infra: '#8b949e', error: '#f85149',
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const keyOf = (kind, ns, name) => `${kind}/${ns || ''}/${name}`;
export const objKey = o => keyOf(o.kind, o.metadata.namespace, o.metadata.name);
export const nsName = o => (o.metadata.namespace ? `${o.metadata.namespace}/` : '') + o.metadata.name;

// lists: { [kind]: { apiVersion, items } }
export function buildStore(lists) {
  const byKind = {};
  const byKey = new Map();
  for (const { kind } of KINDS) {
    const list = lists[kind];
    const items = (list?.items || []).map(item => ({ apiVersion: list.apiVersion, kind, ...item }));
    byKind[kind] = items;
    for (const item of items) byKey.set(objKey(item), item);
  }
  return { byKind, byKey, get: (kind, ns, name) => byKey.get(keyOf(kind, ns, name)) };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const findCond = (conds, type) => (conds || []).find(c => c.type === type);
const isTrue = c => c?.status === 'True';
const created = o => Date.parse(o.metadata.creationTimestamp || 0) || 0;

function refTargets(ref, fromNs, obj, defaultKind = 'Gateway') {
  return (ref.group ?? GW) === GW
    && (ref.kind ?? defaultKind) === obj.kind
    && ref.name === obj.metadata.name
    && (ref.namespace ?? fromNs) === obj.metadata.namespace;
}

export function hostMatches(pattern, host) {
  if (!pattern) return true;
  pattern = pattern.toLowerCase();
  host = host.toLowerCase();
  if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1;
  return pattern === host;
}

function hostsIntersect(a, b) {
  if (!a || !b) return true;
  if (!a.startsWith('*') && !b.startsWith('*')) return a.toLowerCase() === b.toLowerCase();
  if (a.startsWith('*') && !b.startsWith('*')) return hostMatches(a, b);
  if (b.startsWith('*') && !a.startsWith('*')) return hostMatches(b, a);
  const sa = a.slice(1).toLowerCase(), sb = b.slice(1).toLowerCase();
  return sa.endsWith(sb) || sb.endsWith(sa);
}

// 0 = no hostname constraint, otherwise higher is more specific.
function hostSpecificity(pattern) {
  if (!pattern) return 0;
  return pattern.startsWith('*') ? 1 + pattern.length / 1000 : 2;
}

export function policyFeatures(policy) {
  return Object.keys(policy.spec || {}).filter(k => k !== 'targetRefs' && k !== 'targetSelectors');
}

function labelsMatch(selector, labels) {
  return Object.entries(selector || {}).every(([k, v]) => (labels || {})[k] === v);
}

function backendRefKind(ref) {
  const group = ref.group ?? '';
  const kind = ref.kind ?? 'Service';
  if (group === DELEGATION_GROUP && kind === 'label') return 'delegate-label';
  if (group === GW && kind === 'HTTPRoute') return 'delegate';
  if (group === '' && kind === 'Service') return 'Service';
  if (group === KGW && kind === 'Backend') return 'Backend';
  return `${group || 'core'}/${kind}`;
}

// ---------------------------------------------------------------------------
// View for one Gateway
// ---------------------------------------------------------------------------

export function buildView(store, gw) {
  const gwNs = gw.metadata.namespace;
  const view = {
    gateway: gw,
    gatewayClass: store.get('GatewayClass', undefined, gw.spec.gatewayClassName),
    parents: [], // [{ obj, nodeId, accepted, cond }]
    listeners: [],
    routes: new Map(), // nodeId -> { obj, depth, accepted, attachments }
    attachments: [], // { routeId, parentId, listenerIds, accepted, cond, sectionName }
    delegations: [], // { fromId, toId, accepted, cond, ruleIndex }
    backends: new Map(), // nodeId -> { kind, ns, name, obj, missing, refs }
    backendEdges: [], // { fromId, toId, port, weight, ruleIndex }
    policies: new Map(), // nodeId -> { obj, status }
    policyEdges: [], // { fromId, toId, sectionName }
    extensions: new Map(),
    extensionEdges: [],
  };

  // Parents: the Gateway itself and every ListenerSet pointing at it.
  view.parents.push({ obj: gw, nodeId: 'gw', accepted: isTrue(findCond(gw.status?.conditions, 'Accepted')), cond: findCond(gw.status?.conditions, 'Accepted') });
  for (const ls of store.byKind.ListenerSet) {
    const ref = ls.spec?.parentRef;
    if (!ref || !refTargets(ref, ls.metadata.namespace, gw)) continue;
    const cond = findCond(ls.status?.conditions, 'Accepted');
    view.parents.push({ obj: ls, nodeId: `ls:${nsName(ls)}`, accepted: isTrue(cond), cond });
  }
  view.parents.sort((a, b) => (a.obj === gw ? -1 : b.obj === gw ? 1 : created(a.obj) - created(b.obj)));

  for (const parent of view.parents) {
    const statusByName = Object.fromEntries((parent.obj.status?.listeners || []).map(l => [l.name, l]));
    for (const l of parent.obj.spec?.listeners || []) {
      view.listeners.push({
        id: `l:${parent.nodeId}:${l.name}`, parentId: parent.nodeId, parent, spec: l,
        name: l.name, port: l.port, protocol: l.protocol, hostname: l.hostname,
        status: statusByName[l.name],
        usable: parent.accepted,
      });
    }
  }
  const listenersOf = parentId => view.listeners.filter(l => l.parentId === parentId);

  // Route attachments, from both spec.parentRefs and controller-written status.
  for (const kind of ROUTE_KINDS) {
    for (const route of store.byKind[kind]) {
      const rns = route.metadata.namespace;
      for (const parent of view.parents) {
        const refs = new Map();
        for (const ref of route.spec?.parentRefs || []) {
          if (refTargets(ref, rns, parent.obj)) refs.set(`${ref.sectionName || ''}:${ref.port || ''}`, { ref });
        }
        for (const st of route.status?.parents || []) {
          if (!refTargets(st.parentRef, rns, parent.obj)) continue;
          const id = `${st.parentRef.sectionName || ''}:${st.parentRef.port || ''}`;
          refs.set(id, { ref: st.parentRef, status: st });
        }
        for (const { ref, status } of refs.values()) {
          const cond = findCond(status?.conditions, 'Accepted');
          const accepted = isTrue(cond);
          let candidates = listenersOf(parent.nodeId).filter(l =>
            (!ref.sectionName || l.name === ref.sectionName) && (!ref.port || l.port === ref.port));
          const compatible = candidates.filter(l =>
            ROUTE_PROTOCOLS[kind].includes(l.protocol)
            && (route.spec?.hostnames || [undefined]).some(h => hostsIntersect(l.hostname, h)));
          if (compatible.length || !accepted) candidates = compatible;
          const routeId = `r:${objKey(route)}`;
          if (!view.routes.has(routeId)) view.routes.set(routeId, { id: routeId, obj: route, depth: 0, accepted: false, attachments: [] });
          const entry = view.routes.get(routeId);
          entry.accepted ||= accepted;
          const att = {
            routeId, parentId: parent.nodeId, listenerIds: candidates.map(l => l.id), accepted, cond,
            resolvedRefs: findCond(status?.conditions, 'ResolvedRefs'),
            sectionName: ref.sectionName, port: ref.port, status,
          };
          entry.attachments.push(att);
          view.attachments.push(att);
        }
      }
    }
  }

  // Delegation (kgateway HTTPRoute delegation), breadth first.
  const queue = [...view.routes.values()].filter(r => r.obj.kind === 'HTTPRoute');
  while (queue.length) {
    const parentEntry = queue.shift();
    const parentRoute = parentEntry.obj;
    (parentRoute.spec?.rules || []).forEach((rule, ruleIndex) => {
      for (const ref of rule.backendRefs || []) {
        const rk = backendRefKind(ref);
        if (rk !== 'delegate' && rk !== 'delegate-label') continue;
        for (const child of delegationChildren(store, parentRoute, ref)) {
          const childId = `r:${objKey(child.obj)}`;
          view.delegations.push({ fromId: parentEntry.id, toId: childId, accepted: child.accepted, cond: child.cond, ruleIndex });
          if (!view.routes.has(childId)) {
            const entry = { id: childId, obj: child.obj, depth: parentEntry.depth + 1, accepted: child.accepted, attachments: [] };
            view.routes.set(childId, entry);
            if (entry.depth < 6) queue.push(entry);
          } else {
            view.routes.get(childId).accepted ||= child.accepted;
          }
        }
      }
    });
  }

  // Backends.
  for (const entry of view.routes.values()) {
    const route = entry.obj;
    (route.spec?.rules || []).forEach((rule, ruleIndex) => {
      for (const ref of rule.backendRefs || []) {
        const rk = backendRefKind(ref);
        if (rk === 'delegate' || rk === 'delegate-label') continue;
        const ns = ref.namespace ?? route.metadata.namespace;
        const id = `b:${rk}/${ns}/${ref.name}`;
        if (!view.backends.has(id)) {
          const obj = rk === 'Service' || rk === 'Backend' ? store.get(rk, ns, ref.name) : undefined;
          let readyEndpoints;
          if (rk === 'Service' && obj) {
            readyEndpoints = store.byKind.EndpointSlice
              .filter(es => es.metadata.namespace === ns && es.metadata.labels?.['kubernetes.io/service-name'] === ref.name)
              .flatMap(es => es.endpoints || [])
              .filter(e => e.conditions?.ready !== false).length;
          }
          view.backends.set(id, { id, kind: rk, ns, name: ref.name, obj, readyEndpoints, missing: !obj && (rk === 'Service' || rk === 'Backend') });
        }
        view.backendEdges.push({ fromId: entry.id, toId: id, port: ref.port, weight: ref.weight ?? 1, ruleIndex });
      }
    });
  }

  // Policies that target anything in this view.
  const targets = [
    ...view.parents.map(p => ({ obj: p.obj, id: p.nodeId })),
    ...[...view.routes.values()].map(r => ({ obj: r.obj, id: r.id })),
    ...[...view.backends.values()].filter(b => b.obj).map(b => ({ obj: b.obj, id: b.id })),
  ];
  for (const kind of POLICY_KINDS) {
    for (const policy of store.byKind[kind]) {
      const pns = policy.metadata.namespace;
      const edges = [];
      for (const t of targets) {
        if (t.obj.metadata.namespace !== pns) continue;
        const tGroup = t.obj.kind === 'Service' ? '' : t.obj.apiVersion.includes('/') ? t.obj.apiVersion.split('/')[0] : '';
        for (const ref of policy.spec?.targetRefs || []) {
          if ((ref.group ?? '') === tGroup && ref.kind === t.obj.kind && ref.name === t.obj.metadata.name) {
            edges.push({ toId: t.id, sectionName: ref.sectionName });
          }
        }
        for (const sel of policy.spec?.targetSelectors || []) {
          if ((sel.group ?? '') === tGroup && sel.kind === t.obj.kind && labelsMatch(sel.matchLabels, t.obj.metadata.labels)) {
            edges.push({ toId: t.id, sectionName: sel.sectionName, selector: true });
          }
        }
      }
      if (!edges.length) continue;
      const id = `p:${objKey(policy)}`;
      view.policies.set(id, { id, obj: policy, status: policyStatus(policy, gw) });
      for (const e of edges) view.policyEdges.push({ fromId: id, ...e });

      // GatewayExtensions referenced anywhere in the policy spec.
      for (const ref of findExtensionRefs(policy.spec)) {
        const ns = ref.namespace ?? pns;
        const xid = `x:${ns}/${ref.name}`;
        if (!view.extensions.has(xid)) {
          view.extensions.set(xid, { id: xid, ns, name: ref.name, obj: store.get('GatewayExtension', ns, ref.name) });
        }
        view.extensionEdges.push({ fromId: id, toId: xid });
      }
    }
  }
  return view;
}

function delegationChildren(store, parentRoute, ref) {
  const ns = ref.namespace ?? parentRoute.metadata.namespace;
  const label = backendRefKind(ref) === 'delegate-label';
  const out = [];
  for (const child of store.byKind.HTTPRoute) {
    if (child === parentRoute || child.metadata.namespace !== ns) continue;
    if (label ? child.metadata.labels?.[DELEGATION_LABEL] !== ref.name : (ref.name !== '*' && ref.name !== child.metadata.name)) continue;
    const specRefs = child.spec?.parentRefs || [];
    if (specRefs.length && !specRefs.some(r => refTargets(r, ns, parentRoute, 'Gateway'))) continue;
    const st = (child.status?.parents || []).find(p => refTargets(p.parentRef, ns, parentRoute, 'Gateway'));
    const cond = findCond(st?.conditions, 'Accepted');
    out.push({ obj: child, accepted: isTrue(cond), cond });
  }
  return out;
}

function findExtensionRefs(value, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) { value.forEach(v => findExtensionRefs(v, out)); return out; }
  for (const [k, v] of Object.entries(value)) {
    if (k === 'extensionRef' && v?.name) out.push(v);
    else findExtensionRefs(v, out);
  }
  return out;
}

function policyStatus(policy, gw) {
  const ancestors = policy.status?.ancestors || [];
  const mine = ancestors.find(a => refTargets(a.ancestorRef, policy.metadata.namespace, gw))
    || ancestors.find(a => a.ancestorRef?.kind === 'StatusSummary')
    || ancestors[0];
  const accepted = findCond(mine?.conditions, 'Accepted');
  const attached = findCond(mine?.conditions, 'Attached');
  const ok = mine ? isTrue(accepted) && (!attached || isTrue(attached)) : null;
  return { ancestor: mine, accepted, attached, ok };
}

// ---------------------------------------------------------------------------
// Layout -> FlowStory nodes
// ---------------------------------------------------------------------------

const trunc = (s, n = 30) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function layout(view) {
  const nodes = {};
  const ROW = 74, NODE_H = 58;
  const policies = [...view.policies.values()];
  const extensions = [...view.extensions.values()];
  const extY = 110;
  const polY = extensions.length ? 200 : 110;
  const top = policies.length || extensions.length ? polY + 110 : 130;

  const clientX = 20, clientW = 110;
  const lsX = 175, lsW = 250;
  const listenerX = lsX + 10, listenerW = lsW - 20;
  const maxDepth = Math.max(-1, ...[...view.routes.values()].map(r => r.depth));
  const routeW = 240, colGap = 70;
  const routeX = depth => lsX + lsW + colGap + depth * (routeW + colGap);
  const backendX = routeX(maxDepth + 1);
  const backendW = 220;

  // Listener column: one container per parent (Gateway, then ListenerSets).
  let y = top;
  for (const parent of view.parents) {
    const ls = view.listeners.filter(l => l.parentId === parent.nodeId);
    const h = 34 + Math.max(1, ls.length) * (NODE_H + 10) + 4;
    const isGw = parent.nodeId === 'gw';
    nodes[parent.nodeId] = {
      x: lsX, y, w: lsW, h, type: 'container', inner: true,
      label: `${isGw ? 'Gateway' : 'ListenerSet'} ${trunc(nsName(parent.obj), 28)}`,
      color: parent.accepted ? (isGw ? COLORS.listener : COLORS.extension) : COLORS.error,
      fontSize: 12,
    };
    ls.forEach((l, i) => {
      nodes[l.id] = {
        x: listenerX, y: y + 30 + i * (NODE_H + 10), w: listenerW, h: NODE_H,
        label: trunc(l.name, 26),
        sublabel: trunc(`${l.protocol} :${l.port}${l.hostname ? ` · ${l.hostname}` : ''}`, 34),
        color: parent.accepted ? COLORS.listener : COLORS.error, fontSize: 14, inner: true,
      };
    });
    y += h + 16;
  }
  const centerY = id => nodes[id].y + nodes[id].h / 2;

  // Place a column of items by desired center, pushing down to avoid overlap.
  const placeColumn = (items, x, w) => {
    items.sort((a, b) => a.want - b.want);
    let next = top;
    for (const it of items) {
      const yy = Math.max(next, it.want - NODE_H / 2);
      nodes[it.id] = { x, y: yy, w, h: NODE_H, ...it.node };
      next = yy + ROW;
    }
  };

  const routes = [...view.routes.values()];
  for (let depth = 0; depth <= maxDepth; depth++) {
    const items = routes.filter(r => r.depth === depth).map(r => {
      let wants;
      if (depth === 0) {
        wants = r.attachments.flatMap(a => (a.listenerIds.length ? a.listenerIds : [a.parentId])).filter(id => nodes[id]).map(centerY);
      } else {
        wants = view.delegations.filter(d => d.toId === r.id && nodes[d.fromId]).map(d => centerY(d.fromId));
      }
      const want = wants.length ? wants.reduce((s, v) => s + v, 0) / wants.length : top;
      const ok = r.accepted;
      return {
        id: r.id, want,
        node: {
          label: trunc(r.obj.metadata.name, 28),
          sublabel: trunc(`${r.obj.kind} · ${r.obj.metadata.namespace}`, 34),
          color: ok ? COLORS.route : COLORS.error, fontSize: 14,
        },
      };
    });
    placeColumn(items, routeX(depth), routeW);
  }

  const bItems = [...view.backends.values()].map(b => {
    const wants = view.backendEdges.filter(e => e.toId === b.id && nodes[e.fromId]).map(e => centerY(e.fromId));
    return {
      id: b.id, want: wants.length ? wants.reduce((s, v) => s + v, 0) / wants.length : top,
      node: {
        label: trunc(b.name, 26),
        sublabel: trunc(`${b.kind} · ${b.ns}${b.missing ? ' · MISSING' : b.readyEndpoints === 0 ? ' · 0 ready' : b.readyEndpoints ? ` · ${b.readyEndpoints} ready` : ''}`, 34),
        color: b.missing || b.readyEndpoints === 0 ? COLORS.error : COLORS.backend, fontSize: 14,
      },
    };
  });
  placeColumn(bItems, backendX, backendW);

  // Policy and extension bands across the top, placed near their targets.
  const placeRow = (items, rowY, w) => {
    items.sort((a, b) => a.want - b.want);
    let next = lsX;
    for (const it of items) {
      const xx = Math.max(next, it.want - w / 2);
      nodes[it.id] = { x: xx, y: rowY, w, h: 56, ...it.node };
      next = xx + w + 14;
    }
  };
  const centerX = id => nodes[id].x + nodes[id].w / 2;
  placeRow(policies.map(p => {
    const xs = view.policyEdges.filter(e => e.fromId === p.id && nodes[e.toId]).map(e => centerX(e.toId));
    return {
      id: p.id, want: xs.length ? Math.min(...xs) : lsX,
      node: {
        label: trunc(p.obj.metadata.name, 24), sublabel: trunc(`${p.obj.kind} · ${p.obj.metadata.namespace}`, 30),
        color: p.status.ok === false ? COLORS.error : COLORS.policy, fontSize: 13, type: 'plugin',
      },
    };
  }), polY, 200);
  placeRow(extensions.map(x => {
    const xs = view.extensionEdges.filter(e => e.toId === x.id && nodes[e.fromId]).map(e => centerX(e.fromId));
    return {
      id: x.id, want: xs.length ? Math.min(...xs) : lsX,
      node: {
        label: trunc(x.name, 24), sublabel: trunc(`GatewayExtension · ${x.ns}${x.obj ? '' : ' · MISSING'}`, 32),
        color: x.obj ? COLORS.extension : COLORS.error, fontSize: 13, type: 'plugin',
      },
    };
  }), extY, 200);

  const gwNode = nodes.gw;
  nodes.client = { x: clientX, y: gwNode.y + Math.min(gwNode.h, 120) / 2 - 30, w: clientW, h: 60, label: 'Client', type: 'icon', color: COLORS.infra };

  let width = 0, height = 0;
  for (const n of Object.values(nodes)) {
    width = Math.max(width, n.x + n.w);
    height = Math.max(height, n.y + n.h);
  }
  width += 40;
  height += 50;
  nodes.cluster = {
    x: lsX - 20, y: 70, w: width - lsX, h: height - 82, type: 'boundary',
    label: `Kubernetes cluster · Gateway ${nsName(view.gateway)}`, color: COLORS.infra, labelAlign: 'left',
  };
  return { nodes, width: Math.max(width, 900), height: Math.max(height, 560) };
}

// Static edges drawn under the nodes: [fromId, toId, color, kind]
export function staticEdges(view) {
  const edges = [];
  for (const a of view.attachments) {
    const targets = a.listenerIds.length ? a.listenerIds : [a.parentId];
    for (const t of targets) edges.push([t, a.routeId, a.accepted ? COLORS.infra : COLORS.error, 'h']);
  }
  for (const d of view.delegations) edges.push([d.fromId, d.toId, d.accepted ? COLORS.infra : COLORS.error, 'h']);
  const seen = new Set();
  for (const e of view.backendEdges) {
    const k = `${e.fromId}>${e.toId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    edges.push([e.fromId, e.toId, view.backends.get(e.toId).missing ? COLORS.error : COLORS.infra, 'h']);
  }
  for (const e of view.policyEdges) edges.push([e.fromId, e.toId, COLORS.policy, 'v']);
  for (const e of view.extensionEdges) edges.push([e.fromId, e.toId, COLORS.extension, 'v']);
  return edges;
}

// ---------------------------------------------------------------------------
// Request tracer
// ---------------------------------------------------------------------------

export function parseRequest({ scheme, host, port, method, path, headers }) {
  const [rawPath, rawQuery = ''] = (path || '/').split('?');
  const query = new URLSearchParams(rawQuery);
  const hdrs = {};
  for (const line of (headers || '').split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) hdrs[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return {
    scheme: scheme || 'http', host: (host || '').trim().replace(/:\d+$/, ''), port: Number(port) || (scheme === 'https' ? 443 : 80),
    method: (method || 'GET').toUpperCase(), path: rawPath.startsWith('/') ? rawPath : `/${rawPath}`, rawQuery, query, headers: hdrs,
  };
}

function strMatch(type, expected, actual) {
  if (actual === undefined || actual === null) return false;
  if (type === 'RegularExpression') {
    try { return new RegExp(`^(?:${expected})$`).test(actual); } catch { return false; }
  }
  return expected === actual;
}

// Returns null if no match, else a precedence tuple (higher wins).
function scoreHTTPMatch(match, req) {
  const p = match.path || { type: 'PathPrefix', value: '/' };
  let pathRank, pathLen = 0;
  if (p.type === 'Exact') {
    if (req.path !== p.value) return null;
    pathRank = 3; pathLen = p.value.length;
  } else if (p.type === 'RegularExpression') {
    if (!strMatch('RegularExpression', p.value, req.path)) return null;
    pathRank = 1;
  } else {
    const v = p.value.replace(/\/+$/, '');
    if (!(v === '' || req.path === v || req.path.startsWith(`${v}/`))) return null;
    pathRank = 2; pathLen = v.length;
  }
  if (match.method && match.method !== req.method) return null;
  for (const h of match.headers || []) {
    if (!strMatch(h.type, h.value, req.headers[h.name.toLowerCase()])) return null;
  }
  for (const q of match.queryParams || []) {
    if (!strMatch(q.type, q.value, req.query.get(q.name))) return null;
  }
  return [pathRank, pathLen, match.method ? 1 : 0, (match.headers || []).length, (match.queryParams || []).length];
}

function scoreGRPCMatch(match, req) {
  const m = match.method || {};
  const [, service, method] = req.path.split('/');
  if (m.service && !strMatch(m.type, m.service, service)) return null;
  if (m.method && !strMatch(m.type, m.method, method)) return null;
  for (const h of match.headers || []) {
    if (!strMatch(h.type, h.value, req.headers[h.name.toLowerCase()])) return null;
  }
  return [m.service ? 3 : 0, m.method ? 1 : 0, 0, (match.headers || []).length, 0];
}

function cmpTuple(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

const describeMatch = (route, m) => {
  if (!m) return 'all requests';
  if (route.kind === 'GRPCRoute') return `method ${m.method?.service || '*'}/${m.method?.method || '*'}`;
  const p = m.path || { type: 'PathPrefix', value: '/' };
  const parts = [`${p.type} ${p.value}`];
  if (m.method) parts.push(m.method);
  for (const h of m.headers || []) parts.push(`header ${h.name}=${h.value}`);
  for (const q of m.queryParams || []) parts.push(`query ${q.name}=${q.value}`);
  return parts.join(', ');
};

// Pick the best (route, rule, match) among candidates per Gateway API precedence.
function selectRule(routes, req, listenerHost) {
  const cands = [];
  for (const route of routes) {
    let hostSpec = 0;
    const hostnames = route.spec?.hostnames || [];
    if (hostnames.length) {
      const hit = hostnames.filter(h => hostMatches(h, req.host));
      if (!hit.length) continue;
      hostSpec = Math.max(...hit.map(hostSpecificity));
    } else {
      hostSpec = hostSpecificity(listenerHost) / 10;
    }
    (route.spec?.rules || []).forEach((rule, ruleIndex) => {
      const matches = rule.matches?.length ? rule.matches : [null];
      for (const m of matches) {
        const score = route.kind === 'GRPCRoute' ? scoreGRPCMatch(m || {}, req) : scoreHTTPMatch(m || {}, req);
        if (!score) continue;
        cands.push({ route, rule, ruleIndex, match: m, score: [hostSpec, ...score] });
      }
    });
  }
  cands.sort((a, b) =>
    cmpTuple(b.score, a.score)
    || created(a.route) - created(b.route)
    || nsName(a.route).localeCompare(nsName(b.route))
    || a.ruleIndex - b.ruleIndex);
  return { best: cands[0], count: cands.length };
}

// Builds FlowStory steps + inspector mutations for one request.
export function trace(view, input) {
  const req = parseRequest(input);
  const steps = [];
  const mutations = [];
  let num = 0;
  const reqHeaders = [
    { value: `${req.method} ${req.path}${req.rawQuery ? `?${req.rawQuery}` : ''} HTTP/1.1`, style: 'keep', id: 'rl' },
    { value: `Host: ${req.host}`, style: 'keep', id: 'host' },
    ...Object.entries(req.headers).map(([k, v]) => ({ value: `${k}: ${v}`, style: 'keep', id: `h-${k}` })),
  ];
  const arrow = (text, from, to, color = COLORS.request, extra = {}) =>
    steps.push({ text, mode: 'arrow', from, to, color, num: ++num, fromRight: true, toLeft: true, ...extra });
  const back = (text, from, to, extra = {}) =>
    steps.push({ text, mode: 'arrow', from, to, color: COLORS.response, num: ++num, fromLeft: true, toRight: true, yOff: 12, ...extra });
  const light = (text, target, badge = '✓', err = false) =>
    steps.push({ text, mode: 'lightup', target, badge, ...(err ? { errColor: COLORS.error } : {}) });
  const mutate = m => mutations.push({ step: steps.length, ...m });
  // Hops the request has passed through; the response walks them back in reverse.
  const hops = [];
  const enter = (id, label) => hops.push({ id, label, adds: [] });
  const top = () => hops[hops.length - 1];
  let rid = 0;
  const unwind = (status, err = false, extra = []) => {
    const color = err ? COLORS.error : COLORS.response;
    const chain = [...hops].reverse();
    const statusLine = { value: `HTTP/1.1 ${status}`, style: err ? 'err' : 'add', id: 'status' };
    chain.forEach((hop, i) => {
      const next = chain[i + 1];
      const adds = next?.adds || [];
      const note = adds.length ? `; ${next.label} adds ${adds.map(a => a.value.split(':')[0]).join(', ')}` : '';
      const text = i === 0
        ? `${hop.label} sends ${status} back to ${next ? next.label : 'the client'}${note}.`
        : next ? `Response passes back from ${hop.label} to ${next.label}${note}.` : `Client receives HTTP ${status}.`;
      back(text, hop.id, next ? next.id : 'client', { color });
      if (i === 0) {
        mutate({ label: `Response ${status} from ${hop.label}`, phase: 'response', replaceHeaders: [statusLine, ...extra, ...hop.adds, ...adds] });
      } else if (adds.length) {
        mutate({ label: `${next.label} edits the response`, actions: adds.map(a => ({ action: 'add', target: 'headers', value: a.value, id: a.id, style: 'add' })) });
      }
    });
  };
  const result = { steps, mutations, initialHeaders: reqHeaders, verdict: '', ok: false };
  const policiesOn = (targetId, sectionFilter) => view.policyEdges
    .filter(e => e.toId === targetId && (!e.sectionName || !sectionFilter || sectionFilter(e.sectionName)))
    .map(e => view.policies.get(e.fromId));
  const applyPolicies = (targetId, where, sectionFilter, outAdds) => {
    for (const p of policiesOn(targetId, sectionFilter)) {
      const feats = policyFeatures(p.obj).join(', ') || 'no settings';
      const bad = p.status.ok === false;
      const why = bad ? ` (NOT applied: ${p.status.attached?.reason || p.status.accepted?.reason || 'not accepted'})` : '';
      light(`${p.obj.kind} ${nsName(p.obj)} on ${where}: ${feats}${why}`, p.id, 'P', bad);
      if (!bad) {
        headerChanges(p.obj.spec?.headerModifiers?.request, p.obj.spec?.transformation?.request, `${p.obj.kind} ${p.obj.metadata.name}`);
        collectResponseHeaders(p.obj.spec?.headerModifiers?.response, p.obj.spec?.transformation?.response, outAdds);
      }
    }
  };
  const headerChanges = (mod, xform, label) => {
    const actions = [];
    for (const h of [...(mod?.set || []), ...(xform?.set || [])]) actions.push({ action: 'add', target: 'headers', value: `${h.name}: ${h.value}`, id: `set-${h.name}-${actions.length}`, style: 'add' });
    for (const h of [...(mod?.add || []), ...(xform?.add || [])]) actions.push({ action: 'add', target: 'headers', value: `${h.name}: ${h.value}`, id: `add-${h.name}-${actions.length}`, style: 'add' });
    for (const name of mod?.remove || []) {
      const id = `h-${name.toLowerCase()}`;
      if (req.headers[name.toLowerCase()] !== undefined) actions.push({ id, style: 'del' });
    }
    if (actions.length) mutate({ label, actions });
  };
  const collectResponseHeaders = (mod, xform, out) => {
    for (const h of [...(mod?.set || []), ...(mod?.add || []), ...(xform?.set || []), ...(xform?.add || [])]) {
      out.push({ value: `${h.name}: ${h.value}`, style: 'add', id: `r-${h.name}-${++rid}` });
    }
  };

  // 1. Listener selection.
  const wantProtocols = req.scheme === 'https' ? ['HTTPS', 'TLS'] : ['HTTP', 'TCP'];
  const listeners = view.listeners
    .filter(l => l.usable && l.port === req.port && wantProtocols.includes(l.protocol) && hostMatches(l.hostname, req.host || 'unknown'))
    .sort((a, b) => hostSpecificity(b.hostname) - hostSpecificity(a.hostname) || (a.parentId === 'gw' ? -1 : 0) - (b.parentId === 'gw' ? -1 : 0));
  const listener = listeners[0];
  if (!listener) {
    const onPort = view.listeners.filter(l => l.port === req.port);
    arrow(`${req.scheme.toUpperCase()} request for ${req.host}:${req.port} reaches Gateway ${nsName(view.gateway)}`, 'client', 'gw', COLORS.error);
    const why = onPort.length
      ? `listeners on :${req.port} (${onPort.map(l => `${l.name} ${l.protocol}${l.hostname ? ` ${l.hostname}` : ''}${l.usable ? '' : ' [parent not accepted]'}`).join('; ')}) do not accept this scheme/host`
      : `no listener on port ${req.port}`;
    enter('gw', `Gateway ${view.gateway.metadata.name}`);
    light(`No listener matches: ${why}. Envoy has no filter chain, so the connection is refused or gets 404.`, 'gw', '✗', true);
    unwind(404, true);
    result.verdict = `No listener matches (${why}).`;
    return result;
  }
  arrow(`${req.scheme.toUpperCase()} ${req.method} ${req.host}${req.path} on :${req.port} is accepted by listener "${listener.name}" (${listener.protocol}${listener.hostname ? `, hostname ${listener.hostname}` : ', any hostname'}) of ${listener.parentId === 'gw' ? 'Gateway' : 'ListenerSet'} ${nsName(listener.parent.obj)}.`, 'client', listener.id);
  enter(listener.id, `listener "${listener.name}"`);
  applyPolicies('gw', `Gateway ${view.gateway.metadata.name}`, s => s === listener.name, top().adds);
  if (listener.parentId !== 'gw') applyPolicies(listener.parentId, `ListenerSet ${listener.parent.obj.metadata.name}`, s => s === listener.name, top().adds);

  // 2. Route selection among routes attached to this listener.
  const attached = view.attachments.filter(a => a.accepted && a.listenerIds.includes(listener.id)).map(a => view.routes.get(a.routeId).obj);
  const unique = [...new Set(attached)];
  if (listener.protocol === 'TCP' || listener.protocol === 'TLS') {
    const route = unique.find(r => (r.kind === 'TCPRoute' || r.kind === 'TLSRoute') && (r.spec?.hostnames || [undefined]).some(h => hostMatches(h, req.host)));
    if (!route) {
      light(`No ${listener.protocol === 'TLS' ? 'TLSRoute' : 'TCPRoute'} attached to this listener matches; connection closed.`, listener.id, '✗', true);
      result.verdict = 'No L4 route matches.';
      return result;
    }
    const l4id = `r:${objKey(route)}`;
    arrow(`${route.kind} ${nsName(route)} forwards the raw stream (no HTTP matching on L4 routes).`, listener.id, l4id);
    enter(l4id, `${route.kind} ${route.metadata.name}`);
    return finishBackend(route, route.spec?.rules?.[0] || {}, l4id, 0);
  }
  const httpRoutes = unique.filter(r => r.kind === 'HTTPRoute' || r.kind === 'GRPCRoute');
  const { best, count } = selectRule(httpRoutes, req, listener.hostname);
  if (!best) {
    light(`${httpRoutes.length} route(s) attached to "${listener.name}", none match ${req.method} ${req.host}${req.path}. Envoy returns 404 Not Found.`, listener.id, '404', true);
    unwind(404, true);
    result.verdict = `404: no route on listener "${listener.name}" matches.`;
    return result;
  }
  let current = best;
  let currentId = `r:${objKey(best.route)}`;
  arrow(`${best.route.kind} ${nsName(best.route)} rule #${best.ruleIndex + 1}${best.rule.name ? ` "${best.rule.name}"` : ''} wins (${describeMatch(best.route, best.match)})${count > 1 ? `, out of ${count} matching rule(s) by precedence` : ''}.`, listener.id, currentId);
  enter(currentId, `${best.route.kind} ${best.route.metadata.name}`);

  // 3. Delegation chain.
  for (let depth = 0; depth < 6; depth++) {
    applyPolicies(currentId, `${current.route.kind} ${current.route.metadata.name}`, s => s === current.rule.name, top().adds);
    const stop = applyFilters(current, currentId);
    if (stop) return stop;
    const delegated = (current.rule.backendRefs || []).some(r => ['delegate', 'delegate-label'].includes(backendRefKind(r)));
    if (!delegated) break;
    const children = view.delegations.filter(d => d.fromId === currentId && d.ruleIndex === current.ruleIndex && d.accepted)
      .map(d => view.routes.get(d.toId).obj);
    const parentMatch = current.match?.path;
    const { best: child } = selectRule(children.filter(c => c.kind === 'HTTPRoute'), req, listener.hostname);
    if (!child || (parentMatch && child.match?.path && parentMatch.type === 'PathPrefix' && !child.match.path.value.startsWith(parentMatch.value))) {
      light(`Delegated to ${children.length} child route(s); none match ${req.path}. Envoy returns 404.`, currentId, '404', true);
      unwind(404, true);
      result.verdict = '404: delegated, but no child route matches.';
      return result;
    }
    const childId = `r:${objKey(child.route)}`;
    arrow(`Delegated to child HTTPRoute ${nsName(child.route)} rule #${child.ruleIndex + 1} (${describeMatch(child.route, child.match)}).`, currentId, childId);
    enter(childId, `HTTPRoute ${child.route.metadata.name}`);
    current = child;
    currentId = childId;
  }
  return finishBackend(current.route, current.rule, currentId, current.ruleIndex);

  function applyFilters(sel, nodeId) {
    for (const f of sel.rule.filters || []) {
      if (f.type === 'RequestHeaderModifier') {
        light(`Filter RequestHeaderModifier rewrites request headers.`, nodeId, 'F');
        headerChanges(f.requestHeaderModifier, null, 'RequestHeaderModifier');
      } else if (f.type === 'ResponseHeaderModifier') {
        light(`Filter ResponseHeaderModifier will edit response headers.`, nodeId, 'F');
        collectResponseHeaders(f.responseHeaderModifier, null, top().adds);
      } else if (f.type === 'URLRewrite') {
        const rw = f.urlRewrite || {};
        let newPath = req.path;
        if (rw.path?.type === 'ReplaceFullPath') newPath = rw.path.replaceFullPath;
        if (rw.path?.type === 'ReplacePrefixMatch' && sel.match?.path?.value) {
          newPath = (rw.path.replacePrefixMatch.replace(/\/$/, '') + req.path.slice(sel.match.path.value.replace(/\/$/, '').length)) || '/';
        }
        light(`Filter URLRewrite: path ${req.path} -> ${newPath}${rw.hostname ? `, host -> ${rw.hostname}` : ''}.`, nodeId, 'F');
        const actions = [{ id: 'rl', style: 'del' }, { action: 'add', target: 'headers', value: `${req.method} ${newPath} HTTP/1.1`, id: 'rl2', style: 'add' }];
        if (rw.hostname) actions.push({ id: 'host', style: 'del' }, { action: 'add', target: 'headers', value: `Host: ${rw.hostname}`, id: 'host2', style: 'add' });
        mutate({ label: 'URLRewrite', actions });
      } else if (f.type === 'RequestRedirect') {
        const rr = f.requestRedirect || {};
        const code = rr.statusCode || 302;
        const loc = `${rr.scheme || req.scheme}://${rr.hostname || req.host}${rr.port ? `:${rr.port}` : ''}${rr.path?.replaceFullPath || req.path}`;
        light(`Filter RequestRedirect: Gateway answers ${code} itself, no backend call.`, nodeId, String(code));
        unwind(code, false, [{ value: `Location: ${loc}`, style: 'add', id: 'loc' }]);
        result.verdict = `${code} redirect to ${loc} (${nsName(sel.route)}).`;
        result.ok = true;
        return result;
      } else if (f.type === 'RequestMirror') {
        light(`Filter RequestMirror copies the request to ${f.requestMirror?.backendRef?.name} (response ignored).`, nodeId, 'F');
      } else if (f.type === 'ExtensionRef') {
        const ref = f.extensionRef || {};
        light(`Filter ExtensionRef ${ref.kind} ${ref.name}${ref.kind === 'DirectResponse' ? ': Gateway returns a fixed response, no backend call.' : '.'}`, nodeId, 'F');
        if (ref.kind === 'DirectResponse') {
          unwind(`(DirectResponse ${ref.name})`);
          result.verdict = `DirectResponse ${ref.name} from ${nsName(sel.route)}.`;
          result.ok = true;
          return result;
        }
      } else if (f.type === 'CORS') {
        light('Filter CORS adds CORS handling.', nodeId, 'F');
      }
    }
    return null;
  }

  function finishBackend(route, rule, nodeId, ruleIndex) {
    const refs = (rule.backendRefs || []).filter(r => !['delegate', 'delegate-label'].includes(backendRefKind(r)));
    const total = refs.reduce((s, r) => s + (r.weight ?? 1), 0);
    if (!refs.length || total === 0) {
      light(`Rule has no usable backendRefs. Envoy returns 500.`, nodeId, '500', true);
      unwind(500, true);
      result.verdict = '500: matched rule has no usable backend.';
      return result;
    }
    const chosen = [...refs].sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1))[0];
    const ns = chosen.namespace ?? route.metadata.namespace;
    const bid = `b:${backendRefKind(chosen)}/${ns}/${chosen.name}`;
    const backend = view.backends.get(bid);
    const split = refs.length > 1 ? ` Traffic split: ${refs.map(r => `${r.name} ${Math.round(100 * (r.weight ?? 1) / total)}%`).join(', ')}; showing the heaviest.` : '';
    const resolved = view.attachments.find(a => a.routeId === nodeId)?.resolvedRefs;
    if (backend?.missing || (resolved && resolved.status === 'False' && !view.delegations.some(d => d.toId === nodeId))) {
      arrow(`Forward to ${backend?.kind || ''} ${ns}/${chosen.name}${chosen.port ? `:${chosen.port}` : ''}.${split}`, nodeId, bid, COLORS.error);
      enter(bid, `${backend?.kind || 'backend'} ${chosen.name}`);
      light(`Backend unresolved${resolved?.message ? `: ${resolved.message}` : ' (object not found)'}. Envoy returns 500.`, bid, '500', true);
      unwind(500, true);
      result.verdict = `500: backend ${ns}/${chosen.name} unresolved.`;
      return result;
    }
    if (backend.readyEndpoints === 0) {
      arrow(`Forward to ${backend.kind} ${ns}/${chosen.name}${chosen.port ? `:${chosen.port}` : ''}.${split}`, nodeId, bid, COLORS.error);
      enter(bid, `${backend.kind} ${chosen.name}`);
      light('Service has 0 ready endpoints (EndpointSlices). Envoy returns 503 no healthy upstream.', bid, '503', true);
      unwind(503, true);
      result.verdict = `503: ${ns}/${chosen.name} has no ready endpoints.`;
      return result;
    }
    arrow(`Forward to ${backend.kind} ${ns}/${chosen.name}${chosen.port ? `:${chosen.port}` : ''}.${split}`, nodeId, bid);
    enter(bid, `${backend.kind} ${chosen.name}`);
    applyPolicies(bid, `${backend.kind} ${chosen.name}`, null, top().adds);
    unwind(200);
    result.verdict = `Routed via ${nsName(route)} rule #${ruleIndex + 1} to ${backend.kind} ${ns}/${chosen.name}.`;
    result.ok = true;
    return result;
  }
}

// Candidate requests built from route matches; the first one that routes cleanly wins.
export function sampleRequests(view) {
  const out = [];
  const seen = new Set();
  const pick = h => (h ? h.replace(/^\*\./, 'app.') : null);
  for (const a of view.attachments) {
    if (!a.accepted) continue;
    const route = view.routes.get(a.routeId).obj;
    if (route.kind !== 'HTTPRoute' && route.kind !== 'GRPCRoute') continue;
    for (const listener of view.listeners.filter(l => a.listenerIds.includes(l.id))) {
      const routeHosts = (route.spec?.hostnames || []).filter(h => hostMatches(listener.hostname, pick(h)));
      const hosts = routeHosts.length ? routeHosts.map(pick) : [pick(listener.hostname)];
      for (const host of hosts) {
        const base = { scheme: listener.protocol === 'HTTPS' ? 'https' : 'http', host: host || 'example.com', anyHost: !host, port: listener.port };
        const walk = (r, depth) => {
          for (const rule of r.spec?.rules || []) {
            const children = view.delegations.filter(d => d.fromId === `r:${objKey(r)}` && d.accepted);
            if (children.length && depth < 6) {
              for (const c of children) walk(view.routes.get(c.toId).obj, depth + 1);
              continue;
            }
            for (const m of rule.matches?.length ? rule.matches : [{}]) {
              let path;
              if (r.kind === 'GRPCRoute') path = `/${m.method?.service || 'svc'}/${m.method?.method || 'Method'}`;
              else if (m.path?.type === 'RegularExpression') continue;
              else path = m.path?.value || '/';
              const headers = (m.headers || []).filter(h => h.type !== 'RegularExpression').map(h => `${h.name}: ${h.value}`).join('\n');
              const queryParams = (m.queryParams || []).filter(q => q.type !== 'RegularExpression').map(q => `${q.name}=${q.value}`).join('&');
              const entry = { ...base, method: m.method && typeof m.method === 'string' ? m.method : r.kind === 'GRPCRoute' ? 'POST' : 'GET', path: queryParams ? `${path}?${queryParams}` : path, headers, route: nsName(r) };
              const k = JSON.stringify(entry);
              if (!seen.has(k)) { seen.add(k); out.push(entry); }
            }
          }
        };
        walk(route, 0);
      }
    }
  }
  return out;
}

export function sampleRequest(view) {
  const cands = sampleRequests(view);
  const good = cands.find(r => trace(view, r).ok);
  if (good || cands[0]) return good || cands[0];
  const l = view.listeners[0];
  return { scheme: l?.protocol === 'HTTPS' ? 'https' : 'http', host: l?.hostname?.replace(/^\*\./, 'app.') || 'example.com', port: l?.port || 80, method: 'GET', path: '/', headers: '' };
}

// ---------------------------------------------------------------------------
// YAML rendering (small, dependency-free)
// ---------------------------------------------------------------------------

export function cleanForYaml(obj) {
  const copy = structuredClone(obj);
  delete copy.metadata?.managedFields;
  if (copy.metadata?.annotations) {
    delete copy.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'];
    if (!Object.keys(copy.metadata.annotations).length) delete copy.metadata.annotations;
  }
  return copy;
}

const PLAIN = /^[A-Za-z0-9_./@][A-Za-z0-9_ ./@:,=+()-]*$/;
const RESERVED = /^(true|false|null|yes|no|on|off|~|-?\d+(\.\d+)?([eE][-+]?\d+)?)$/i;
function scalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  if (s === '' || !PLAIN.test(s) || RESERVED.test(s) || s.endsWith(' ') || s.includes(': ') || s.includes(' #')) return JSON.stringify(s);
  return s;
}

export function toYaml(value, indent = 0) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return value.map(item => {
      if (item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length) {
        const body = toYaml(item, indent + 2);
        return `${pad}- ${body.slice(indent + 2)}`;
      }
      if (Array.isArray(item) && item.length) return `${pad}-\n${toYaml(item, indent + 2)}`;
      return `${pad}- ${item && typeof item === 'object' ? (Array.isArray(item) ? '[]' : '{}') : scalar(item)}`;
    }).join('\n');
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) return '{}';
    return entries.map(([k, v]) => {
      const key = scalar(k);
      if (v && typeof v === 'object' && (Array.isArray(v) ? v.length : Object.keys(v).length)) {
        return `${pad}${key}:\n${toYaml(v, Array.isArray(v) ? indent : indent + 2)}`;
      }
      if (v && typeof v === 'object') return `${pad}${key}: ${Array.isArray(v) ? '[]' : '{}'}`;
      return `${pad}${key}: ${scalar(v)}`;
    }).join('\n');
  }
  return pad + scalar(value);
}
