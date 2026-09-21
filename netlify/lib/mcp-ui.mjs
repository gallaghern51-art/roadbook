// MCP Apps: the rich UI a rider's own AI renders inline when it calls the
// route and trip tools. Each export is one self-contained HTML document,
// served as a `ui://roadbook/…` resource with mime `text/html;profile=mcp-app`
// and rendered by the host in a sandboxed iframe. The host hands the tool's
// result over postMessage (ui/notifications/tool-result); the page calls
// tools back through the host (tools/call) — that is how "Save as a trip" in
// the picker becomes a row in the rider's library without a second prompt.
//
// Self-contained on purpose: no bundler, no framework, no CDN script. The
// basemap under the route lines is a grid of Esri World Street Map tiles
// (declared in the resource CSP as a resource domain — see mcp-server.mjs);
// if a host refuses images the SVG still stands, because the roads are the
// picture and the tiles are context.
//
// Wire names follow the MCP Apps extension (ext-apps, protocol 2026-01-26).

const PROTOCOL = '2026-01-26';

// ---------------------------------------------------------------- shared ----

const BRIDGE = String.raw`
var Bridge = (function () {
  var nextId = 0, pending = {}, handlers = {};
  function send(msg) { try { window.parent.postMessage(msg, '*'); } catch (e) {} }
  function request(method, params) {
    return new Promise(function (resolve, reject) {
      var id = ++nextId;
      pending[id] = { resolve: resolve, reject: reject };
      send({ jsonrpc: '2.0', id: id, method: method, params: params || {} });
    });
  }
  function notify(method, params) { send({ jsonrpc: '2.0', method: method, params: params || {} }); }
  window.addEventListener('message', function (ev) {
    var m = ev.data;
    if (!m || m.jsonrpc !== '2.0') return;
    if (m.id != null && (m.result !== undefined || m.error !== undefined) && !m.method) {
      var p = pending[m.id];
      if (p) { delete pending[m.id]; if (m.error) p.reject(m.error); else p.resolve(m.result); }
      return;
    }
    if (m.method) {
      var h = handlers[m.method];
      var out = h ? h(m.params || {}) : undefined;
      if (m.id != null) send({ jsonrpc: '2.0', id: m.id, result: out || {} });
    }
  });
  function on(method, fn) { handlers[method] = fn; }
  function init(name) {
    return request('ui/initialize', {
      appInfo: { name: name, version: '1.0.0' },
      appCapabilities: {},
      protocolVersion: '${PROTOCOL}',
    }).then(function (r) { notify('ui/notifications/initialized', {}); return r || {}; }, function () { return {}; });
  }
  var sizeTimer = null;
  function size() {
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(function () {
      notify('ui/notifications/size-changed', { height: Math.ceil(document.documentElement.getBoundingClientRect().height) + 2 });
    }, 30);
  }
  function theme(ctx) {
    var t = ctx && ctx.theme;
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    var vars = ctx && ctx.styles && ctx.styles.variables;
    if (vars && typeof vars === 'object') { for (var k in vars) { if (/^--/.test(k)) document.documentElement.style.setProperty(k, String(vars[k])); } }
  }
  function tell(text) { request('ui/update-model-context', { content: [{ type: 'text', text: text }] }).catch(function () {}); }
  function open(url) { request('ui/open-link', { url: url }).catch(function () { try { window.open(url, '_blank'); } catch (e) {} }); }
  return { request: request, notify: notify, on: on, init: init, size: size, theme: theme, tell: tell, open: open };
})();
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function fmtMin(m) { var n = Math.round(Number(m) || 0); var h = Math.floor(n / 60); return h ? h + 'h ' + String(n % 60).padStart(2, '0') + 'm' : n + 'm'; }
function fmtWhen(iso) { if (!iso) return ''; var d = new Date(iso); if (isNaN(d)) return iso; return d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
`;

// Web Mercator on 256px tiles, the grid Esri and OSM both serve.
const MAPKIT = String.raw`
var TILE = 256;
function projX(lng, z) { return (lng + 180) / 360 * TILE * Math.pow(2, z); }
function projY(lat, z) { var s = Math.sin(lat * Math.PI / 180); s = Math.max(-0.9999, Math.min(0.9999, s)); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE * Math.pow(2, z); }
function fitZoom(b, w, h, pad) {
  for (var z = 13; z >= 2; z--) {
    var dx = projX(b.maxLng, z) - projX(b.minLng, z), dy = projY(b.minLat, z) - projY(b.maxLat, z);
    if (dx <= w - pad * 2 && dy <= h - pad * 2) return z;
  }
  return 2;
}
function boundsOf(lines) {
  var b = { minLat: 90, maxLat: -90, minLng: 180, maxLng: -180 };
  lines.forEach(function (g) { (g || []).forEach(function (p) { var lng = p[0], lat = p[1]; if (lat < b.minLat) b.minLat = lat; if (lat > b.maxLat) b.maxLat = lat; if (lng < b.minLng) b.minLng = lng; if (lng > b.maxLng) b.maxLng = lng; }); });
  if (b.minLat > b.maxLat) return null;
  if (b.maxLat - b.minLat < 0.01) { b.minLat -= 0.005; b.maxLat += 0.005; }
  if (b.maxLng - b.minLng < 0.01) { b.minLng -= 0.005; b.maxLng += 0.005; }
  return b;
}
// Draws tiles + returns a projector for the overlay. Tiles are optional: a
// host that blocks the image domain leaves a plain plate under the lines.
function drawBasemap(el, lines, opts) {
  opts = opts || {};
  var w = el.clientWidth || 600, h = el.clientHeight || 320;
  var b = boundsOf(lines);
  if (!b) return null;
  var z = fitZoom(b, w, h, opts.pad || 28);
  var cx = (projX(b.minLng, z) + projX(b.maxLng, z)) / 2, cy = (projY(b.minLat, z) + projY(b.maxLat, z)) / 2;
  var x0 = cx - w / 2, y0 = cy - h / 2;
  var tiles = el.querySelector('.tiles');
  tiles.innerHTML = '';
  if (opts.tiles !== false) {
    var tx0 = Math.floor(x0 / TILE), tx1 = Math.floor((x0 + w) / TILE), ty0 = Math.floor(y0 / TILE), ty1 = Math.floor((y0 + h) / TILE);
    var n = Math.pow(2, z), count = 0;
    for (var ty = ty0; ty <= ty1; ty++) for (var tx = tx0; tx <= tx1; tx++) {
      if (ty < 0 || ty >= n || ++count > 64) continue;
      var img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      img.src = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/' + z + '/' + ty + '/' + (((tx % n) + n) % n);
      img.style.left = (tx * TILE - x0) + 'px';
      img.style.top = (ty * TILE - y0) + 'px';
      tiles.appendChild(img);
    }
  }
  return { w: w, h: h, z: z, x: function (lng) { return projX(lng, z) - x0; }, y: function (lat) { return projY(lat, z) - y0; } };
}
function pathOf(P, g) { var d = ''; (g || []).forEach(function (p, i) { d += (i ? 'L' : 'M') + P.x(p[0]).toFixed(1) + ' ' + P.y(p[1]).toFixed(1); }); return d; }
`;

const CSS = String.raw`
:root { --bg:#0b1220; --panel:#121b2c; --line:#26334a; --ink:#efe6d6; --dim:#a7a29a; --faint:#6f6c66; --orange:#f48322; --turq:#2dd4bf; --ok:#7bd88f; --danger:#f0605d; --shadow:0 10px 30px rgba(0,0,0,.35); color-scheme: dark; }
:root[data-theme="light"] { --bg:#f5f1ea; --panel:#ffffff; --line:#e3ddd2; --ink:#1a1a1a; --dim:#5f5a53; --faint:#9a958d; --orange:#d9691a; --turq:#0f9d8a; --shadow:0 10px 30px rgba(20,20,20,.10); color-scheme: light; }
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
.wrap { padding: 12px; }
.head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; }
.brand { font-weight: 800; letter-spacing: .06em; text-transform: uppercase; font-size: 11px; color: var(--orange); }
h1 { font-size: 17px; margin: 0; font-weight: 700; }
.sub { color: var(--dim); font-size: 12.5px; margin: 2px 0 0; }
.map { position: relative; height: 300px; border-radius: 12px; overflow: hidden; background: #1c2536; border: 1px solid var(--line); }
:root[data-theme="light"] .map { background: #dfe6ee; }
.map .tiles { position: absolute; inset: 0; }
.map .tiles img { position: absolute; width: 256px; height: 256px; opacity: .92; }
:root:not([data-theme="light"]) .map .tiles img { filter: brightness(.62) saturate(.7) contrast(1.05); }
.map svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.map .credit { position: absolute; right: 6px; bottom: 4px; font-size: 10px; color: rgba(255,255,255,.75); text-shadow: 0 1px 2px rgba(0,0,0,.8); }
:root[data-theme="light"] .map .credit { color: rgba(0,0,0,.6); text-shadow: none; }
.map .empty { position: absolute; inset: 0; display: grid; place-items: center; color: var(--dim); }
.map .empty[hidden] { display: none; }
.bubble { font: 600 11px/1 sans-serif; }
.cards { display: grid; gap: 8px; margin-top: 10px; }
.card { display: block; width: 100%; text-align: left; background: var(--panel); border: 1.5px solid var(--line); border-radius: 12px; padding: 10px 12px; color: var(--ink); cursor: pointer; font: inherit; }
.card:hover { border-color: var(--dim); }
.card.sel { border-color: var(--orange); box-shadow: 0 0 0 3px rgba(244,131,34,.18); }
.card .row { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.card .lbl { font-weight: 700; font-size: 15px; }
.card .via { color: var(--dim); font-size: 12.5px; }
.card .big { font-weight: 800; font-size: 18px; margin-left: auto; font-variant-numeric: tabular-nums; }
.card .facts { display: flex; gap: 6px 14px; flex-wrap: wrap; margin-top: 6px; color: var(--dim); font-size: 12.5px; }
.card .facts b { color: var(--ink); font-weight: 600; }
.tag { display: inline-block; padding: 2px 7px; border-radius: 999px; font-size: 11px; font-weight: 700; letter-spacing: .02em; border: 1px solid var(--line); color: var(--dim); }
.tag.hot { color: var(--orange); border-color: var(--orange); }
.tag.turq { color: var(--turq); border-color: var(--turq); }
.tag.warn { color: var(--danger); border-color: var(--danger); }
.swatch { display: inline-block; width: 22px; height: 6px; border-radius: 3px; vertical-align: middle; margin-right: 6px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 12px; }
.actions input { flex: 1 1 180px; min-width: 0; background: var(--panel); color: var(--ink); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; font: inherit; }
.actions input[type=date] { flex: 0 0 auto; }
.btn { background: var(--panel); color: var(--ink); border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; font: inherit; font-weight: 700; cursor: pointer; min-height: 40px; }
.btn.primary { background: var(--orange); border-color: var(--orange); color: #14100b; }
.btn:disabled { opacity: .55; cursor: default; }
.note { color: var(--dim); font-size: 12px; margin-top: 8px; }
.note.ok { color: var(--ok); }
.note.err { color: var(--danger); }
.days { display: grid; gap: 6px; margin-top: 10px; }
.day { display: grid; grid-template-columns: 62px 1fr auto; gap: 10px; align-items: center; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; }
.day .d { font-variant-numeric: tabular-nums; color: var(--dim); font-size: 12px; }
.day .d b { display: block; color: var(--ink); font-size: 14px; }
.day .t { min-width: 0; }
.day .t .name { font-weight: 700; }
.day .t .ft { color: var(--dim); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.day .m { text-align: right; font-variant-numeric: tabular-nums; font-size: 12.5px; color: var(--dim); }
.day .m b { display: block; color: var(--ink); font-size: 14px; }
.stats { display: flex; gap: 6px 14px; flex-wrap: wrap; color: var(--dim); font-size: 12.5px; margin-top: 6px; }
.stats b { color: var(--ink); font-weight: 600; }
.phase-prep { color: #9a9a9a; } .phase-outbound { color: var(--orange); } .phase-rally { color: #f53f1f; } .phase-return { color: var(--turq); }
`;

const COLORS = ['#2f7bff', '#f48322', '#2dd4bf', '#e0218a', '#b48cff', '#7bd88f'];

// ---------------------------------------------------------- route picker ----

export const ROUTE_OPTIONS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Roadbook — route options</title>
<style>${CSS}</style></head>
<body><div class="wrap">
  <div class="head"><div><div class="brand">Roadbook</div><h1 id="title">Measuring the roads…</h1><p class="sub" id="sub"></p></div></div>
  <div class="map" id="map"><div class="tiles"></div><svg id="svg"></svg><div class="empty" id="empty">Routing…</div><div class="credit">Basemap © Esri · roads by Valhalla motorcycle</div></div>
  <div class="cards" id="cards"></div>
  <div class="actions" id="actions" hidden>
    <input id="name" type="text" placeholder="Trip name (optional)">
    <input id="date" type="date" title="Ride date">
    <button class="btn primary" id="save">Save as a trip</button>
    <button class="btn" id="open" hidden>Open in Roadbook</button>
  </div>
  <p class="note" id="note"></p>
</div>
<script>
${BRIDGE}
${MAPKIT}
var COLORS = ${JSON.stringify(COLORS)};
var state = { set: null, options: [], selected: null, saved: null, args: null };

function render() {
  var s = state.set, opts = state.options;
  var title = document.getElementById('title'), sub = document.getElementById('sub');
  if (!s) {
    var a = state.args || {};
    var from = a.start && (a.start.name || a.start), to = a.end && (a.end.name || a.end);
    title.textContent = from && to ? esc(from) + ' → ' + esc(to) : 'Measuring the roads…';
    sub.textContent = 'Asking Valhalla for every road worth riding, then Google for the clock.';
    return;
  }
  title.textContent = s.start.name + (s.stops.length ? ' → ' + s.stops.map(function (x) { return x.name; }).join(' → ') : '') + ' → ' + s.end.name;
  var bits = [];
  if (s.at) bits.push('leaving ' + fmtWhen(s.at));
  if (s.avoidTolls) bits.push('avoiding tolls');
  bits.push(opts.length === 1 ? 'one road to choose from' : opts.length + ' roads measured');
  sub.textContent = bits.join(' · ');

  // map
  var map = document.getElementById('map'), svg = document.getElementById('svg');
  document.getElementById('empty').hidden = true;
  var P = drawBasemap(map, opts.map(function (o) { return o.geometry; }));
  svg.setAttribute('viewBox', '0 0 ' + (P ? P.w : 600) + ' ' + (P ? P.h : 300));
  svg.innerHTML = '';
  if (P) {
    var order = opts.map(function (o, i) { return i; }).sort(function (a, b) { return (opts[a].id === state.selected) - (opts[b].id === state.selected); });
    order.forEach(function (i) {
      var o = opts[i], sel = o.id === state.selected, d = pathOf(P, o.geometry);
      svg.insertAdjacentHTML('beforeend',
        '<path d="' + d + '" fill="none" stroke="' + (sel ? '#ffffff' : 'rgba(0,0,0,.45)') + '" stroke-width="' + (sel ? 8 : 6) + '" stroke-linecap="round" stroke-linejoin="round" opacity="' + (sel ? .9 : .5) + '"/>' +
        '<path data-id="' + esc(o.id) + '" d="' + d + '" fill="none" stroke="' + COLORS[i % COLORS.length] + '" stroke-width="' + (sel ? 4.5 : 3) + '" stroke-linecap="round" stroke-linejoin="round" opacity="' + (sel ? 1 : .55) + '" style="cursor:pointer"/>' +
        '<path data-id="' + esc(o.id) + '" d="' + d + '" fill="none" stroke="transparent" stroke-width="22" style="cursor:pointer"/>');
      // a time bubble where this road stops agreeing with the others
      var mid = o.geometry[Math.floor(o.geometry.length * (0.35 + 0.1 * i))] || o.geometry[0];
      if (mid) {
        var label = fmtMin(o.traffic ? o.traffic.minutes : o.minutes);
        svg.insertAdjacentHTML('beforeend', '<g data-id="' + esc(o.id) + '" style="cursor:pointer"><rect x="' + (P.x(mid[0]) + 6) + '" y="' + (P.y(mid[1]) - 22) + '" rx="7" ry="7" width="' + (label.length * 7 + 12) + '" height="18" fill="' + (sel ? COLORS[i % COLORS.length] : '#111') + '" opacity=".92"/><text class="bubble" x="' + (P.x(mid[0]) + 12) + '" y="' + (P.y(mid[1]) - 9) + '" fill="#fff">' + esc(label) + '</text></g>');
      }
    });
    [s.start].concat(s.stops, [s.end]).forEach(function (p, i, arr) {
      var end = i === 0 || i === arr.length - 1;
      svg.insertAdjacentHTML('beforeend', '<circle cx="' + P.x(p.lng) + '" cy="' + P.y(p.lat) + '" r="' + (end ? 6 : 4.5) + '" fill="' + (i === 0 ? '#2dd4bf' : end ? '#f48322' : '#fff') + '" stroke="#111" stroke-width="2"/>');
    });
    svg.querySelectorAll('[data-id]').forEach(function (el) { el.addEventListener('click', function () { select(el.getAttribute('data-id')); }); });
  }

  // cards
  var cards = document.getElementById('cards');
  cards.innerHTML = opts.map(function (o, i) {
    var tags = [];
    if (o.fastest) tags.push('<span class="tag hot">fastest</span>');
    if (o.shortest) tags.push('<span class="tag turq">shortest</span>');
    if (o.kind === 'alternate') tags.push('<span class="tag">alternate</span>');
    if (o.toll) tags.push('<span class="tag warn">tolls ≈ ' + esc(o.toll.currency === 'USD' ? '$' : o.toll.currency + ' ') + o.toll.amount.toFixed(2) + '</span>');
    else if (o.hasToll) tags.push('<span class="tag warn">tolls</span>');
    var clock = o.traffic
      ? '<span><b>' + fmtMin(o.traffic.minutes) + '</b> in ' + (o.traffic.at ? 'predicted' : 'current') + ' traffic' + (o.traffic.deltaMinutes > 0 ? ' <span class="tag warn">+' + fmtMin(o.traffic.deltaMinutes) + '</span>' : '') + (o.traffic.pinned ? '' : ' (corridor)') + '</span>'
      : '';
    return '<button class="card' + (o.id === state.selected ? ' sel' : '') + '" data-id="' + esc(o.id) + '">' +
      '<div class="row"><span class="swatch" style="background:' + COLORS[i % COLORS.length] + '"></span><span class="lbl">' + esc(o.label) + '</span>' + (o.via ? '<span class="via">via ' + esc(o.via) + '</span>' : '') + '<span class="big">' + fmtMin(o.minutes) + '</span></div>' +
      '<div class="facts"><span><b>' + o.miles + ' mi</b> on the road</span>' + clock + (tags.length ? '<span>' + tags.join(' ') + '</span>' : '') + '</div>' +
      '</button>';
  }).join('');
  cards.querySelectorAll('.card').forEach(function (el) { el.addEventListener('click', function () { select(el.getAttribute('data-id')); }); });

  var actions = document.getElementById('actions');
  actions.hidden = !opts.length;
  document.getElementById('save').disabled = !state.selected || !!state.saved;
  document.getElementById('open').hidden = !state.saved;
  Bridge.size();
}

function select(id) {
  if (state.saved) return;
  state.selected = id;
  render();
  var o = state.options.find(function (x) { return x.id === id; });
  if (o) Bridge.tell('The rider is looking at the ' + o.label + ' option (' + o.id + '): ' + o.miles + ' mi, ' + fmtMin(o.minutes) + ' on the road' + (o.traffic ? ', ' + fmtMin(o.traffic.minutes) + ' in traffic' : '') + '.');
}

function setNote(text, cls) { var n = document.getElementById('note'); n.textContent = text || ''; n.className = 'note' + (cls ? ' ' + cls : ''); Bridge.size(); }

document.getElementById('save').addEventListener('click', function () {
  if (!state.selected || !state.set) return;
  var btn = document.getElementById('save');
  btn.disabled = true;
  setNote('Saving to your Roadbook library…');
  var args = { optionSetId: state.set.optionSetId, optionId: state.selected };
  var name = document.getElementById('name').value.trim(); if (name) args.name = name;
  var date = document.getElementById('date').value; if (date) args.date = date;
  Bridge.request('tools/call', { name: 'save_route_option', arguments: args }).then(function (r) {
    var sc = (r && r.structuredContent) || {};
    if (r && r.isError) { throw new Error((r.content && r.content[0] && r.content[0].text) || 'save failed'); }
    state.saved = sc.trip || { url: null };
    setNote('Saved' + (state.saved.title ? ': ' + state.saved.title : '') + (state.saved.startDate ? ' · ' + state.saved.startDate : '') + '. It will be in the app the next time it opens.', 'ok');
    Bridge.tell('The rider saved option ' + state.selected + ' as the trip "' + (state.saved.title || '') + '" (tripId ' + (state.saved.tripId || '?') + ').');
    render();
  }).catch(function (e) {
    btn.disabled = false;
    setNote('Could not save: ' + (e && (e.message || e.data || JSON.stringify(e))), 'err');
  });
});
document.getElementById('open').addEventListener('click', function () { if (state.saved && state.saved.url) Bridge.open(state.saved.url); });

Bridge.on('ui/notifications/tool-input', function (p) { state.args = p.arguments || null; render(); });
Bridge.on('ui/notifications/tool-input-partial', function (p) { state.args = p.arguments || state.args; });
Bridge.on('ui/notifications/tool-result', function (p) {
  var sc = p && p.structuredContent;
  if (!sc && p && p.content) { try { sc = JSON.parse(p.content.filter(function (c) { return c.type === 'text'; }).map(function (c) { return c.text; }).join('')); } catch (e) {} }
  if (p && p.isError) { document.getElementById('empty').textContent = (p.content && p.content[0] && p.content[0].text) || 'Could not measure these roads.'; Bridge.size(); return; }
  if (!sc || !sc.options) return;
  state.set = { optionSetId: sc.optionSetId, start: sc.start, stops: sc.stops || [], end: sc.end, at: sc.departureTime || null, avoidTolls: !!sc.avoidTolls };
  state.options = sc.options;
  state.selected = (sc.options[0] && sc.options[0].id) || null;
  if (sc.suggestedDate) document.getElementById('date').value = sc.suggestedDate;
  render();
});
Bridge.on('ui/notifications/host-context-changed', function (ctx) { Bridge.theme(ctx); });
Bridge.on('ui/resource-teardown', function () { return {}; });
Bridge.init('roadbook-route-options').then(function (r) { Bridge.theme(r.hostContext || {}); render(); });
window.addEventListener('resize', function () { if (state.set) render(); });
</script></body></html>`;

// -------------------------------------------------------------- trip card ----

export const TRIP_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Roadbook — trip</title>
<style>${CSS}</style></head>
<body><div class="wrap">
  <div class="head"><div><div class="brand">Roadbook</div><h1 id="title">Loading the trip…</h1><p class="sub" id="sub"></p></div><button class="btn" id="open" hidden>Open in Roadbook</button></div>
  <div class="map" id="map"><div class="tiles"></div><svg id="svg"></svg><div class="empty" id="empty">Loading…</div><div class="credit">Basemap © Esri</div></div>
  <div class="stats" id="stats"></div>
  <div class="days" id="days"></div>
  <p class="note" id="note"></p>
</div>
<script>
${BRIDGE}
${MAPKIT}
var PHASE = { prep: '#9a9a9a', outbound: '#f48322', rally: '#f53f1f', return: '#2dd4bf' };
var state = { trip: null, stops: [], geometry: null };

function render() {
  var t = state.trip;
  if (!t) return;
  document.getElementById('title').textContent = t.title || t.name || 'Trip';
  var sub = [];
  if (t.startDate) sub.push(t.startDate + (t.endDate && t.endDate !== t.startDate ? ' → ' + t.endDate : ''));
  sub.push(t.days + (t.days === 1 ? ' day' : ' days'));
  if (t.summary) sub.push(t.summary);
  document.getElementById('sub').textContent = sub.join(' · ');
  var open = document.getElementById('open'); open.hidden = !t.url;

  var map = document.getElementById('map'), svg = document.getElementById('svg');
  var lines = state.stops.map(function (d) { return (state.geometry && state.geometry[d.dayId]) || d.waypoints.map(function (w) { return [w.lng, w.lat]; }); });
  var P = drawBasemap(map, lines);
  document.getElementById('empty').hidden = !!P;
  svg.setAttribute('viewBox', '0 0 ' + (P ? P.w : 600) + ' ' + (P ? P.h : 300));
  svg.innerHTML = '';
  if (P) {
    state.stops.forEach(function (d, i) {
      var g = lines[i], color = PHASE[(t.dayList[i] || {}).phase] || '#f48322';
      var routed = !!(state.geometry && state.geometry[d.dayId]);
      var dd = pathOf(P, g);
      svg.insertAdjacentHTML('beforeend', '<path d="' + dd + '" fill="none" stroke="rgba(0,0,0,.5)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><path d="' + dd + '" fill="none" stroke="' + color + '" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"' + (routed ? '' : ' stroke-dasharray="6 5"') + '/>');
      d.waypoints.forEach(function (w, j) {
        var end = j === 0 || j === d.waypoints.length - 1;
        svg.insertAdjacentHTML('beforeend', '<circle cx="' + P.x(w.lng) + '" cy="' + P.y(w.lat) + '" r="' + (end ? 5 : 3.2) + '" fill="' + (end ? color : '#fff') + '" stroke="#111" stroke-width="1.6"><title>' + esc(w.name) + '</title></circle>');
      });
    });
  }
  var st = [];
  st.push('<span><b>' + t.riders + '</b> ' + (t.riders === 1 ? 'rider' : 'riders') + '</span>');
  if (t.routePrefs) st.push('<span><b>' + esc({ quick: 'Quick', touring: 'Touring', backroads: 'Back roads' }[t.routePrefs.style] || t.routePrefs.style) + '</b> roads' + (t.routePrefs.avoidTolls ? ', no tolls' : '') + '</span>');
  if (t.totalRoadMiles) st.push('<span><b>' + t.totalRoadMiles + ' mi</b> routed</span>');
  var unv = (t.dayList || []).reduce(function (n, d) { return n + (d.unverified || []).length; }, 0);
  if (unv) st.push('<span class="tag warn">' + unv + ' unverified stop' + (unv === 1 ? '' : 's') + '</span>');
  document.getElementById('stats').innerHTML = st.join('');

  document.getElementById('days').innerHTML = (t.dayList || []).map(function (d) {
    var miles = d.roadMiles != null ? '<b>' + d.roadMiles + ' mi</b>' + (d.ridingMinutes != null ? fmtMin(d.ridingMinutes) + ' riding' : '') : '<b>~' + d.straightLineMiles + ' mi</b>straight line';
    return '<div class="day"><div class="d"><b>' + esc(d.dow || '') + '</b>' + esc(d.date ? d.date.slice(5).replace('-', '/') : '') + '</div>' +
      '<div class="t"><div class="name"><span class="phase-' + esc(d.phase) + '">●</span> ' + esc(d.title) + '</div><div class="ft">' + esc(d.from || '') + (d.to ? ' → ' + esc(d.to) : '') + ' · ' + d.stops + ' stops' + (d.lodging ? ' · ' + esc(d.lodging) : '') + '</div></div>' +
      '<div class="m">' + miles + '</div></div>';
  }).join('');
  document.getElementById('note').textContent = state.geometry ? '' : 'Dashed lines join the stops; the app routes every day on real roads when it opens.';
  Bridge.size();
}

document.getElementById('open').addEventListener('click', function () { if (state.trip && state.trip.url) Bridge.open(state.trip.url); });
Bridge.on('ui/notifications/tool-result', function (p) {
  var sc = p && p.structuredContent;
  if (!sc && p && p.content) { try { sc = JSON.parse(p.content.filter(function (c) { return c.type === 'text'; }).map(function (c) { return c.text; }).join('')); } catch (e) {} }
  if (p && p.isError) { document.getElementById('empty').textContent = (p.content && p.content[0] && p.content[0].text) || 'Could not load the trip.'; Bridge.size(); return; }
  if (!sc || !sc.trip) return;
  state.trip = sc.trip; state.stops = sc.stops || []; state.geometry = sc.geometry || null;
  render();
});
Bridge.on('ui/notifications/host-context-changed', function (ctx) { Bridge.theme(ctx); });
Bridge.on('ui/resource-teardown', function () { return {}; });
Bridge.init('roadbook-trip').then(function (r) { Bridge.theme(r.hostContext || {}); render(); });
window.addEventListener('resize', function () { render(); });
</script></body></html>`;

export const UI = {
  'ui://roadbook/route-options': { name: 'Route options', description: 'Every measured road between the points, with traffic and tolls, and a Save as a trip button.', html: ROUTE_OPTIONS_HTML },
  'ui://roadbook/trip': { name: 'Trip', description: 'A trip from the rider’s library: days, stops, lodging, and an Open in Roadbook button.', html: TRIP_HTML },
};

export const UI_META = {
  ui: {
    csp: { resourceDomains: ['https://server.arcgisonline.com'], connectDomains: [] },
    prefersBorder: true,
  },
};
