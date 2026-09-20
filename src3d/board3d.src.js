// 3D-Ansicht für "Monopoly – Entenhausen" (Three.js). Reine Darstellung:
// Regeln und Zustand kommen unverändert vom Server; client.js übergibt bei
// jeder Änderung eine "view" (update) und ruft rollDice() beim Würfeln.
// Build: npm run build3d  ->  public/board3d.js (gebündelt, minifiziert)

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const CORNER = 1.45;
const S = CORNER * 2 + 9;          // Brettkante
const TILE_H = 0.14;                // Höhe der Felder
const TOP = TILE_H;                 // Oberkante
const PX = 200;                     // Textur-Pixel pro Einheit
const BAND = 0.24;

let O = null;                       // Optionen von client.js
let renderer, scene, camera, controls, canvas, container, ro;
let visible = false;
let tileMeshes = [];                // { pos, top, base, group, rect, frame, mort, houses[], owner, hasBump }
let tokens = {};                    // id -> Token
let dice = [];
let potTile = null;
let clock = new THREE.Clock();
let hoverPos = null;
let interactUntil = 0;
let viewState = { turnId: null };
let fitDist = 20;
let raycaster = new THREE.Raycaster();
let pointer = new THREE.Vector2();
let tweens = [];
let pulse = 0;
let sizes = null;
let lastPot = null;
let decks = [];

const SIZES = [CORNER, 1, 1, 1, 1, 1, 1, 1, 1, 1, CORNER];

function gridPos(pos) {
  if (pos === 0) return [11, 11];
  if (pos < 10) return [11, 11 - pos];
  if (pos === 10) return [11, 1];
  if (pos < 20) return [11 - (pos - 10), 1];
  if (pos === 20) return [1, 1];
  if (pos < 30) return [1, 1 + (pos - 20)];
  if (pos === 30) return [1, 11];
  return [1 + (pos - 30), 11];
}

function rectOf(pos) {
  const [row, col] = gridPos(pos);
  let x = -S / 2; for (let i = 0; i < col - 1; i++) x += SIZES[i];
  let z = -S / 2; for (let i = 0; i < row - 1; i++) z += SIZES[i];
  const w = SIZES[col - 1], d = SIZES[row - 1];
  return { cx: x + w / 2, cz: z + d / 2, w, d, row, col };
}

function bandSide(r) {
  if (r.row === 11 && r.col !== 1 && r.col !== 11) return 'n';
  if (r.row === 1 && r.col !== 1 && r.col !== 11) return 's';
  if (r.col === 1 && r.row !== 1 && r.row !== 11) return 'e';
  if (r.col === 11 && r.row !== 1 && r.row !== 11) return 'w';
  return null;
}

const FONT = '"Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';

function wrap(ctx, text, maxW) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = '';
  words.forEach((w) => {
    const t = cur ? cur + ' ' + w : w;
    if (ctx.measureText(t).width <= maxW || !cur) cur = t; else { lines.push(cur); cur = w; }
  });
  if (cur) lines.push(cur);
  return lines;
}

function fitText(ctx, text, maxW, maxLines, size, weight) {
  let fs = size;
  for (; fs >= 14; fs -= 2) {
    ctx.font = `${weight} ${fs}px ${FONT}`;
    const lines = wrap(ctx, text, maxW);
    if (lines.length <= maxLines && lines.every((l) => ctx.measureText(l).width <= maxW)) return { fs, lines };
  }
  ctx.font = `${weight} 14px ${FONT}`;
  return { fs: 14, lines: wrap(ctx, text, maxW) };
}

function drawTile(canvas, sq, r, extra) {
  const W = canvas.width, H = canvas.height;
  const c = canvas.getContext('2d');
  const side = bandSide(r);
  const corner = !side;
  c.fillStyle = '#dcefdf';
  c.fillRect(0, 0, W, H);
  let bx = 0, by = 0, bw = W, bh = H;
  const grp = sq.group && O.GROUPS[sq.group];
  if (side && sq.type === 'property' && grp) {
    const bt = Math.round((side === 'n' || side === 's' ? H : W) * BAND);
    c.fillStyle = grp.color;
    if (side === 'n') { c.fillRect(0, 0, W, bt); by = bt; bh = H - bt; }
    if (side === 's') { c.fillRect(0, H - bt, W, bt); bh = H - bt; }
    if (side === 'e') { c.fillRect(W - bt, 0, bt, H); bw = W - bt; }
    if (side === 'w') { c.fillRect(0, 0, bt, H); bx = bt; bw = W - bt; }
    c.strokeStyle = '#14261b'; c.lineWidth = 3;
    if (side === 'n') { c.beginPath(); c.moveTo(0, bt); c.lineTo(W, bt); c.stroke(); }
    if (side === 's') { c.beginPath(); c.moveTo(0, H - bt); c.lineTo(W, H - bt); c.stroke(); }
    if (side === 'e') { c.beginPath(); c.moveTo(W - bt, 0); c.lineTo(W - bt, H); c.stroke(); }
    if (side === 'w') { c.beginPath(); c.moveTo(bt, 0); c.lineTo(bt, H); c.stroke(); }
  }
  if (corner) {
    const bg = { go: '#dcefdf', jail: '#f6b04a', parking: '#e9f4ea', gotojail: '#c8dcf4' }[sq.type];
    if (bg) { c.fillStyle = bg; c.fillRect(0, 0, W, H); }
  }
  c.strokeStyle = '#14261b'; c.lineWidth = 6; c.strokeRect(0, 0, W, H);

  const cx = bx + bw / 2;
  c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#14261b';
  const maxW = bw - 18;
  const put = (text, y, size, weight, color, lines) => {
    const f = fitText(c, text, maxW, lines || 2, size, weight || '700');
    c.font = `${weight || '700'} ${f.fs}px ${FONT}`;
    c.fillStyle = color || '#14261b';
    const lh = f.fs * 1.12;
    f.lines.forEach((l, i) => c.fillText(l, cx, y + (i - (f.lines.length - 1) / 2) * lh));
    return f.lines.length * lh;
  };
  const icon = (ch, y, size) => { c.font = `${size}px ${FONT}`; c.fillStyle = '#14261b'; c.fillText(ch, cx, y); };

  if (sq.type === 'property') {
    put(sq.name, by + bh * 0.42, 30, '800', null, 3);
    put(sq.price + ' ₮', by + bh * 0.84, 26, '600', '#2b4636', 1);
  } else if (sq.type === 'station' || sq.type === 'utility') {
    icon(sq.icon || '🚂', by + bh * 0.24, 46);
    put(sq.name, by + bh * 0.56, 26, '800', null, 3);
    put(sq.price + ' ₮', by + bh * 0.88, 24, '600', '#2b4636', 1);
  } else if (sq.type === 'tax') {
    icon('💸', by + bh * 0.26, 50);
    put(sq.name, by + bh * 0.58, 24, '800', null, 3);
    put('zahle ' + sq.amount + ' ₮', by + bh * 0.88, 24, '600', '#2b4636', 1);
  } else if (sq.type === 'chance') {
    icon('🔮', by + bh * 0.3, 60); put(sq.name, by + bh * 0.72, 26, '800', null, 2);
  } else if (sq.type === 'community') {
    icon('🐤', by + bh * 0.3, 60); put(sq.name, by + bh * 0.72, 26, '800', null, 2);
  } else if (sq.type === 'go') {
    icon('➡️', H * 0.3, 80); put('LOS', H * 0.62, 50, '900', '#b3261c', 1); put('Ziehe 200 ₮ ein', H * 0.86, 24, '600', '#2b4636', 1);
  } else if (sq.type === 'jail') {
    icon('🚔', H * 0.32, 80); put('Panzerknacker-Knast', H * 0.66, 30, '800', null, 2); put('nur zu Besuch', H * 0.9, 22, '600', '#5a3b12', 1);
  } else if (sq.type === 'parking') {
    icon('🅿️', H * 0.3, 80); put('Frei Parken', H * 0.64, 36, '800', null, 1); put((extra && extra.sub) || 'Kleine Pause', H * 0.88, 26, '800', (extra && extra.hot) ? '#b3261e' : '#4a5f52', 1);
  } else if (sq.type === 'gotojail') {
    icon('👮', H * 0.3, 80); put('Gehe in den Knast', H * 0.68, 32, '800', null, 2);
  }
}

function tileCanvas(sq, r, extra) {
  const cv = document.createElement('canvas');
  cv.width = Math.round(r.w * PX); cv.height = Math.round(r.d * PX);
  drawTile(cv, sq, r, extra);
  return cv;
}

function tex(cv) {
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// ---------------------------------------------------------------- Aufbau

function buildBoard() {
  const wood = new THREE.MeshStandardMaterial({ color: 0x4a3320, roughness: 0.7 });
  const base = new THREE.Mesh(new THREE.BoxGeometry(S + 0.6, 0.36, S + 0.6), wood);
  base.position.y = -0.18 - 0.001;
  base.receiveShadow = true; base.castShadow = true;
  scene.add(base);

  const inner = S - CORNER * 2;
  const centre = new THREE.Mesh(new THREE.BoxGeometry(inner, TILE_H, inner), new THREE.MeshStandardMaterial({ color: 0xcfe6d2, roughness: 0.9 }));
  centre.position.y = TILE_H / 2;
  centre.receiveShadow = true;
  scene.add(centre);

  // Logo
  const lc = document.createElement('canvas'); lc.width = 1024; lc.height = 360;
  const c = lc.getContext('2d');
  const g = c.createLinearGradient(0, 0, 0, 360); g.addColorStop(0, '#e2453a'); g.addColorStop(1, '#b3261c');
  c.fillStyle = '#fff'; c.fillRect(0, 0, 1024, 360);
  c.fillStyle = g; c.fillRect(18, 18, 988, 324);
  c.strokeStyle = '#b3261c'; c.lineWidth = 6; c.strokeRect(6, 6, 1012, 348);
  c.fillStyle = '#fff'; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.font = `900 170px ${FONT}`; c.shadowColor = 'rgba(0,0,0,0.35)'; c.shadowBlur = 8; c.shadowOffsetY = 6;
  c.fillText('MONOPOLY', 512, 152);
  c.shadowColor = 'transparent';
  c.font = `700 58px ${FONT}`; c.fillText('E N T E N H A U S E N', 512, 274);
  const logo = new THREE.Mesh(new THREE.PlaneGeometry(6.2, 6.2 * 360 / 1024), new THREE.MeshStandardMaterial({ map: tex(lc), roughness: 0.6 }));
  logo.rotation.x = -Math.PI / 2; logo.rotation.z = 0.06;
  logo.position.y = TOP + 0.01;
  logo.receiveShadow = true;
  scene.add(logo);

  // Kartenstapel
  [['community', '🐤', 'Tick, Trick & Track', '#cdeeff', -2.4, -2.4, 0.55], ['chance', '🔮', 'Gundels Zauberei', '#ffd9b0', 2.4, 2.4, 0.55]].forEach(([id, ico, label, col, x, z, yaw], i) => {
    const cv = document.createElement('canvas'); cv.width = 400; cv.height = 260;
    const k = cv.getContext('2d');
    k.fillStyle = col; k.fillRect(0, 0, 400, 260);
    k.strokeStyle = '#14261b'; k.lineWidth = 10; k.setLineDash([26, 14]); k.strokeRect(14, 14, 372, 232);
    k.setLineDash([]); k.textAlign = 'center'; k.textBaseline = 'middle'; k.fillStyle = '#14261b';
    k.font = `100px ${FONT}`; k.fillText(ico, 200, 100);
    k.font = `800 34px ${FONT}`; k.fillText(label, 200, 196);
    const t = tex(cv);
    const sideMat = new THREE.MeshStandardMaterial({ color: 0xf4f4ea });
    const topMat = new THREE.MeshStandardMaterial({ map: t, roughness: 0.6 });
    const deck = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.26, 1.45), [sideMat, sideMat, topMat, sideMat, sideMat, sideMat]);
    deck.position.set(x, TOP + 0.13, z);
    deck.rotation.y = i === 0 ? -yaw : -yaw + Math.PI * 0 ;
    deck.castShadow = true; deck.receiveShadow = true;
    deck.userData.base = deck.position.y;
    deck.userData.phase = i * 2;
    scene.add(deck);
    decks.push(deck);
  });

  // Felder
  const sideMat = new THREE.MeshStandardMaterial({ color: 0x8fa896, roughness: 0.8 });
  for (let pos = 0; pos < 40; pos++) {
    const sq = O.SQUARES[pos];
    const r = rectOf(pos);
    const group = new THREE.Group();
    group.position.set(r.cx, 0, r.cz);
    const body = new THREE.Mesh(new THREE.BoxGeometry(r.w - 0.02, TILE_H, r.d - 0.02), sideMat);
    body.position.y = TILE_H / 2;
    body.castShadow = true; body.receiveShadow = true;
    group.add(body);
    const topMat = new THREE.MeshStandardMaterial({ map: tex(tileCanvas(sq, r)), roughness: 0.75 });
    const top = new THREE.Mesh(new THREE.PlaneGeometry(r.w - 0.02, r.d - 0.02), topMat);
    top.rotation.x = -Math.PI / 2; top.position.y = TOP + 0.002;
    top.receiveShadow = true;
    top.userData.pos = pos;
    group.add(top);
    scene.add(group);
    const t = { pos, group, top, topMat, rect: r, side: bandSide(r), houses: [], frame: null, mort: null, owner: null, houseCount: 0, mortgaged: false };
    tileMeshes[pos] = t;
    if (sq.type === 'parking') potTile = t;
  }
}

function makeFrame(t, color) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, roughness: 0.5 });
  const { w, d } = t.rect; const th = 0.07;
  [[0, -(d / 2 - th / 2), w - 0.02, th], [0, d / 2 - th / 2, w - 0.02, th], [-(w / 2 - th / 2), 0, th, d - 0.02], [w / 2 - th / 2, 0, th, d - 0.02]].forEach(([x, z, sw, sd]) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sw, 0.05, sd), mat);
    m.position.set(x, TOP + 0.02, z);
    g.add(m);
  });
  g.userData.mat = mat;
  return g;
}

const houseMat = new THREE.MeshStandardMaterial({ color: 0x1fa855, roughness: 0.5 });
const roofMat = new THREE.MeshStandardMaterial({ color: 0x0b6a33, roughness: 0.6 });
const hotelMat = new THREE.MeshStandardMaterial({ color: 0xd63a2f, roughness: 0.5 });
const hotelRoof = new THREE.MeshStandardMaterial({ color: 0x8c1f18, roughness: 0.6 });
const houseGeo = new THREE.BoxGeometry(0.17, 0.13, 0.17);
const roofGeo = new THREE.ConeGeometry(0.15, 0.1, 4);
const hotelGeo = new THREE.BoxGeometry(0.62, 0.2, 0.24);
const hotelRoofGeo = new THREE.BoxGeometry(0.66, 0.06, 0.28);

function bandCentre(t) {
  const { w, d } = t.rect;
  const len = t.side === 'n' || t.side === 's' ? d : w;
  const bt = len * BAND;
  const off = len / 2 - bt / 2;
  if (t.side === 'n') return { x: 0, z: -off, alongX: true };
  if (t.side === 's') return { x: 0, z: off, alongX: true };
  if (t.side === 'e') return { x: off, z: 0, alongX: false };
  return { x: -off, z: 0, alongX: false };
}

function buildHouse(hotel) {
  const g = new THREE.Group();
  const b = new THREE.Mesh(hotel ? hotelGeo : houseGeo, hotel ? hotelMat : houseMat);
  b.position.y = hotel ? 0.1 : 0.065; b.castShadow = true; g.add(b);
  if (hotel) { const r = new THREE.Mesh(hotelRoofGeo, hotelRoof); r.position.y = 0.23; r.castShadow = true; g.add(r); }
  else { const r = new THREE.Mesh(roofGeo, roofMat); r.position.y = 0.18; r.rotation.y = Math.PI / 4; r.castShadow = true; g.add(r); }
  return g;
}

function setHouses(t, n, animate) {
  t.houses.forEach((h) => t.group.remove(h));
  t.houses = [];
  const bc = bandCentre(t);
  if (n === 5) {
    const h = buildHouse(true);
    h.position.set(bc.x, TOP, bc.z);
    if (!bc.alongX) h.rotation.y = Math.PI / 2;
    t.group.add(h); t.houses.push(h);
    if (animate) popIn(h);
  } else {
    for (let i = 0; i < n; i++) {
      const h = buildHouse(false);
      const o = (i - 1.5) * 0.22;
      h.position.set(bc.x + (bc.alongX ? o : 0), TOP, bc.z + (bc.alongX ? 0 : o));
      t.group.add(h); t.houses.push(h);
      if (animate && i === n - 1) popIn(h);
    }
  }
}

function popIn(obj) {
  obj.scale.setScalar(0.01);
  tweens.push({ t: 0, dur: 0.55, fn: (k) => { const e = 1 + 2.2 * Math.pow(k - 1, 3) + 1.2 * Math.pow(k - 1, 2); obj.scale.setScalar(Math.max(0.01, e)); }, done: () => obj.scale.setScalar(1) });
}

function bump(t) {
  tweens.push({ t: 0, dur: 0.6, fn: (k) => { t.group.position.y = Math.sin(k * Math.PI) * 0.35 * (1 - k * 0.3); }, done: () => { t.group.position.y = 0; } });
}

// ---------------------------------------------------------------- Figuren

function pawnGeo() {
  const pts = [[0.001, 0], [0.26, 0], [0.26, 0.06], [0.14, 0.14], [0.1, 0.35], [0.18, 0.38], [0.18, 0.44], [0.09, 0.5], [0.15, 0.6], [0.15, 0.72], [0.09, 0.82], [0.001, 0.86]].map(([x, y]) => new THREE.Vector2(x, y));
  return new THREE.LatheGeometry(pts, 20);
}
let PAWN = null;

function emojiSprite(emoji, color) {
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const c = cv.getContext('2d');
  c.fillStyle = '#fff'; c.beginPath(); c.arc(64, 64, 58, 0, Math.PI * 2); c.fill();
  c.strokeStyle = color; c.lineWidth = 12; c.stroke();
  c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = `68px ${FONT}`; c.fillText(emoji, 64, 70);
  const m = new THREE.SpriteMaterial({ map: tex(cv), depthWrite: false });
  const s = new THREE.Sprite(m);
  s.scale.set(0.62, 0.62, 1);
  return s;
}

function makeToken(p) {
  if (!PAWN) PAWN = pawnGeo();
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(p.color), roughness: 0.35, metalness: 0.25 });
  const pawn = new THREE.Mesh(PAWN, mat);
  pawn.castShadow = true; pawn.scale.setScalar(0.95);
  group.add(pawn);
  const sprite = emojiSprite(p.emoji, p.color);
  sprite.position.y = 1.32;
  group.add(sprite);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.46, 32), new THREE.MeshBasicMaterial({ color: 0xf4c95d, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.012; ring.visible = false;
  group.add(ring);
  scene.add(group);
  const cage = new THREE.Group();
  const cm = new THREE.MeshStandardMaterial({ color: 0x33363c, metalness: 0.6, roughness: 0.4 });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 1.0, 6), cm);
    bar.position.set(Math.cos(a) * 0.42, 0.5, Math.sin(a) * 0.42);
    cage.add(bar);
  }
  const lid = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.02, 6, 24), cm); lid.rotation.x = Math.PI / 2; lid.position.y = 1.0; cage.add(lid);
  cage.visible = false;
  group.add(cage);
  return { id: p.id, group, pawn, sprite, ring, cage, mat, pos: null, target: null, from: new THREE.Vector3(), to: new THREE.Vector3(), tw: null, bob: Math.random() * 6 };
}

function slotFor(pos, idx, n, jailed) {
  const r = tileMeshes[pos].rect;
  let x = r.cx, z = r.cz;
  if (jailed) { x += r.w * 0.16; z -= r.d * 0.16; }
  else if (n > 1) {
    const a = (idx / n) * Math.PI * 2 + 0.6;
    const rad = r.w > 1.2 ? 0.32 : 0.27;
    x += Math.cos(a) * rad; z += Math.sin(a) * rad;
  }
  return new THREE.Vector3(x, TOP + 0.005, z);
}

function moveToken(tk, dest, hopMs) {
  const cur = tk.group.position.clone();
  const dist = cur.distanceTo(dest);
  const step = dist < 2.2;
  tk.tw = { t: 0, dur: (step ? hopMs : Math.max(520, hopMs * 2.6)) / 1000, from: cur, to: dest, h: step ? 0.55 : 1.8 };
}

function layoutTokens(view, animate) {
  const counts = {};
  view.players.forEach((p) => { if (!p.bankrupt) counts[p.pos] = (counts[p.pos] || 0) + 1; });
  const seen = {};
  view.players.forEach((p) => {
    let tk = tokens[p.id];
    if (!tk) { tk = tokens[p.id] = makeToken(p); }
    tk.group.visible = !p.bankrupt;
    if (p.bankrupt) return;
    seen[p.pos] = (seen[p.pos] || 0) + 1;
    const jailed = p.inJail && p.pos === 10;
    const dest = slotFor(p.pos, seen[p.pos] - 1, counts[p.pos], jailed);
    tk.cage.visible = jailed;
    if (tk.pos === null) { tk.group.position.copy(dest); tk.pos = p.pos; tk.dest = dest; return; }
    if (tk.pos !== p.pos || !tk.dest || tk.dest.distanceToSquared(dest) > 1e-4) {
      tk.pos = p.pos;
      tk.dest = dest;
      if (animate) moveToken(tk, dest, view.fast ? 115 : 205); else tk.group.position.copy(dest);
    }
  });
}

// ---------------------------------------------------------------- Würfel

const FACE_ORDER = [2, 5, 1, 6, 3, 4]; // +x, -x, +y, -y, +z, -z
function pipTexture(n) {
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const c = cv.getContext('2d');
  c.fillStyle = '#fbfbf4'; c.fillRect(0, 0, 128, 128);
  c.strokeStyle = '#d5d5c8'; c.lineWidth = 6; c.strokeRect(3, 3, 122, 122);
  c.fillStyle = n === 1 ? '#c62828' : '#1a1a1a';
  const P = { 1: [[64, 64]], 2: [[36, 36], [92, 92]], 3: [[34, 34], [64, 64], [94, 94]], 4: [[36, 36], [92, 36], [36, 92], [92, 92]], 5: [[34, 34], [94, 34], [64, 64], [34, 94], [94, 94]], 6: [[36, 32], [92, 32], [36, 64], [92, 64], [36, 96], [92, 96]] }[n];
  P.forEach(([x, y]) => { c.beginPath(); c.arc(x, y, n === 1 ? 17 : 11, 0, Math.PI * 2); c.fill(); });
  return tex(cv);
}

function targetQuat(v, yaw) {
  const q = new THREE.Quaternion();
  const E = new THREE.Euler();
  if (v === 1) E.set(0, 0, 0);
  else if (v === 6) E.set(Math.PI, 0, 0);
  else if (v === 2) E.set(0, 0, Math.PI / 2);
  else if (v === 5) E.set(0, 0, -Math.PI / 2);
  else if (v === 3) E.set(-Math.PI / 2, 0, 0);
  else E.set(Math.PI / 2, 0, 0);
  q.setFromEuler(E);
  const y = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  return y.multiply(q);
}

function buildDice() {
  const mats = FACE_ORDER.map((n) => new THREE.MeshStandardMaterial({ map: pipTexture(n), roughness: 0.35 }));
  for (let i = 0; i < 2; i++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), mats);
    m.castShadow = true;
    m.userData.rest = new THREE.Vector3(i === 0 ? -0.75 : 0.75, TOP + 0.3, 1.5 + i * 0.25);
    m.position.copy(m.userData.rest);
    m.userData.val = 1;
    m.userData.yaw = i ? 0.5 : -0.3;
    m.quaternion.copy(targetQuat(1, m.userData.yaw));
    scene.add(m);
    dice.push(m);
  }
}

export function setDice(a, b) {
  [a, b].forEach((v, i) => { const d = dice[i]; if (!d || !v) return; d.userData.val = v; d.position.copy(d.userData.rest); d.quaternion.copy(targetQuat(v, d.userData.yaw)); });
}

export function rollDice(a, b, ms) {
  [a, b].forEach((v, i) => {
    const d = dice[i]; if (!d) return;
    const rest = d.userData.rest;
    const yaw = Math.random() * Math.PI * 2;
    d.userData.yaw = yaw;
    const targetQ = targetQuat(v, yaw);
    const start = new THREE.Vector3(rest.x - 5.5 + Math.random(), 5.5, rest.z + 4 - i * 1.5);
    const spin = new THREE.Vector3((3 + Math.random() * 3) * Math.PI, (2 + Math.random() * 3) * Math.PI, (2 + Math.random() * 3) * Math.PI);
    const dur = Math.max(0.4, ms / 1000);
    tweens.push({
      t: 0, dur,
      fn: (k) => {
        const e = 1 - Math.pow(1 - k, 2);
        d.position.x = start.x + (rest.x - start.x) * e;
        d.position.z = start.z + (rest.z - start.z) * e;
        const h = 5.0 * Math.pow(1 - k, 2) * Math.abs(Math.cos(k * Math.PI * 2.6));
        d.position.y = rest.y + h * (k < 0.98 ? 1 : 0);
        const sk = 1 - k;
        const spinQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(spin.x * sk, spin.y * sk, spin.z * sk));
        const blend = Math.min(1, Math.max(0, (k - 0.5) / 0.5));
        d.quaternion.copy(spinQ.multiply(targetQ)).slerp(targetQ, blend * blend);
      },
      done: () => { d.position.copy(rest); d.quaternion.copy(targetQ); d.userData.val = v; },
    });
  });
}

// ---------------------------------------------------------------- Kamera & Schleife

function fitDistance() {
  const w = container.clientWidth || 800, h = container.clientHeight || 600;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  const el = (58 * Math.PI) / 180;
  const dir = new THREE.Vector3(0, Math.sin(el), Math.cos(el));
  const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([x, z]) => new THREE.Vector3(x * (S / 2 + 0.4), 0, z * (S / 2 + 0.4)));
  let lo = 6, hi = 80;
  const tmp = camera.clone();
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    tmp.position.copy(dir).multiplyScalar(mid);
    tmp.lookAt(0, 0, 0); tmp.updateMatrixWorld(); tmp.updateProjectionMatrix();
    const ok = corners.every((c) => { const p = c.clone().project(tmp); return Math.abs(p.x) <= 0.96 && Math.abs(p.y) <= 0.96; });
    if (ok) hi = mid; else lo = mid;
  }
  fitDist = hi;
  return { dir, dist: hi };
}

export function resetView() {
  const { dir, dist } = fitDistance();
  camera.position.copy(dir).multiplyScalar(dist);
  controls.target.set(0, 0, 0);
  controls.minDistance = dist * 0.45;
  controls.maxDistance = dist * 1.25;
  controls.update();
}

function resize() {
  if (!renderer || !container) return;
  const w = container.clientWidth, h = container.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  const before = camera.position.length();
  const { dir, dist } = fitDistance();
  controls.minDistance = dist * 0.45; controls.maxDistance = dist * 1.25;
  if (!before || Math.abs(before / dist - 1) > 0.02) { camera.position.copy(camera.position.length() ? camera.position.clone().normalize() : dir).multiplyScalar(dist * (before ? Math.min(1.25, Math.max(0.45, before / (fitDist))) : 1)); }
  controls.update();
}

function tick() {
  if (!visible || !renderer) return;
  if (!container.clientWidth) return;
  const dt = Math.min(0.25, clock.getDelta());
  pulse += dt;
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i];
    tw.t += dt;
    const k = Math.min(1, tw.t / tw.dur);
    tw.fn(k);
    if (k >= 1) { tw.done && tw.done(); tweens.splice(i, 1); }
  }
  const activeId = viewState.turnId;
  Object.values(tokens).forEach((tk) => {
    if (tk.tw) {
      tk.tw.t += dt;
      const k = Math.min(1, tk.tw.t / tk.tw.dur);
      const e = k;
      tk.group.position.lerpVectors(tk.tw.from, tk.tw.to, e);
      tk.group.position.y = TOP + 0.005 + Math.sin(k * Math.PI) * tk.tw.h;
      tk.pawn.scale.set(0.95, 0.95 * (k > 0.9 ? 0.86 + (1 - k) * 1.4 : 1), 0.95);
      if (k >= 1) { tk.group.position.copy(tk.tw.to); tk.tw = null; tk.pawn.scale.setScalar(0.95); }
    } else {
      tk.pawn.scale.set(0.95, 0.95, 0.95);
    }
    const active = tk.id === activeId;
    tk.ring.visible = active;
    if (active) { tk.ring.material.opacity = 0.55 + Math.sin(pulse * 5) * 0.35; const s = 1 + Math.sin(pulse * 5) * 0.08; tk.ring.scale.set(s, s, s); if (!tk.tw) tk.pawn.position.y = Math.abs(Math.sin(pulse * 3)) * 0.06; }
    else tk.pawn.position.y = 0;
    tk.sprite.position.y = 1.32 + (active ? Math.sin(pulse * 3 + tk.bob) * 0.06 : 0);
  });
  decks.forEach((d) => { d.position.y = d.userData.base + Math.sin(pulse * 1.4 + d.userData.phase) * 0.05; });

  // Sanfte Kamera-Führung zur Figur am Zug (pausiert, solange man selbst dreht)
  if (performance.now() > interactUntil) {
    const tk = tokens[activeId];
    const want = tk ? new THREE.Vector3(tk.group.position.x * 0.22, 0, tk.group.position.z * 0.22) : new THREE.Vector3();
    controls.target.lerp(want, 0.025);
  }
  controls.update();
  renderer.render(scene, camera);
}

// ---------------------------------------------------------------- Öffentliche API

export function init(opts) {
  O = opts;
  tileMeshes = []; tokens = {}; dice = []; potTile = null; hoverPos = null; interactUntil = 0; viewState = { turnId: null }; tweens = []; lastPot = null; decks = []; firstUpdate = true;
  container = opts.container;
  canvas = document.createElement('canvas');
  canvas.className = 'board3d-canvas';
  container.insertBefore(canvas, container.firstChild);
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(38, 1, 0.5, 200);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x6d8f77, 1.05));
  const sun = new THREE.DirectionalLight(0xfff3dd, 1.5);
  sun.position.set(-7, 14, 9);
  sun.castShadow = true;
  const small = Math.min(window.innerWidth, window.innerHeight) < 700;
  sun.shadow.mapSize.set(small ? 1024 : 2048, small ? 1024 : 2048);
  const sc = sun.shadow.camera; sc.left = -10; sc.right = 10; sc.top = 10; sc.bottom = -10; sc.near = 1; sc.far = 40;
  sun.shadow.bias = -0.0004;
  scene.add(sun);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.ShadowMaterial({ opacity: 0.35 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.361; ground.receiveShadow = true;
  scene.add(ground);

  buildBoard();
  buildDice();

  controls = new OrbitControls(camera, canvas);
  controls.enablePan = false;
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.minPolarAngle = 0.25; controls.maxPolarAngle = 1.3;
  controls.rotateSpeed = 0.7;
  controls.addEventListener('start', () => { interactUntil = performance.now() + 6000; });
  controls.addEventListener('change', () => { if (performance.now() < interactUntil + 1) interactUntil = performance.now() + 6000; });

  // Klicks: Feld oder Figur
  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved > 6) return;
    const hit = pick(e);
    if (!hit) return;
    if (hit.token) O.onToken && O.onToken(hit.token); else if (hit.pos !== undefined) O.onTile && O.onTile(hit.pos);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    const hit = pick(e);
    const p = hit && hit.pos !== undefined ? hit.pos : null;
    if (p !== hoverPos) {
      if (hoverPos !== null) tileMeshes[hoverPos].topMat.emissive.setHex(0x000000);
      hoverPos = p;
      if (p !== null && O.isPickable && O.isPickable(p)) tileMeshes[p].topMat.emissive.setHex(0x223a26);
      canvas.style.cursor = hit ? 'pointer' : 'grab';
    }
  });

  ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();
  resetView();
  renderer.setAnimationLoop(tick);
}

function pick(e) {
  const rect = canvas.getBoundingClientRect();
  pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const pawns = Object.values(tokens).filter((t) => t.group.visible).flatMap((t) => [t.pawn, t.sprite]);
  const ph = raycaster.intersectObjects(pawns, false)[0];
  if (ph) { const tk = Object.values(tokens).find((t) => t.pawn === ph.object || t.sprite === ph.object); if (tk) return { token: tk.id }; }
  const th = raycaster.intersectObjects(tileMeshes.map((t) => t.top), false)[0];
  if (th) return { pos: th.object.userData.pos };
  return null;
}

export function setVisible(v) {
  visible = v;
  if (canvas) canvas.style.display = v ? 'block' : 'none';
  if (v) { clock.getDelta(); resize(); }
}

let firstUpdate = true;
export function update(view) {
  if (!renderer) return;
  viewState.turnId = view.turnId;
  // Grundstücke
  const byPos = {};
  view.props.forEach((p) => { byPos[p.pos] = p; });
  tileMeshes.forEach((t) => {
    const p = byPos[t.pos];
    const owner = p ? p.owner : null;
    if (owner !== t.owner) {
      if (t.frame) { t.group.remove(t.frame); t.frame = null; }
      if (owner) { t.frame = makeFrame(t, new THREE.Color(p.ownerColor)); t.group.add(t.frame); if (!firstUpdate) bump(t); }
      t.owner = owner;
    }
    const houses = p ? p.houses : 0;
    if (houses !== t.houseCount) { setHouses(t, houses, !firstUpdate && houses > t.houseCount); t.houseCount = houses; }
    const mort = !!(p && p.mortgaged);
    if (mort !== t.mortgaged) {
      t.mortgaged = mort;
      if (mort && !t.mort) {
        t.mort = new THREE.Mesh(new THREE.PlaneGeometry(t.rect.w - 0.02, t.rect.d - 0.02), new THREE.MeshBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.55 }));
        t.mort.rotation.x = -Math.PI / 2; t.mort.position.y = TOP + 0.006;
        t.group.add(t.mort);
      }
      if (t.mort) t.mort.visible = mort;
    }
  });
  // Frei Parken: Jackpot
  const potText = view.freeParking ? `Jackpot: ${view.pot} ₮` : 'Kleine Pause';
  if (potTile && potText !== lastPot) {
    lastPot = potText;
    const sq = O.SQUARES[20];
    potTile.topMat.map.dispose();
    potTile.topMat.map = tex(tileCanvas(sq, potTile.rect, { sub: potText, hot: view.freeParking }));
    potTile.topMat.needsUpdate = true;
  }
  layoutTokens(view, !firstUpdate);
  firstUpdate = false;
}

export function dispose() {
  if (!renderer) return;
  renderer.setAnimationLoop(null);
  ro && ro.disconnect();
  renderer.dispose();
  canvas.remove();
  renderer = null;
}
