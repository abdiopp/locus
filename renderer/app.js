'use strict';

/* global L */

// ================================================================== helpers

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const ICONS = {
  refresh:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>',
  search:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  target:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="m12 2.8 2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z"/></svg>',
  clock:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12Z"/><circle cx="12" cy="9" r="2.5"/></svg>',
};

function icon(name, cls = '') {
  const span = document.createElement('span');
  span.className = cls;
  span.innerHTML = ICONS[name];
  span.style.display = 'inline-grid';
  span.style.width = '16px';
  span.style.height = '16px';
  span.style.flex = 'none';
  span.style.color = 'var(--muted)';
  return span;
}

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`locus.${key}`);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`locus.${key}`, JSON.stringify(value));
    } catch {
      /* storage unavailable: settings just won't persist */
    }
  },
};

const fmtCoord = (lat, lon) => `${lat.toFixed(6)}, ${lon.toFixed(6)}`;

function fmtDist(m) {
  if (m == null) return '';
  return m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m)} m`;
}

function fmtDur(s) {
  if (s == null || !isFinite(s)) return '';
  s = Math.round(s);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function parseCoordinates(text) {
  const match = String(text).match(/(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)/);
  if (!match) return null;
  const lat = parseFloat(match[1]);
  const lon = parseFloat(match[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

let toastTimer;
function toast(message, kind = 'info', ms = 4200) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

// ================================================================== state

const state = {
  engineReady: false,
  devices: [],
  selectedUdid: store.get('lastDevice', ''),
  connected: null,
  connecting: false,
  position: null,
  tab: 'teleport',
  profile: store.get('profile', 'foot'),
  waypoints: [],
  gpx: null,
  routePath: null,
  routeDistance: null,
  speedKmh: store.get('speedKmh', 5),
  favorites: store.get('favorites', []),
  recents: store.get('recents', []),
  settings: {
    jitter: 0,
    variance: 0,
    transport: 'auto',
    mapStyle: 'auto',
    clearOnQuit: true,
    ...store.get('settings', {}),
  },
  address: '',
};

// ================================================================== map

const lastView = store.get('view', { center: [37.7749, -122.4194], zoom: 13 });
const map = L.map('map', { zoomControl: false, worldCopyJump: true }).setView(lastView.center, lastView.zoom);
L.control.zoom({ position: 'topright' }).addTo(map);
map.on(
  'moveend',
  debounce(() => {
    const c = map.getCenter();
    store.set('view', { center: [c.lat, c.lng], zoom: map.getZoom() });
  }, 400),
);

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const ESRI_ATTR = 'Tiles &copy; <a href="https://www.esri.com" target="_blank">Esri</a>, HERE, Garmin, &copy; OpenStreetMap contributors';
// Each style is a stack of tile layers (base first, then labels).
const TILES = {
  light: [{ url: `${ESRI}/World_Street_Map/MapServer/tile/{z}/{y}/{x}`, maxZoom: 19 }],
  dark: [
    { url: `${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`, maxZoom: 16 },
    { url: `${ESRI}/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, maxZoom: 16 },
  ],
  satellite: [
    { url: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, maxZoom: 19 },
    { url: `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`, maxZoom: 19 },
  ],
};

let tileLayers = [];
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function applyMapStyle() {
  let style = state.settings.mapStyle;
  if (style === 'auto') style = darkQuery.matches ? 'dark' : 'light';
  tileLayers.forEach((l) => map.removeLayer(l));
  tileLayers = (TILES[style] || TILES.light).map((def, i) =>
    L.tileLayer(def.url, {
      // Past a service's native zoom, keep stretching its last tiles instead of showing blanks.
      maxNativeZoom: def.maxZoom,
      maxZoom: 20,
      attribution: i === 0 ? ESRI_ATTR : '',
    }).addTo(map),
  );
}
darkQuery.addEventListener('change', applyMapStyle);
applyMapStyle();

// device marker
const deviceIcon = L.divIcon({
  className: '',
  html: '<div class="dev-marker"><div class="dev-pulse"></div><div class="dev-heading"></div><div class="dev-dot"></div></div>',
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});
let deviceMarker = null;
let followDevice = true;

function updateDeviceMarker(pos) {
  if (!pos || pos.lat == null) {
    if (deviceMarker) map.removeLayer(deviceMarker);
    deviceMarker = null;
    return;
  }
  const ll = [pos.lat, pos.lon];
  if (!deviceMarker) {
    deviceMarker = L.marker(ll, { icon: deviceIcon, interactive: false, zIndexOffset: 1000 }).addTo(map);
  } else {
    deviceMarker.setLatLng(ll);
  }
  const heading = deviceMarker.getElement()?.querySelector('.dev-heading');
  if (heading) {
    const moving = pos.mode === 'route' || pos.mode === 'joystick';
    heading.style.display = moving ? '' : 'none';
    heading.style.transform = `rotate(${pos.heading || 0}deg)`;
  }
  if (followDevice && (pos.mode === 'route' || pos.mode === 'joystick') && !map.getBounds().pad(-0.2).contains(ll)) {
    map.panTo(ll, { animate: true });
  }
}
map.on('dragstart', () => (followDevice = false));

// temporary pin for teleport targets
let pinMarker = null;
const pinIcon = L.divIcon({ className: '', html: '<div class="pin-marker"></div>', iconSize: [18, 18], iconAnchor: [9, 20] });

function showPin(lat, lon, label) {
  if (pinMarker) map.removeLayer(pinMarker);
  pinMarker = L.marker([lat, lon], { icon: pinIcon }).addTo(map);
  const box = document.createElement('div');
  box.className = 'popup';
  if (label) {
    const title = document.createElement('strong');
    title.textContent = label;
    box.append(title);
  }
  const code = document.createElement('code');
  code.textContent = fmtCoord(lat, lon);
  box.append(code);
  const row = document.createElement('div');
  row.className = 'row';
  const go = button('Teleport here', 'btn btn-primary', () => {
    map.closePopup();
    teleport(lat, lon, label);
  });
  const save = button('Save', 'btn', () => {
    addFavorite({ lat, lon, name: label || fmtCoord(lat, lon) });
    map.closePopup();
  });
  row.append(go, save);
  box.append(row);
  pinMarker.bindPopup(box, { closeButton: false, offset: [0, -14] }).openPopup();
  pinMarker.on('popupclose', () => {
    if (pinMarker) map.removeLayer(pinMarker);
    pinMarker = null;
  });
}

function button(text, cls, onClick) {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

map.on('click', (e) => {
  const { lat, lng } = e.latlng.wrap();
  if (state.tab === 'route') {
    if (state.gpx) {
      toast('Clear the imported GPX route before adding waypoints.');
      return;
    }
    state.waypoints.push({ lat, lon: lng });
    renderWaypoints();
    computeRoute();
  } else {
    showPin(lat, lng);
  }
});

// route layers
const routeLayer = L.layerGroup().addTo(map);

// ================================================================== engine bridge

async function call(method, params = {}) {
  const res = await window.locus.call(method, params);
  if (!res.ok) {
    const err = new Error(res.error || 'Unknown error');
    err.code = res.code;
    throw err;
  }
  return res.result;
}

window.locus.onEvent((msg) => {
  const { event, data } = msg;
  if (event === 'ready') onEngineReady();
  else if (event === 'engine') onEngineState(data);
  else if (event === 'status') onStatus(data);
  else if (event === 'position') onPosition(data);
  else if (event === 'route_done') {
    toast('Route finished — holding the final position.');
    onPosition(data);
  }
});

function setEnginePill(text, kind) {
  const pill = $('#enginePill');
  pill.textContent = text;
  pill.className = `pill pill-${kind}`;
}

async function onEngineReady() {
  state.engineReady = true;
  setEnginePill('Ready', 'muted');
  await pushOptions();
  refreshDevices();
}

function onEngineState(data) {
  state.engineReady = false;
  state.connected = null;
  setEnginePill(data.state === 'failed' ? 'Engine error' : 'Restarting…', 'bad');
  toast(data.message || 'The engine stopped unexpectedly.', 'error', 8000);
  renderDevice();
}

function onStatus(data) {
  if (data.state === 'connecting') {
    state.connecting = true;
    setStatus(data.message || 'Connecting…');
  } else if (data.state === 'connected') {
    state.connecting = false;
    state.connected = data.device;
    setStatus(`Connected via ${transportLabel(data.device.transport)}.`, 'ok');
    showHelp(null);
  } else if (data.state === 'reconnecting') {
    setEnginePill('Reconnecting…', 'warn');
    setStatus('Connection dropped — reconnecting…', 'error');
  } else if (data.state === 'disconnected') {
    state.connecting = false;
    state.connected = null;
    state.position = null;
    onPosition(null);
    if (data.message) setStatus(data.message, 'error');
  }
  renderDevice();
}

function transportLabel(t) {
  return { devicectl: 'Xcode devicectl', userspace: 'USB tunnel', native: 'macOS tunnel', lockdown: 'developer service' }[t] || t;
}

async function pushOptions() {
  const s = state.settings;
  window.locus.setClearOnQuit(s.clearOnQuit);
  try {
    await call('set_options', {
      jitterM: s.jitter,
      speedVariance: s.variance / 100,
      tunnelMode: s.transport,
      speedKmh: state.speedKmh,
    });
  } catch (e) {
    console.warn(e);
  }
}

// ================================================================== devices

let scanning = false;

async function refreshDevices({ quiet = false } = {}) {
  if (scanning || !state.engineReady) return;
  scanning = true;
  $('#refreshBtn').classList.add('spinning');
  try {
    state.devices = await call('list_devices');
    if (!state.devices.some((d) => d.udid === state.selectedUdid)) {
      state.selectedUdid = state.connected?.udid || state.devices[0]?.udid || '';
    }
    if (!quiet && !state.devices.length) showHelp('no_devices');
    else if (state.devices.length && $('#deviceHelp').dataset.code === 'no_devices') showHelp(null);
  } catch (e) {
    if (!quiet) toast(`Device scan failed: ${e.message}`, 'error');
  } finally {
    scanning = false;
    $('#refreshBtn').classList.remove('spinning');
    renderDevice();
  }
}

// Keep the list fresh while idle so plugging a phone in "just works".
setInterval(() => {
  if (!state.connected && !state.connecting && document.visibilityState === 'visible') refreshDevices({ quiet: true });
}, 10000);

function renderDevice() {
  const select = $('#deviceSelect');
  const prev = select.value;
  select.replaceChildren();
  if (!state.devices.length) {
    const opt = new Option(state.engineReady ? 'No iPhone found' : 'Starting engine…', '');
    select.append(opt);
  }
  for (const d of state.devices) {
    const label = `${d.name}${d.ios ? ` · iOS ${d.ios}` : ''}`;
    select.append(new Option(label, d.udid));
  }
  select.value = state.selectedUdid || prev || '';
  select.disabled = Boolean(state.connected || state.connecting);

  const dev = state.devices.find((d) => d.udid === select.value);
  const meta = $('#deviceMeta');
  meta.replaceChildren();
  if (dev) {
    const tags = [dev.connection, dev.model].filter(Boolean);
    if (dev.paired === false) tags.push('Not trusted');
    if (dev.developerMode === 'disabled') tags.push('Developer Mode off');
    for (const t of tags) {
      const span = document.createElement('span');
      span.className = 'tag';
      span.textContent = t;
      meta.append(span);
    }
  }

  const btn = $('#connectBtn');
  btn.disabled = !state.engineReady || state.connecting || (!state.connected && !select.value);
  btn.textContent = state.connecting ? 'Connecting…' : state.connected ? 'Disconnect' : 'Connect';
  btn.classList.toggle('btn-primary', !state.connected);
  btn.classList.toggle('connected', Boolean(state.connected));

  if (state.connected) setEnginePill(state.connected.name.length > 18 ? 'Connected' : state.connected.name, 'ok');
  else if (state.engineReady && !state.connecting) setEnginePill('Ready', 'muted');

  $('#resetBtn').disabled = !state.connected;
  renderRouteControls();
}

$('#deviceSelect').addEventListener('change', (e) => {
  state.selectedUdid = e.target.value;
  store.set('lastDevice', state.selectedUdid);
  renderDevice();
});

$('#refreshBtn').innerHTML = ICONS.refresh;
$('#refreshBtn').addEventListener('click', () => refreshDevices());

$('#connectBtn').addEventListener('click', async () => {
  if (state.connected) {
    try {
      await call('disconnect', { clear: true });
      setStatus('Disconnected — the iPhone is back on its real location.');
    } catch (e) {
      toast(e.message, 'error');
    }
    return;
  }
  const udid = $('#deviceSelect').value;
  if (!udid) return;
  store.set('lastDevice', udid);
  state.connecting = true;
  showHelp(null);
  renderDevice();
  try {
    await call('connect', { udid, tunnelMode: state.settings.transport });
  } catch (e) {
    state.connecting = false;
    setStatus(e.message, 'error');
    showHelp(e.code);
    renderDevice();
  }
});

function setStatus(text, kind = '') {
  const el = $('#deviceStatus');
  el.textContent = text || '';
  el.className = `status-line ${kind}`;
}

const IS_MAC = navigator.platform.toLowerCase().includes('mac');

function showHelp(code) {
  const el = $('#deviceHelp');
  el.replaceChildren();
  el.dataset.code = code || '';
  const add = (html) => {
    const div = document.createElement('div');
    div.innerHTML = html; // static, trusted strings only
    el.append(div);
  };
  if (code === 'developer_mode') {
    add(
      '<strong>Turn on Developer Mode</strong><ol><li>iPhone: Settings › Privacy &amp; Security › Developer Mode</li><li>Switch it on and restart</li><li>After reboot, unlock and tap “Turn On”</li></ol>',
    );
    el.append(
      button('Reveal Developer Mode toggle', 'btn', async () => {
        try {
          await call('reveal_developer_mode', { udid: $('#deviceSelect').value });
          toast('Check Settings › Privacy & Security on the iPhone.');
        } catch (e) {
          toast(e.message, 'error');
        }
      }),
    );
  } else if (code === 'trust_pending' || code === 'trust_denied') {
    add('<strong>Trust this computer</strong><ol><li>Unlock the iPhone</li><li>Tap “Trust” and enter the passcode</li><li>Click Connect again</li></ol>');
  } else if (code === 'no_devices' || code === 'not_found' || code === 'unreachable') {
    add(
      IS_MAC
        ? '<strong>No iPhone found</strong><ol><li>Connect the iPhone with a cable and unlock it</li><li>Tap “Trust” if asked</li><li>Install Xcode for the most reliable connection (Wi-Fi works once paired)</li></ol>'
        : '<strong>No iPhone found</strong><ol><li>Install <b>Apple Devices</b> (Microsoft Store) or iTunes — it provides the USB driver</li><li>Connect the iPhone with a cable and unlock it</li><li>Tap “Trust” if asked, then rescan</li></ol>',
    );
  } else if (code === 'tunnel_failed' || code === 'needs_admin_tunnel') {
    add(
      '<strong>Couldn’t open a developer connection</strong><ol><li>Keep the iPhone unlocked and on the cable</li><li>Make sure Developer Mode is on</li><li>Try another connection method under Advanced</li></ol>',
    );
  } else {
    el.hidden = true;
    return;
  }
  el.hidden = false;
}

// ================================================================== position / HUD

function onPosition(pos) {
  state.position = pos && pos.lat != null ? pos : null;
  updateDeviceMarker(state.position);
  const hud = $('#hud');
  if (!state.position) {
    hud.hidden = true;
    renderRouteControls();
    return;
  }
  hud.hidden = false;
  $('#hudCoords').textContent = fmtCoord(pos.lat, pos.lon);
  const modeLabel =
    pos.mode === 'route' ? (pos.paused ? 'Paused' : 'On route') : pos.mode === 'joystick' ? 'Joystick' : 'Static';
  $('#hudMode').textContent = modeLabel;
  if (pos.mode === 'static') reverseGeocode(pos.lat, pos.lon);
  else $('#hudAddress').textContent = pos.mode === 'route' ? `${pos.speedKmh} km/h` : `${pos.speedKmh} km/h · heading ${Math.round(pos.heading)}°`;
  renderRouteControls();
}

$('#copyBtn').innerHTML = ICONS.copy;
$('#copyBtn').addEventListener('click', async () => {
  if (!state.position) return;
  try {
    await navigator.clipboard.writeText(fmtCoord(state.position.lat, state.position.lon));
    toast('Coordinates copied.', 'info', 1800);
  } catch {
    toast('Could not access the clipboard.', 'error');
  }
});
$('#centerBtn').innerHTML = ICONS.target;
$('#centerBtn').addEventListener('click', () => {
  if (!state.position) return;
  followDevice = true;
  map.setView([state.position.lat, state.position.lon], Math.max(map.getZoom(), 15));
});

$('#resetBtn').addEventListener('click', async () => {
  try {
    await call('clear');
    toast('Simulation stopped — the iPhone is using its real GPS again.');
    setStatus('Real location restored.', 'ok');
  } catch (e) {
    toast(e.message, 'error');
  }
});

// ================================================================== geocoding

const NOMINATIM = 'https://nominatim.openstreetmap.org';
let lastGeocode = 0;
const geocodeCache = new Map();

async function nominatim(path) {
  // Nominatim's usage policy: at most one request per second.
  const wait = Math.max(0, lastGeocode + 1100 - Date.now());
  lastGeocode = Date.now() + wait;
  if (wait) await new Promise((r) => setTimeout(r, wait));
  const res = await window.locus.fetchJson(`${NOMINATIM}${path}`);
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

const reverseGeocode = debounce(async (lat, lon) => {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  let label = geocodeCache.get(key);
  if (label === undefined) {
    try {
      const data = await nominatim(`/reverse?format=jsonv2&zoom=17&lat=${lat}&lon=${lon}`);
      label = data?.display_name || '';
    } catch {
      label = '';
    }
    geocodeCache.set(key, label);
  }
  if (state.position && Math.abs(state.position.lat - lat) < 1e-6 && Math.abs(state.position.lon - lon) < 1e-6) {
    state.address = label;
    $('#hudAddress').textContent = label;
  }
}, 250);

$('.search-icon').innerHTML = ICONS.search;

$('#searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#searchInput').value.trim();
  const results = $('#searchResults');
  if (!q) {
    results.hidden = true;
    return;
  }
  const coord = parseCoordinates(q);
  if (coord && /^[\s\d.,\-@°NSEW]+$/i.test(q.replace(/https?:\/\/\S*@/, ''))) {
    results.hidden = true;
    map.setView([coord.lat, coord.lon], Math.max(map.getZoom(), 15));
    showPin(coord.lat, coord.lon);
    return;
  }
  results.hidden = false;
  results.replaceChildren(listItem({ title: 'Searching…', sub: q, iconName: 'search' }));
  try {
    const data = await nominatim(`/search?format=jsonv2&limit=8&q=${encodeURIComponent(q)}`);
    results.replaceChildren();
    if (!data.length) {
      results.append(listItem({ title: 'No results', sub: 'Try a different search, or paste coordinates.', iconName: 'search' }));
      return;
    }
    for (const r of data) {
      const lat = parseFloat(r.lat);
      const lon = parseFloat(r.lon);
      const [head, ...rest] = r.display_name.split(', ');
      results.append(
        listItem({
          title: head,
          sub: rest.join(', '),
          iconName: 'pin',
          onClick: () => {
            results.hidden = true;
            map.setView([lat, lon], Math.max(map.getZoom(), 15));
            if (state.connected) teleport(lat, lon, head);
            else showPin(lat, lon, head);
          },
        }),
      );
    }
  } catch (err) {
    results.replaceChildren(listItem({ title: 'Search failed', sub: err.message, iconName: 'search' }));
  }
});

$('#searchInput').addEventListener('input', (e) => {
  if (!e.target.value) $('#searchResults').hidden = true;
});

function listItem({ title, sub, iconName, onClick, onRemove }) {
  const li = document.createElement('li');
  li.className = 'item';
  if (iconName) li.append(icon(iconName));
  const main = document.createElement('div');
  main.className = 'item-main';
  const t = document.createElement('div');
  t.className = 'item-title';
  t.textContent = title;
  main.append(t);
  if (sub) {
    const s = document.createElement('div');
    s.className = 'item-sub';
    s.textContent = sub;
    main.append(s);
  }
  li.append(main);
  if (onClick) {
    li.tabIndex = 0;
    li.addEventListener('click', onClick);
    li.addEventListener('keydown', (e) => e.key === 'Enter' && onClick());
  } else {
    li.style.cursor = 'default';
  }
  if (onRemove) {
    const x = document.createElement('button');
    x.className = 'icon-btn small';
    x.title = 'Remove';
    x.setAttribute('aria-label', 'Remove');
    x.innerHTML = ICONS.x;
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      onRemove();
    });
    li.append(x);
  }
  return li;
}

// ================================================================== teleport, favorites, recents

function requireDevice() {
  if (state.connected) return true;
  toast('Connect an iPhone first.', 'error');
  return false;
}

async function teleport(lat, lon, name) {
  if (!requireDevice()) {
    showPin(lat, lon, name);
    return;
  }
  try {
    followDevice = true;
    await call('teleport', { lat, lon });
    map.setView([lat, lon], Math.max(map.getZoom(), 15));
    addRecent({ lat, lon, name: name || '' });
  } catch (e) {
    toast(e.message, 'error');
  }
}

function addRecent(place) {
  state.recents = [place, ...state.recents.filter((r) => fmtCoord(r.lat, r.lon) !== fmtCoord(place.lat, place.lon))].slice(0, 8);
  store.set('recents', state.recents);
  renderPlaces();
}

function addFavorite(place) {
  if (state.favorites.some((f) => fmtCoord(f.lat, f.lon) === fmtCoord(place.lat, place.lon))) {
    toast('Already in favorites.');
    return;
  }
  state.favorites = [place, ...state.favorites];
  store.set('favorites', state.favorites);
  renderPlaces();
  toast(`Saved “${place.name}”.`, 'info', 2000);
}

$('#saveFavBtn').addEventListener('click', () => {
  if (!state.position) {
    toast('Teleport somewhere first, or click the map and use “Save”.');
    return;
  }
  const { lat, lon } = state.position;
  const name = state.address ? state.address.split(', ').slice(0, 2).join(', ') : fmtCoord(lat, lon);
  addFavorite({ lat, lon, name });
});

function renderPlaces() {
  const go = (p) => () => {
    map.setView([p.lat, p.lon], Math.max(map.getZoom(), 15));
    if (state.connected) teleport(p.lat, p.lon, p.name);
    else showPin(p.lat, p.lon, p.name);
  };
  $('#favList').replaceChildren(
    ...state.favorites.map((f, i) =>
      listItem({
        title: f.name,
        sub: fmtCoord(f.lat, f.lon),
        iconName: 'star',
        onClick: go(f),
        onRemove: () => {
          state.favorites.splice(i, 1);
          store.set('favorites', state.favorites);
          renderPlaces();
        },
      }),
    ),
  );
  $('#favEmpty').hidden = state.favorites.length > 0;
  $('#recentList').replaceChildren(
    ...state.recents.map((r) =>
      listItem({ title: r.name || fmtCoord(r.lat, r.lon), sub: r.name ? fmtCoord(r.lat, r.lon) : '', iconName: 'clock', onClick: go(r) }),
    ),
  );
  $('#recentEmpty').hidden = state.recents.length > 0;
}

// ================================================================== tabs

$$('.tab').forEach((tab) =>
  tab.addEventListener('click', () => {
    state.tab = tab.dataset.tab;
    $$('.tab').forEach((t) => {
      t.classList.toggle('active', t === tab);
      t.setAttribute('aria-selected', String(t === tab));
    });
    $$('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === state.tab));
    $('#movement').hidden = state.tab === 'teleport';
    $('#routeControls').hidden = state.tab !== 'route';
    map.getContainer().style.cursor = state.tab === 'route' ? 'crosshair' : '';
  }),
);

// ================================================================== route

const wpIcon = (n) => L.divIcon({ className: '', html: `<div class="wp-marker">${n}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });

function renderWaypoints() {
  const list = $('#waypointList');
  if (state.gpx) {
    list.replaceChildren(
      listItem({
        title: state.gpx.name,
        sub: `GPX · ${state.gpx.points.length} points`,
        onRemove: clearRoute,
      }),
    );
  } else {
    list.replaceChildren(
      ...state.waypoints.map((w, i) =>
        listItem({
          title: `Waypoint ${i + 1}`,
          sub: fmtCoord(w.lat, w.lon),
          onRemove: () => {
            state.waypoints.splice(i, 1);
            renderWaypoints();
            computeRoute();
          },
        }),
      ),
    );
  }
  $('#waypointEmpty').hidden = Boolean(state.gpx) || state.waypoints.length > 0;
  drawRoute();
}

function drawRoute() {
  routeLayer.clearLayers();
  const color = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#3b82f6';
  if (state.routePath && state.routePath.length > 1) {
    L.polyline(state.routePath, { color: '#ffffff', weight: 8, opacity: 0.85 }).addTo(routeLayer);
    L.polyline(state.routePath, { color, weight: 5, opacity: 0.95 }).addTo(routeLayer);
  } else if (state.waypoints.length > 1) {
    L.polyline(state.waypoints.map((w) => [w.lat, w.lon]), { color, weight: 3, dashArray: '6 8', opacity: 0.7 }).addTo(routeLayer);
  }
  if (!state.gpx) {
    state.waypoints.forEach((w, i) => {
      const m = L.marker([w.lat, w.lon], { icon: wpIcon(i + 1), draggable: true }).addTo(routeLayer);
      m.on('dragend', () => {
        const ll = m.getLatLng().wrap();
        state.waypoints[i] = { lat: ll.lat, lon: ll.lng };
        renderWaypoints();
        computeRoute();
      });
    });
  }
  const s = $('#routeSummary');
  if (state.routePath && state.routeDistance != null) {
    const kmh = Math.max(1, state.speedKmh);
    s.textContent = `${fmtDist(state.routeDistance)} · about ${fmtDur(state.routeDistance / (kmh / 3.6))} at ${kmh} km/h`;
  } else {
    s.textContent = '';
  }
  renderRouteControls();
}

const OSRM_PROFILES = { foot: 'routed-foot', bike: 'routed-bike', car: 'routed-car' };
let routeSeq = 0;

function pathDistance(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += map.distance(points[i - 1], points[i]);
  return d;
}

const computeRoute = debounce(async () => {
  const seq = ++routeSeq;
  if (state.gpx) return;
  const wps = state.waypoints.map((w) => [w.lat, w.lon]);
  const loop = $('#loopCheck').checked;
  if (wps.length < 2) {
    state.routePath = null;
    state.routeDistance = null;
    drawRoute();
    return;
  }
  const pts = loop ? [...wps, wps[0]] : wps;
  if (state.profile === 'straight') {
    state.routePath = pts;
    state.routeDistance = pathDistance(pts);
    drawRoute();
    return;
  }
  $('#routeSummary').textContent = 'Finding a route…';
  try {
    const coords = pts.map(([lat, lon]) => `${lon.toFixed(6)},${lat.toFixed(6)}`).join(';');
    const url = `https://routing.openstreetmap.de/${OSRM_PROFILES[state.profile]}/route/v1/driving/${coords}?overview=full&geometries=geojson`;
    const res = await window.locus.fetchJson(url);
    if (seq !== routeSeq) return;
    if (!res.ok || res.data.code !== 'Ok' || !res.data.routes?.length) throw new Error(res.error || res.data?.message || 'No route');
    const route = res.data.routes[0];
    state.routePath = route.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    state.routeDistance = route.distance;
  } catch (e) {
    if (seq !== routeSeq) return;
    toast(`Couldn’t follow roads (${e.message}); using straight lines.`, 'error');
    state.routePath = pts;
    state.routeDistance = pathDistance(pts);
  }
  drawRoute();
}, 300);

function setProfile(profile) {
  state.profile = profile;
  store.set('profile', profile);
  $$('#profileSeg button').forEach((b) => {
    b.classList.toggle('active', b.dataset.profile === profile);
    b.setAttribute('aria-checked', String(b.dataset.profile === profile));
  });
}
$$('#profileSeg button').forEach((b) =>
  b.addEventListener('click', () => {
    setProfile(b.dataset.profile);
    const preset = { foot: 5, bike: 18, car: 50 }[b.dataset.profile];
    if (preset) setSpeed(preset);
    computeRoute();
  }),
);

$('#loopCheck').addEventListener('change', () => {
  if (state.gpx) {
    const pts = state.gpx.points;
    state.routePath = $('#loopCheck').checked ? [...pts, pts[0]] : pts;
    state.routeDistance = pathDistance(state.routePath);
    drawRoute();
  } else computeRoute();
});

function clearRoute() {
  state.waypoints = [];
  state.gpx = null;
  state.routePath = null;
  state.routeDistance = null;
  $('#profileSeg').style.opacity = '';
  renderWaypoints();
}
$('#clearRouteBtn').addEventListener('click', clearRoute);

$('#gpxBtn').addEventListener('click', async () => {
  const file = await window.locus.openGpx();
  if (!file) return;
  const doc = new DOMParser().parseFromString(file.text, 'application/xml');
  if (doc.querySelector('parsererror')) {
    toast('That file is not valid GPX.', 'error');
    return;
  }
  let nodes = Array.from(doc.getElementsByTagName('trkpt'));
  if (!nodes.length) nodes = Array.from(doc.getElementsByTagName('rtept'));
  if (!nodes.length) nodes = Array.from(doc.getElementsByTagName('wpt'));
  const points = nodes
    .map((n) => [parseFloat(n.getAttribute('lat')), parseFloat(n.getAttribute('lon'))])
    .filter(([a, b]) => isFinite(a) && isFinite(b));
  if (points.length < 2) {
    toast('The GPX file needs at least two points.', 'error');
    return;
  }
  state.gpx = { name: file.name, points };
  state.waypoints = [];
  state.routePath = $('#loopCheck').checked ? [...points, points[0]] : points;
  state.routeDistance = pathDistance(state.routePath);
  $('#profileSeg').style.opacity = '0.5';
  renderWaypoints();
  map.fitBounds(L.latLngBounds(points), { padding: [40, 40] });
});

function renderRouteControls() {
  const onRoute = state.position?.mode === 'route';
  $('#startRouteBtn').hidden = onRoute;
  $('#pauseRouteBtn').hidden = !onRoute;
  $('#stopRouteBtn').hidden = !onRoute;
  $('#startRouteBtn').disabled = !state.connected || !state.routePath || state.routePath.length < 2;
  $('#pauseRouteBtn').textContent = state.position?.paused ? 'Resume' : 'Pause';
  const bar = $('#progressBar');
  const text = $('#progressText');
  if (onRoute && state.position.progress != null) {
    bar.style.width = `${(state.position.progress * 100).toFixed(1)}%`;
    text.textContent = `${Math.round(state.position.progress * 100)}% · ${fmtDist(state.position.remainingM)} left · ${fmtDur(state.position.etaS)}`;
  } else {
    bar.style.width = '0';
    text.textContent = '';
  }
}

$('#startRouteBtn').addEventListener('click', async () => {
  if (!requireDevice() || !state.routePath) return;
  try {
    followDevice = true;
    const loop = $('#loopCheck').checked;
    await call('route_start', { points: state.routePath, speedKmh: state.speedKmh, loop });
    map.panTo(state.routePath[0]);
  } catch (e) {
    toast(e.message, 'error');
  }
});

$('#pauseRouteBtn').addEventListener('click', async () => {
  try {
    await call(state.position?.paused ? 'resume' : 'pause');
  } catch (e) {
    toast(e.message, 'error');
  }
});

$('#stopRouteBtn').addEventListener('click', async () => {
  try {
    await call('stop_motion');
  } catch (e) {
    toast(e.message, 'error');
  }
});

// ================================================================== speed

function setSpeed(kmh, { push = true } = {}) {
  kmh = Math.max(1, Math.min(300, Math.round(Number(kmh) || 1)));
  state.speedKmh = kmh;
  store.set('speedKmh', kmh);
  $('#speedInput').value = kmh;
  $('#speedRange').value = Math.min(kmh, 150);
  $$('#speedChips button').forEach((b) => b.classList.toggle('active', Number(b.dataset.speed) === kmh));
  drawRouteSummaryOnly();
  if (push) pushSpeed();
}

const pushSpeed = debounce(() => {
  if (state.connected) call('set_options', { speedKmh: state.speedKmh }).catch(() => {});
  if (joy.heading != null) sendJoystick(true);
}, 120);

function drawRouteSummaryOnly() {
  if (state.routePath && state.routeDistance != null) {
    const kmh = Math.max(1, state.speedKmh);
    $('#routeSummary').textContent = `${fmtDist(state.routeDistance)} · about ${fmtDur(state.routeDistance / (kmh / 3.6))} at ${kmh} km/h`;
  }
}

$('#speedRange').addEventListener('input', (e) => setSpeed(e.target.value));
$('#speedInput').addEventListener('change', (e) => setSpeed(e.target.value));
$$('#speedChips button').forEach((b) => b.addEventListener('click', () => setSpeed(b.dataset.speed)));

// ================================================================== joystick

const joy = { heading: null, lastSent: 0, lastHeading: null, keys: new Set() };
const pad = $('#joystick');
const knob = $('#joyKnob');
const KNOB_RANGE = 57;

function sendJoystick(force = false) {
  if (!state.connected) return;
  const now = Date.now();
  const changed =
    joy.lastHeading == null || joy.heading == null || Math.abs(((joy.heading - joy.lastHeading + 540) % 360) - 180) > 4;
  if (!force && !(changed && now - joy.lastSent > 120)) return;
  joy.lastSent = now;
  joy.lastHeading = joy.heading;
  call('joystick', { heading: joy.heading, speedKmh: state.speedKmh }).catch((e) => toast(e.message, 'error'));
}

function setJoyHeading(heading) {
  if (heading != null && !state.position) {
    toast('Set a starting point first: click the map and choose “Teleport here”.');
    return false;
  }
  if (heading != null && !requireDevice()) return false;
  const wasMoving = joy.heading != null;
  joy.heading = heading;
  $('#joyReadout').textContent = heading == null ? 'Idle' : `Heading ${Math.round(heading)}° · ${state.speedKmh} km/h`;
  sendJoystick(heading == null || !wasMoving);
  return true;
}

function headingFrom(dx, dy) {
  return (Math.atan2(dx, -dy) * 180) / Math.PI + 360;
}

pad.addEventListener('pointerdown', (e) => {
  pad.setPointerCapture(e.pointerId);
  pad.classList.add('dragging');
  moveKnob(e);
});
pad.addEventListener('pointermove', (e) => {
  if (pad.hasPointerCapture(e.pointerId)) moveKnob(e);
});
const releaseKnob = (e) => {
  if (e && pad.hasPointerCapture?.(e.pointerId)) pad.releasePointerCapture(e.pointerId);
  pad.classList.remove('dragging');
  knob.style.transform = '';
  setJoyHeading(null);
};
pad.addEventListener('pointerup', releaseKnob);
pad.addEventListener('pointercancel', releaseKnob);

function moveKnob(e) {
  const r = pad.getBoundingClientRect();
  let dx = e.clientX - (r.left + r.width / 2);
  let dy = e.clientY - (r.top + r.height / 2);
  const dist = Math.hypot(dx, dy);
  if (dist > KNOB_RANGE) {
    dx = (dx / dist) * KNOB_RANGE;
    dy = (dy / dist) * KNOB_RANGE;
  }
  knob.style.transform = `translate(${dx}px, ${dy}px)`;
  if (dist < 12) {
    if (joy.heading != null) setJoyHeading(null);
    return;
  }
  if (!setJoyHeading(headingFrom(dx, dy) % 360)) releaseKnob();
}

const KEY_VECTORS = {
  w: [0, -1], arrowup: [0, -1],
  s: [0, 1], arrowdown: [0, 1],
  a: [-1, 0], arrowleft: [-1, 0],
  d: [1, 0], arrowright: [1, 0],
};

function keyboardTarget(e) {
  const t = e.target;
  return state.tab === 'joystick' && !(t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement);
}

function applyKeys() {
  let x = 0;
  let y = 0;
  for (const k of joy.keys) {
    x += KEY_VECTORS[k][0];
    y += KEY_VECTORS[k][1];
  }
  if (x === 0 && y === 0) {
    knob.style.transform = '';
    setJoyHeading(null);
    return;
  }
  const len = Math.hypot(x, y);
  knob.style.transform = `translate(${(x / len) * KNOB_RANGE}px, ${(y / len) * KNOB_RANGE}px)`;
  if (!setJoyHeading(headingFrom(x, y) % 360)) {
    joy.keys.clear();
    knob.style.transform = '';
  }
}

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (!KEY_VECTORS[k] || !keyboardTarget(e) || e.metaKey || e.ctrlKey) return;
  e.preventDefault();
  if (joy.keys.has(k)) return;
  joy.keys.add(k);
  applyKeys();
});
window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (!joy.keys.delete(k)) return;
  applyKeys();
});
window.addEventListener('blur', () => {
  if (joy.keys.size) {
    joy.keys.clear();
    applyKeys();
  }
});

// ================================================================== settings

function bindSettings() {
  const s = state.settings;
  const jitter = $('#jitterRange');
  const variance = $('#varianceRange');
  jitter.value = s.jitter;
  variance.value = s.variance;
  $('#jitterOut').textContent = `${s.jitter} m`;
  $('#varianceOut').textContent = `${s.variance}%`;
  $('#transportSelect').value = s.transport;
  $('#mapStyleSelect').value = s.mapStyle;
  $('#clearOnQuitCheck').checked = s.clearOnQuit;
  if (!IS_MAC) $$('#transportSelect option[data-mac]').forEach((o) => o.remove());

  const save = () => {
    store.set('settings', state.settings);
    pushOptions();
  };
  jitter.addEventListener('input', () => {
    s.jitter = Number(jitter.value);
    $('#jitterOut').textContent = `${s.jitter} m`;
  });
  jitter.addEventListener('change', save);
  variance.addEventListener('input', () => {
    s.variance = Number(variance.value);
    $('#varianceOut').textContent = `${s.variance}%`;
  });
  variance.addEventListener('change', save);
  $('#transportSelect').addEventListener('change', (e) => {
    s.transport = e.target.value;
    save();
    if (state.connected) toast('The new connection method applies the next time you connect.');
  });
  $('#mapStyleSelect').addEventListener('change', (e) => {
    s.mapStyle = e.target.value;
    store.set('settings', state.settings);
    applyMapStyle();
  });
  $('#clearOnQuitCheck').addEventListener('change', (e) => {
    s.clearOnQuit = e.target.checked;
    save();
  });
}

// ================================================================== boot

bindSettings();
setProfile(state.profile);
setSpeed(state.speedKmh, { push: false });
renderPlaces();
renderWaypoints();
renderDevice();
window.locus.engineReady().then((ready) => ready && !state.engineReady && onEngineReady());
