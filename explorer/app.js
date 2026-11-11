import { FlowStory } from './vendor/flowstory/src/index.js';
import {
  KINDS, COLORS, buildStore, buildView, layout, staticEdges, trace, sampleRequest, sampleRequests,
  findCond, nsName, policyFeatures, toYaml, cleanForYaml,
} from './model.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
// API base: same origin by default (kubectl proxy --www). ?snapshot=<url> loads a saved dump instead.
const API = (params.get('api') || '').replace(/\/$/, '');

const ui = {
  gateway: $('kgw-gateway'), refresh: $('kgw-refresh'), status: $('kgw-status'),
  scheme: $('kgw-scheme'), host: $('kgw-host'), port: $('kgw-port'),
  portSel: $('kgw-port-sel'), hostSel: $('kgw-host-sel'), pathSel: $('kgw-path-sel'),
  hostRow: $('kgw-host-row'), pathRow: $('kgw-path-row'), loop: $('kgw-loop'),
  method: $('kgw-method'), path: $('kgw-path'), headers: $('kgw-headers'),
  trace: $('kgw-trace'), verdict: $('kgw-verdict'), speed: $('fs-speed'), reset: $('fs-reset'),
  theme: $('fs-theme'), empty: $('kgw-empty'), panelContent: $('fs-panel-content'),
  canvasHost: $('fs-canvas-host'), overlayHost: $('fs-overlay-host'),
};

let store = null;
let view = null;
let viz = null;
let isDark = !matchMedia('(prefers-color-scheme: light)').matches;
let loadSeq = 0;

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function getJSON(path) {
  const res = await fetch(API + path, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
  return res.json();
}

// Map plural -> groupVersion for a group, preferring the preferred version.
async function discover(group) {
  if (!group) return { '*': 'v1' };
  const g = await getJSON(`/apis/${group}`).catch(() => null);
  if (!g) return {};
  const versions = [g.preferredVersion, ...g.versions.filter(v => v.groupVersion !== g.preferredVersion?.groupVersion)];
  const out = {};
  for (const v of versions) {
    const res = await getJSON(`/apis/${v.groupVersion}`).catch(() => null);
    for (const r of res?.resources || []) if (!r.name.includes('/') && !out[r.name]) out[r.name] = v.groupVersion;
  }
  return out;
}

async function loadLive() {
  const groups = [...new Set(KINDS.map(k => k.group))];
  const found = Object.fromEntries(await Promise.all(groups.map(async g => [g, await discover(g)])));
  const lists = {};
  const missing = [];
  await Promise.all(KINDS.map(async k => {
    const gv = k.group ? found[k.group]?.[k.plural] : 'v1';
    if (!gv) { missing.push(k.kind); return; }
    const path = k.group ? `/apis/${gv}/${k.plural}` : `/api/v1/${k.plural}`;
    try {
      const list = await getJSON(path);
      lists[k.kind] = { apiVersion: gv, items: list.items || [] };
    } catch (e) {
      missing.push(`${k.kind} (${e.message})`);
    }
  }));
  return { lists, missing };
}

async function loadSnapshot(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} loading snapshot ${url}`);
  return { lists: await res.json(), missing: [] };
}

async function refresh() {
  setStatus('Loading cluster data...');
  ui.refresh.disabled = true;
  try {
    const snap = params.get('snapshot');
    const { lists, missing } = snap ? await loadSnapshot(snap) : await loadLive();
    store = buildStore(lists);
    const gws = store.byKind.Gateway.slice().sort((a, b) => nsName(a).localeCompare(nsName(b)));
    const prev = ui.gateway.value || params.get('gateway');
    ui.gateway.replaceChildren(...gws.map(g => new Option(`${nsName(g)}  (${g.spec.gatewayClassName})`, nsName(g))));
    const counts = ['Gateway', 'ListenerSet', 'HTTPRoute', 'GRPCRoute', 'TrafficPolicy']
      .map(k => `${store.byKind[k].length} ${k}`).join(', ');
    setStatus(`${snap ? 'Snapshot' : 'Live'} · ${new Date().toLocaleTimeString()}\n${counts}${missing.length ? `\nNot available: ${missing.join(', ')}` : ''}`);
    if (!gws.length) {
      showEmpty('No Gateways found in this cluster.');
      return;
    }
    // Default: URL ?gateway=, else a Gateway named "http" (kgateway-system first), else the first one.
    const fallback = gws.find(g => nsName(g) === 'kgateway-system/http') || gws.find(g => g.metadata.name === 'http') || gws[0];
    ui.gateway.value = gws.some(g => nsName(g) === prev) ? prev : nsName(fallback);
    selectGateway(true);
  } catch (e) {
    setStatus(`Could not read the Kubernetes API: ${e.message}`, true);
    showEmpty(`Could not reach the Kubernetes API.<br><br>Serve this page with<br><code>kubectl proxy --www=&lt;this dir&gt; --www-prefix=/ui/</code><br>then open <code>http://127.0.0.1:8001/ui/</code>`);
  } finally {
    ui.refresh.disabled = false;
  }
}

function setStatus(text, err = false) {
  ui.status.textContent = text;
  ui.status.className = err ? 'err' : '';
}

function showEmpty(html) {
  stopViz();
  ui.empty.innerHTML = html;
  ui.empty.style.display = 'flex';
}

// ---------------------------------------------------------------------------
// Gateway selection and tracing
// ---------------------------------------------------------------------------

function selectGateway(autoTrace) {
  const [ns, name] = ui.gateway.value.split('/');
  const gw = store.get('Gateway', ns, name);
  if (!gw) return;
  ui.empty.style.display = 'none';
  view = buildView(store, gw);
  catalog = sampleRequests(view);
  if (autoTrace) {
    const s = sampleRequest(view);
    fillPorts(s.port);
    fillHosts(s.host);
    fillPaths(catalog.findIndex(e => e.port === s.port && e.host === s.host && e.path === s.path && e.headers === s.headers));
  }
  runTrace();
}

// ---------------------------------------------------------------------------
// Cascading request pickers: port > host > path. Each has a "custom" escape hatch.
// ---------------------------------------------------------------------------

const CUSTOM = '__custom';
let catalog = [];

function fillPorts(want) {
  const byPort = new Map();
  for (const l of view.listeners) {
    if (!byPort.has(l.port)) byPort.set(l.port, []);
    byPort.get(l.port).push(l);
  }
  const opts = [...byPort.entries()].sort((a, b) => a[0] - b[0]).map(([port, ls]) =>
    Object.assign(new Option(`${port} · ${[...new Set(ls.map(l => l.protocol))].join('/')} · ${ls.length} listener${ls.length > 1 ? 's' : ''}${ls.some(l => l.usable) ? '' : ' (none accepted)'}`, String(port)),
      { title: ls.map(l => `${l.name} ${l.protocol}${l.hostname ? ` ${l.hostname}` : ''}${l.usable ? '' : ' (not accepted)'}`).join('\n') }));
  ui.portSel.replaceChildren(...opts, new Option('custom port...', CUSTOM));
  ui.portSel.value = byPort.has(Number(want)) ? String(want) : (opts[0]?.value ?? CUSTOM);
  onPortChange(false);
}

function onPortChange(cascade = true) {
  const custom = ui.portSel.value === CUSTOM;
  ui.port.hidden = !custom;
  if (!custom) {
    ui.port.value = ui.portSel.value;
    const ls = view.listeners.filter(l => l.port === Number(ui.portSel.value));
    if (ls.length && ls.every(l => l.protocol === 'HTTPS' || l.protocol === 'TLS')) ui.scheme.value = 'https';
    else if (ls.length) ui.scheme.value = 'http';
  }
  if (cascade) { fillHosts(); fillPaths(); }
}

function currentPort() { return Number(ui.portSel.value === CUSTOM ? ui.port.value : ui.portSel.value); }
function currentHost() { return ui.hostSel.value === CUSTOM ? ui.host.value.trim() : ui.hostSel.value; }

function fillHosts(want) {
  const port = currentPort();
  const hosts = new Map(); // host -> label
  for (const e of catalog.filter(e => e.port === port)) {
    if (!hosts.has(e.host)) hosts.set(e.host, `${e.host}${e.anyHost ? ' (any host)' : ''}`);
  }
  for (const l of view.listeners.filter(l => l.port === port && l.hostname)) {
    const h = l.hostname.replace(/^\*\./, 'app.');
    if (!hosts.has(h)) hosts.set(h, `${h} (listener ${l.name}, no routes)`);
  }
  const opts = [...hosts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([h, label]) => new Option(label, h));
  ui.hostSel.replaceChildren(...opts, new Option('custom host...', CUSTOM));
  ui.hostSel.value = want && hosts.has(want) ? want : (opts[0]?.value ?? CUSTOM);
  if (want && !hosts.has(want)) { ui.hostSel.value = CUSTOM; ui.host.value = want; }
  ui.hostRow.hidden = ui.hostSel.value !== CUSTOM;
}

function fillPaths(wantIndex) {
  const port = currentPort();
  const host = currentHost();
  const opts = [];
  catalog.forEach((e, i) => {
    if (e.port !== port || e.host !== host) return;
    const extra = [e.method !== 'GET' ? e.method : '', e.headers ? `[${e.headers.replace(/\n/g, ', ')}]` : ''].filter(Boolean).join(' ');
    opts.push(new Option(`${e.path}${extra ? ` ${extra}` : ''}  · ${e.route}`, String(i)));
  });
  ui.pathSel.replaceChildren(...opts, new Option('custom path...', CUSTOM));
  ui.pathSel.value = wantIndex >= 0 && opts.some(o => o.value === String(wantIndex)) ? String(wantIndex) : (opts[0]?.value ?? CUSTOM);
  onPathChange();
}

function onPathChange() {
  const custom = ui.pathSel.value === CUSTOM;
  ui.pathRow.hidden = !custom;
  if (!custom) {
    const e = catalog[Number(ui.pathSel.value)];
    ui.method.value = e.method;
    ui.path.value = e.path;
    ui.headers.value = e.headers;
  }
}

// ---------------------------------------------------------------------------
// Loop: after each trace finishes, wait N seconds, then trace the next path in
// the catalog (all ports and hosts of this Gateway). No cluster re-read.
// ---------------------------------------------------------------------------

let loopTimer = null;

function stopLoopTimer() {
  if (loopTimer !== null) clearTimeout(loopTimer);
  loopTimer = null;
}

function scheduleNext() {
  stopLoopTimer();
  const secs = Number(ui.loop.value);
  if (!secs || !catalog.length) return;
  loopTimer = setTimeout(loopTick, secs * 1000);
}

// Typing in a text field or reading a resource overlay pauses the loop.
function loopPaused() {
  const el = document.activeElement;
  const typing = el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !el.hidden));
  return typing || viz?._overlay?.isOpen;
}

function loopTick() {
  loopTimer = null;
  if (!Number(ui.loop.value) || !catalog.length) return;
  if (loopPaused()) { loopTimer = setTimeout(loopTick, 1000); return; }
  const cur = ui.pathSel.value === CUSTOM ? -1 : Number(ui.pathSel.value);
  const next = catalog[(cur + 1) % catalog.length];
  const index = (cur + 1) % catalog.length;
  ui.portSel.value = String(next.port);
  onPortChange(false);
  fillHosts(next.host);
  fillPaths(index);
  runTrace();
}

function onTraceDone() {
  // Leave every step ticked while waiting for the next loop.
  const n = viz?.state.flows.trace?.length || 0;
  for (let i = 0; i < n; i++) viz._stepsPanel?.updateStep(i, 'done');
  scheduleNext();
}

function runTrace() {
  if (!view) return;
  stopLoopTimer();
  const t = trace(view, {
    scheme: ui.scheme.value, host: currentHost(), port: currentPort(),
    method: ui.method.value, path: ui.path.value, headers: ui.headers.value,
  });
  ui.verdict.textContent = t.verdict;
  ui.verdict.className = t.ok ? 'ok' : 'bad';
  render(t);
}

// ---------------------------------------------------------------------------
// FlowStory rendering
// ---------------------------------------------------------------------------

function tooltips(v) {
  const tips = {};
  const conds = obj => (obj?.status?.conditions || []).map(c => [c.type, `${c.status} · ${c.reason}${c.message ? ` · ${c.message}` : ''}`]);
  const yaml = obj => (obj ? toYaml(cleanForYaml(obj)) : undefined);

  const gw = v.gateway;
  tips.gw = {
    title: `Gateway ${nsName(gw)}`,
    description: `GatewayClass ${gw.spec.gatewayClassName}${v.gatewayClass ? ` (controller ${v.gatewayClass.spec.controllerName})` : ''}. Addresses: ${(gw.status?.addresses || []).map(a => a.value).join(', ') || 'none'}.`,
    details: conds(gw), yaml: yaml(gw),
  };
  for (const p of v.parents) {
    if (p.nodeId === 'gw') continue;
    tips[p.nodeId] = {
      title: `ListenerSet ${nsName(p.obj)}`,
      description: p.accepted ? 'Accepted: its listeners are merged into the parent Gateway.' : `Not accepted: ${p.cond?.message || p.cond?.reason || 'no status yet'}. Its listeners get no traffic.`,
      details: conds(p.obj), yaml: yaml(p.obj),
    };
  }
  for (const l of v.listeners) {
    const st = l.status;
    tips[l.id] = {
      title: `Listener ${l.name}`,
      description: `${l.protocol} on port ${l.port}${l.hostname ? `, hostname ${l.hostname}` : ', any hostname'}. Owned by ${l.parentId === 'gw' ? 'Gateway' : 'ListenerSet'} ${nsName(l.parent.obj)}.`,
      details: [
        ['Attached routes', String(st?.attachedRoutes ?? 'unknown')],
        ['Allowed routes', JSON.stringify(l.spec.allowedRoutes || { namespaces: { from: 'Same' } })],
        ...(l.spec.tls ? [['TLS', `${l.spec.tls.mode || 'Terminate'} · ${(l.spec.tls.certificateRefs || []).map(c => c.name).join(', ')}`]] : []),
        ...(st?.conditions || []).map(c => [c.type, `${c.status} · ${c.reason}${c.message ? ` · ${c.message}` : ''}`]),
      ],
      yaml: toYaml(l.spec),
    };
  }
  for (const r of v.routes.values()) {
    const parents = (r.obj.status?.parents || []).flatMap(p =>
      (p.conditions || []).map(c => [`${p.parentRef.kind || 'Gateway'} ${p.parentRef.name}${p.parentRef.sectionName ? `/${p.parentRef.sectionName}` : ''}: ${c.type}`, `${c.status} · ${c.reason}${c.message ? ` · ${c.message}` : ''}`]));
    tips[r.id] = {
      title: `${r.obj.kind} ${nsName(r.obj)}`,
      description: `${r.depth ? `Delegated child route (depth ${r.depth}). ` : ''}${r.accepted ? 'Accepted by at least one parent.' : 'Not accepted by any parent in this view.'} ${(r.obj.spec?.rules || []).length} rule(s), hostnames: ${(r.obj.spec?.hostnames || []).join(', ') || 'any'}.`,
      details: parents.length ? parents : [['Status', 'no parent status written for this route']],
      yaml: yaml(r.obj),
    };
  }
  for (const b of v.backends.values()) {
    tips[b.id] = {
      title: `${b.kind} ${b.ns}/${b.name}`,
      description: b.missing ? 'Referenced by a route but the object does not exist.' : b.readyEndpoints === undefined ? 'Backend referenced by a route.' : `${b.readyEndpoints} ready endpoint(s) in EndpointSlices.`,
      details: v.backendEdges.filter(e => e.toId === b.id).map(e => [`from ${e.fromId.slice(2)}`, `rule #${e.ruleIndex + 1} · port ${e.port ?? '-'} · weight ${e.weight}`]),
      yaml: yaml(b.obj),
    };
  }
  for (const p of v.policies.values()) {
    const anc = p.status.ancestor;
    tips[p.id] = {
      title: `${p.obj.kind} ${nsName(p.obj)}`,
      description: `Configures: ${policyFeatures(p.obj).join(', ') || 'nothing'}. Targets: ${v.policyEdges.filter(e => e.fromId === p.id).map(e => `${e.toId.slice(2)}${e.sectionName ? `#${e.sectionName}` : ''}${e.selector ? ' (selector)' : ''}`).join(', ')}.`,
      details: (anc?.conditions || []).map(c => [`${anc.ancestorRef.kind} ${anc.ancestorRef.name}: ${c.type}`, `${c.status} · ${c.reason}${c.message ? ` · ${c.message}` : ''}`]),
      yaml: yaml(p.obj),
    };
  }
  for (const x of v.extensions.values()) {
    tips[x.id] = {
      title: `GatewayExtension ${x.ns}/${x.name}`,
      description: x.obj ? `Type: ${x.obj.spec?.type || Object.keys(x.obj.spec || {}).join(', ')}.` : 'Referenced by a policy but the object does not exist.',
      details: conds(x.obj), yaml: yaml(x.obj),
    };
  }
  tips.client = { title: 'Client', description: 'The caller outside the cluster. Edit the request in the side panel and press Trace.' };
  tips.cluster = { title: 'Kubernetes cluster', description: 'Objects read live through the Kubernetes API.' };
  return tips;
}

const escapeHtml = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function highlightYaml(src) {
  return src.split('\n').map(text => {
    const m = text.match(/^(\s*(?:-\s+)?)([^:\s][^:]*)(:)(.*)$/);
    if (!m) return escapeHtml(text);
    const [, indent, key, colon, value] = m;
    const v = value.trim();
    const cls = key.trim() === 'kind' ? 'fs-yaml-kind'
      : key.trim() === 'apiVersion' || /^(true|false|null|-?\d+)$/.test(v) || /^"(True|False)"$/.test(v) ? 'fs-yaml-literal' : 'fs-yaml-string';
    return `${escapeHtml(indent).replace('-', '<span class="fs-yaml-punctuation">-</span>')}<span class="fs-yaml-key">${escapeHtml(key)}</span><span class="fs-yaml-punctuation">${colon}</span><span class="${cls}">${escapeHtml(value)}</span>`;
  }).join('\n');
}

function makeDom() {
  ui.panelContent.innerHTML = `
    <div class="fs-steps"><div class="fs-steps-title">Trace steps <span style="font-weight:400;font-size:11px;color:var(--fs-text-dim)">· click to jump</span></div><div class="fs-steps-container"></div></div>
    <div class="fs-inspector"><div class="fs-inspector-title" style="color:var(--fs-accent)">Request</div><div class="fs-inspector-content"></div></div>`;
  const canvas = document.createElement('canvas');
  canvas.id = 'fs-canvas';
  ui.canvasHost.replaceChildren(canvas);
  ui.overlayHost.innerHTML = `
    <div id="fs-highlight-box" style="display:none;position:fixed;border-radius:10px;pointer-events:none"></div>
    <div id="fs-overlay" style="display:none;position:fixed;top:0;left:0;right:380px;bottom:0;background:rgba(0,0,0,.6)">
      <div id="fs-overlay-card" style="position:absolute;border:1px solid var(--fs-border);border-radius:14px;padding:22px 26px">
        <button id="fs-overlay-close" type="button" aria-label="Close" style="position:absolute;top:10px;right:14px;background:none;border:none;font-size:18px;cursor:pointer;padding:4px 8px">✕</button>
        <div id="fs-overlay-accent" style="width:4px;height:24px;border-radius:2px;position:absolute;left:0;top:22px"></div>
        <h2 id="fs-overlay-title" style="margin:0 0 6px;font-size:18px;font-family:system-ui"></h2>
        <p id="fs-overlay-desc" style="margin:0 0 14px;font-size:14px;line-height:1.5;font-family:system-ui"></p>
        <div id="fs-overlay-details" style="font-size:13px;font-family:SFMono-Regular,Consolas,monospace"></div>
        <button id="fs-overlay-resume" type="button" style="margin-top:14px;padding:7px 20px;border:1px solid var(--fs-success);border-radius:8px;background:transparent;color:var(--fs-success);font-size:13px;cursor:pointer;font-family:system-ui">Close / resume</button>
      </div>
    </div>`;
  const q = s => ui.overlayHost.querySelector(s);
  const p = s => ui.panelContent.querySelector(s);
  return {
    canvas,
    opts: {
      panelWidth: innerWidth <= 760 ? 0 : 380,
      stepsContainer: p('.fs-steps-container'), inspectorTitle: p('.fs-inspector-title'), inspectorContent: p('.fs-inspector-content'),
      overlay: q('#fs-overlay'), overlayCard: q('#fs-overlay-card'), overlayTitle: q('#fs-overlay-title'),
      overlayDesc: q('#fs-overlay-desc'), overlayDetails: q('#fs-overlay-details'), overlayAccent: q('#fs-overlay-accent'),
      overlayClose: q('#fs-overlay-close'), overlayResume: q('#fs-overlay-resume'), highlightBox: q('#fs-highlight-box'),
      title: $('fs-title'), legend: $('fs-legend'),
    },
  };
}

function stopViz() {
  if (!viz) return;
  viz.closeOverlay();
  viz.reset();
  viz._engine.stop();
  viz = null;
}

// Dashed relationship lines drawn beneath the nodes.
function drawEdges(ctx, engine, nodes, edges) {
  ctx.save();
  ctx.lineWidth = Math.max(1, engine.ts(1.4));
  ctx.setLineDash([engine.ts(6), engine.ts(5)]);
  ctx.globalAlpha = 0.6;
  for (const [fromId, toId, color, dir] of edges) {
    const a = nodes[fromId], b = nodes[toId];
    if (!a || !b) continue;
    let x1, y1, x2, y2, c1x, c1y, c2x, c2y;
    if (dir === 'v') {
      x1 = a.x + a.w / 2; y1 = a.y + a.h; x2 = b.x + b.w / 2; y2 = b.y;
      const dy = Math.max(30, (y2 - y1) / 2);
      c1x = x1; c1y = y1 + dy; c2x = x2; c2y = y2 - dy;
    } else {
      x1 = a.x + a.w; y1 = a.y + a.h / 2; x2 = b.x; y2 = b.y + b.h / 2;
      const dx = Math.max(30, (x2 - x1) / 2);
      c1x = x1 + dx; c1y = y1; c2x = x2 - dx; c2y = y2;
    }
    ctx.beginPath();
    ctx.moveTo(engine.tx(x1), engine.ty(y1));
    ctx.bezierCurveTo(engine.tx(c1x), engine.ty(c1y), engine.tx(c2x), engine.ty(c2y), engine.tx(x2), engine.ty(y2));
    ctx.strokeStyle = color;
    ctx.stroke();
  }
  ctx.restore();
}

async function render(t) {
  const seq = ++loadSeq;
  stopViz();
  const lay = layout(view);
  const edges = staticEdges(view);
  const diagram = {
    meta: { title: 'kgateway' },
    theme: isDark ? 'dark' : 'light',
    canvas: { width: lay.width, height: lay.height },
    nodes: lay.nodes,
    tooltips: tooltips(view),
    flows: { trace: { label: `${ui.method.value} ${currentHost()}${ui.path.value}`, steps: t.steps } },
    defaultFlow: 'trace',
    legend: [
      { label: 'Request', color: COLORS.request }, { label: 'Response', color: COLORS.response },
      { label: 'Policy', color: COLORS.policy }, { label: 'GatewayExtension / ListenerSet', color: COLORS.extension },
      { label: 'Backend', color: COLORS.backend }, { label: 'Error / not accepted', color: COLORS.error },
    ],
    inspector: { initialState: { phase: 'request', headers: t.initialHeaders, body: [], cycleState: [] }, mutations: { trace: t.mutations } },
  };
  const { canvas, opts } = makeDom();
  const v = new FlowStory(canvas, opts);
  // Titles come from cluster data; never let them through innerHTML.
  v._updateFlowLabel = () => { if (v._titleEl) v._titleEl.textContent = `Gateway ${nsName(view.gateway)}`; };
  viz = v;
  try {
    await v.load(diagram);
  } catch (e) {
    opts.stepsContainer.textContent = `Could not render: ${e.message}`;
    console.error(e);
    return;
  }
  if (seq !== loadSeq) { v.reset(); v._engine.stop(); return; }

  const renderAll = v._renderer.renderAll.bind(v._renderer);
  v._renderer.renderAll = (ctx, nodes, rc) => {
    drawEdges(ctx, v._engine, nodes, edges);
    renderAll(ctx, nodes, rc);
  };
  const show = v._overlay.show.bind(v._overlay);
  v._overlay.show = (...args) => {
    show(...args);
    const tip = args[2];
    if (tip?.yaml) {
      const pre = document.createElement('pre');
      pre.className = 'fs-yaml';
      pre.innerHTML = highlightYaml(tip.yaml);
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'kgw-copy';
      copy.textContent = 'Copy YAML';
      copy.style.cssText = 'padding:5px 12px;border:1px solid var(--fs-border);border-radius:6px;background:transparent;color:var(--fs-text);cursor:pointer';
      copy.onclick = () => navigator.clipboard?.writeText(tip.yaml).then(() => { copy.textContent = 'Copied'; });
      opts.overlayDetails.append(pre, copy);
    }
    requestAnimationFrame(fitOverlay);
  };
  v.setSpeed(Number(ui.speed.value));
  v._playback._onFlowComplete = () => { if (v === viz) onTraceDone(); };
  v.play('trace');
  // Deep link: ?open=<node id> opens that node's details once.
  const openId = params.get('open');
  if (openId && diagram.tooltips[openId]) {
    params.delete('open');
    v._overlay.show(openId, diagram.nodes[openId], diagram.tooltips[openId]);
  }
}

function fitOverlay() {
  const card = ui.overlayHost.querySelector('#fs-overlay-card');
  const backdrop = ui.overlayHost.querySelector('#fs-overlay');
  if (!card || backdrop.style.display === 'none') return;
  const right = innerWidth - (innerWidth <= 760 ? 0 : 380) - 10;
  const left = Number.parseFloat(card.style.left) || 10;
  const top = Number.parseFloat(card.style.top) || 10;
  card.style.left = `${Math.max(10, Math.min(left, right - card.offsetWidth))}px`;
  card.style.top = `${Math.max(10, Math.min(top, innerHeight - card.offsetHeight - 10))}px`;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

document.body.classList.toggle('light', !isDark);
ui.theme.innerHTML = isDark ? '&#9790;' : '&#9788;';
ui.theme.addEventListener('click', () => {
  if (!viz) return;
  viz.toggleTheme();
  isDark = !document.body.classList.contains('light');
  ui.theme.innerHTML = isDark ? '&#9790;' : '&#9788;';
});
ui.gateway.addEventListener('change', () => selectGateway(true));
ui.refresh.addEventListener('click', refresh);
ui.trace.addEventListener('click', runTrace);
ui.portSel.addEventListener('change', () => { onPortChange(); runTrace(); });
ui.hostSel.addEventListener('change', () => {
  ui.hostRow.hidden = ui.hostSel.value !== CUSTOM;
  fillPaths();
  if (ui.hostSel.value !== CUSTOM) runTrace();
});
ui.pathSel.addEventListener('change', () => { onPathChange(); if (ui.pathSel.value !== CUSTOM) runTrace(); });
ui.port.addEventListener('change', () => { fillHosts(); fillPaths(); });
ui.host.addEventListener('change', () => fillPaths());
for (const el of [ui.host, ui.path, ui.port]) el.addEventListener('keydown', e => { if (e.key === 'Enter') runTrace(); });
ui.speed.addEventListener('change', () => viz?.setSpeed(Number(ui.speed.value)));
ui.reset.addEventListener('click', () => { stopLoopTimer(); viz?.reset(); });
if (['0', '5', '10'].includes(params.get('loop'))) ui.loop.value = params.get('loop');
ui.loop.addEventListener('change', () => {
  // If the current trace already finished, start counting now; otherwise onTraceDone will.
  if (!Number(ui.loop.value)) stopLoopTimer();
  else if (viz && !viz.state.running) scheduleNext();
});
addEventListener('resize', fitOverlay);
// Keep findCond referenced for console debugging.
window.__kgw = { get view() { return view; }, get store() { return store; }, findCond };

refresh();
