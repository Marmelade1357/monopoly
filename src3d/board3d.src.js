// 3D-Ansicht für "Monopoly – Entenhausen" (Three.js). Reine Darstellung:
// Regeln und Zustand kommen unverändert vom Server; client.js übergibt bei
// jeder Änderung eine "view" (update) und ruft rollDice() beim Würfeln.
// Build: npm run build3d  ->  public/board3d.js (gebündelt, minifiziert)

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const CORNER = 1.45;
const S = CORNER * 2 + 9;          // Brettkante
const TILE_H = 0.14;                // Höhe der Felder
const TOP = TILE_H;                 // Oberkante
const PX = 340;                     // Textur-Pixel pro Einheit
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
let maxAniso = 4;
let camMode = 'soft';          // 'soft' (sanft nachführen) | 'fixed' | 'cinema'
let diceUntil = 0;
let cardObj = null;
let elevDeg = 65;
let lights = null;
let lightMode = 'day';
let potGroup = null, potCount = -1;
let drawn = { chance: 0, community: 0 };
let puffT = 0;
let camHold = null;
let camF = { x: 0, z: 0, zoom: 1 };

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

const SUFFIXES = ['straße', 'strasse', 'allee', 'platz', 'weg', 'markt', 'wiese', 'teich', 'viertel', 'bahn', 'werk', 'speicher', 'ring', 'bude', 'kai', 'lager', 'turm', 'express', 'linie', 'gasse', 'garten', 'hügel', 'mühle'];

// Zu lange Einzelwörter werden umbrochen (bevorzugt vor "-straße", "-platz" ...), statt die Schrift zu verkleinern.
let ugly = false;
function breakWord(ctx, word, maxW) {
  if (ctx.measureText(word).width <= maxW) return [word];
  if (word.includes('-') && !word.endsWith('-')) return word.split(/(?<=-)/).flatMap((w) => breakWord(ctx, w, maxW));
  const low = word.toLowerCase();
  for (const suf of SUFFIXES) {
    const i = low.lastIndexOf(suf);
    if (i > 2 && i + suf.length === low.length) {
      const a = word.slice(0, i) + (word[i - 1] === '-' ? '' : '-'), b = word.slice(i);
      if (ctx.measureText(a).width <= maxW && ctx.measureText(b).width <= maxW) return [a, b];
    }
  }
  // Silbentrennung (grob): größtes Stück, das mit "-" noch passt, an einer Silbengrenze
  let cut = 2;
  while (cut < word.length - 1 && ctx.measureText(word.slice(0, cut + 1) + '-').width <= maxW) cut++;
  const V = /[aeiouäöüyAEIOUÄÖÜY]/;
  let at = -1;
  for (let i = cut; i >= 3; i--) {
    const p = word[i - 1], c = word[i], n = word[i + 1] || '';
    if ((V.test(p) && !V.test(c) && V.test(n)) || (!V.test(p) && !V.test(c))) { at = i; break; }
  }
  ugly = true;
  if (at < 0) at = cut;
  return [word.slice(0, at) + '-', ...breakWord(ctx, word.slice(at), maxW)];
}

function wrap(ctx, text, maxW) {
  const words = String(text).split(/\s+/).flatMap((w) => breakWord(ctx, w, maxW));
  const lines = [];
  let cur = '';
  words.forEach((w) => {
    const t = cur ? (cur.endsWith('-') ? cur + w : cur + ' ' + w) : w;
    if (ctx.measureText(t).width <= maxW || !cur) cur = t; else { lines.push(cur); cur = w; }
  });
  if (cur) lines.push(cur);
  return lines;
}

// Einheitliche Schriftgröße: Es wird umgebrochen statt verkleinert. Nur wenn es trotzdem
// nicht in die erlaubten Zeilen passt, wird die Schrift in kleinen Schritten reduziert.
function fitText(ctx, text, maxW, maxLines, size, weight) {
  let fs = size;
  const minFs = Math.round(size * 0.8);
  for (; fs >= minFs; fs -= 2) {
    ctx.font = `${weight} ${fs}px ${FONT}`;
    const lines = wrap(ctx, text, maxW);
    if (lines.length <= maxLines) return { fs, lines };
  }
  fs += 2;
  ctx.font = `${weight} ${fs}px ${FONT}`;
  return { fs, lines: wrap(ctx, text, maxW) };
}

function drawTile(canvas, sq, r, extra) {
  const K = PX / 200;
  const W = canvas.width / K, H = canvas.height / K;
  const c = canvas.getContext('2d');
  c.setTransform(K, 0, 0, K, 0, 0);
  const side = bandSide(r);
  const corner = !side;
  c.fillStyle = '#e6f3e8';
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

  const eg = (x0, y0, x1, y1, rx, ry, rw, rh) => { const g = c.createLinearGradient(x0, y0, x1, y1); g.addColorStop(0, 'rgba(0,0,0,0.17)'); g.addColorStop(1, 'rgba(0,0,0,0)'); c.fillStyle = g; c.fillRect(rx, ry, rw, rh); };
  eg(0, 0, 0, 14, 0, 0, W, 14); eg(0, H, 0, H - 14, 0, H - 14, W, 14); eg(0, 0, 14, 0, 0, 0, 14, H); eg(W, 0, W - 14, 0, W - 14, 0, 14, H);

  const cx = bx + bw / 2;
  c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#14261b';
  const maxW = bw - 8;
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
    put(sq.name, by + bh * 0.4, 28, '900', null, 4);
    put(sq.price + ' ₮', by + bh * 0.86, 28, '800', '#2b4636', 1);
  } else if (sq.type === 'station' || sq.type === 'utility') {
    put(sq.name, by + bh * 0.6, 28, '900', null, 4);
    put(sq.price + ' ₮', by + bh * 0.9, 28, '800', '#2b4636', 1);
  } else if (sq.type === 'tax') {
    icon('💸', by + bh * 0.26, 50);
    put(sq.name, by + bh * 0.55, 28, '900', null, 4);
    put('zahle ' + sq.amount + ' ₮', by + bh * 0.88, 28, '800', '#2b4636', 1);
  } else if (sq.type === 'chance') {
    icon('🔮', by + bh * 0.3, 60); put(sq.name, by + bh * 0.72, 28, '900', null, 3);
  } else if (sq.type === 'community') {
    icon('🐤', by + bh * 0.3, 60); put(sq.name, by + bh * 0.72, 28, '900', null, 3);
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
  t.anisotropy = maxAniso;
  return t;
}

function woodTexture(baseH = 24, baseL = 26, rep = 5) {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1024;
  const c = cv.getContext('2d');
  const plank = 256;
  for (let i = 0; i < 4; i++) {
    const h = baseH + Math.random() * 10, l = baseL + Math.random() * 6;
    c.fillStyle = `hsl(${h},42%,${l}%)`; c.fillRect(0, i * plank, 1024, plank);
    for (let j = 0; j < 90; j++) {
      const y = i * plank + Math.random() * plank;
      c.strokeStyle = `hsla(${h - 4},40%,${l - 8 + Math.random() * 6}%,${0.12 + Math.random() * 0.22})`;
      c.lineWidth = 1 + Math.random() * 2.2;
      c.beginPath(); c.moveTo(0, y);
      c.bezierCurveTo(300, y + (Math.random() - 0.5) * 14, 700, y + (Math.random() - 0.5) * 14, 1024, y + (Math.random() - 0.5) * 6);
      c.stroke();
    }
    c.fillStyle = 'rgba(0,0,0,0.5)'; c.fillRect(0, i * plank, 1024, 3);
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rep, rep); t.anisotropy = maxAniso;
  return t;
}

// ---------------------------------------------------------------- Aufbau

function buildBoard() {
  const wt = woodTexture(20, 20, 3);
  wt.repeat.set(3, 1);
  const wood = new THREE.MeshStandardMaterial({ map: wt, roughness: 0.55 });
  const base = new THREE.Mesh(new RoundedBoxGeometry(S + 0.7, 0.36, S + 0.7, 4, 0.08), wood);
  base.position.y = -0.18 - 0.001;
  base.receiveShadow = true; base.castShadow = true;
  scene.add(base);
  // Rahmen: erhöhte, abgeschrägte Leisten rund um die Felder
  const fw = 0.34, fl = S + 0.7;
  const frameWood = new THREE.MeshStandardMaterial({ map: woodTexture(18, 16, 2), roughness: 0.4, metalness: 0.05 });
  [[0, -(S / 2 + 0.35 - fw / 2), fl, fw], [0, S / 2 + 0.35 - fw / 2, fl, fw], [-(S / 2 + 0.35 - fw / 2), 0, fw, S + 0.7 - fw * 2], [S / 2 + 0.35 - fw / 2, 0, fw, S + 0.7 - fw * 2]].forEach(([x, z, w, d]) => {
    const m = new THREE.Mesh(new RoundedBoxGeometry(w, 0.3, d, 3, 0.06), frameWood); m.position.set(x, 0.08, z); m.castShadow = true; m.receiveShadow = true; scene.add(m);
  });

  const inner = S - CORNER * 2;
  const centreTex = (() => {
    const cv = document.createElement('canvas'); cv.width = cv.height = 1024;
    const c = cv.getContext('2d');
    c.fillStyle = '#cfe6d2'; c.fillRect(0, 0, 1024, 1024);
    c.strokeStyle = 'rgba(40,90,60,0.07)'; c.lineWidth = 14;
    for (let i = -1024; i < 2048; i += 46) { c.beginPath(); c.moveTo(i, 0); c.lineTo(i + 1024, 1024); c.stroke(); }
    c.strokeStyle = 'rgba(40,90,60,0.1)'; c.lineWidth = 6;
    [470, 380, 290].forEach((r) => { c.beginPath(); c.arc(512, 512, r, 0, Math.PI * 2); c.stroke(); });
    const g = c.createRadialGradient(512, 512, 200, 512, 512, 760); g.addColorStop(0, 'rgba(255,255,255,0.22)'); g.addColorStop(1, 'rgba(20,50,30,0.16)');
    c.fillStyle = g; c.fillRect(0, 0, 1024, 1024);
    return tex(cv);
  })();
  const centre = new THREE.Mesh(new THREE.BoxGeometry(inner, TILE_H, inner), [0, 1, 2, 3, 4, 5].map((i) => new THREE.MeshStandardMaterial(i === 2 ? { map: centreTex, roughness: 0.9 } : { color: 0x8fa896, roughness: 0.9 })));
  centre.position.y = TILE_H / 2;
  centre.receiveShadow = true;
  scene.add(centre);

  // Filz-Feld für die Würfel und weiche Schatten unter Logo und Kartenstapeln
  const feltCv = document.createElement('canvas'); feltCv.width = 512; feltCv.height = 256;
  { const c = feltCv.getContext('2d'); c.fillStyle = '#245c3c'; c.beginPath(); c.roundRect(6, 6, 500, 244, 44); c.fill(); c.strokeStyle = '#d8b25a'; c.lineWidth = 8; c.stroke();
    for (let i = 0; i < 2500; i++) { c.fillStyle = `rgba(255,255,255,${Math.random() * 0.05})`; c.fillRect(Math.random() * 512, Math.random() * 256, 2, 2); } }
  const felt = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 1.7), new THREE.MeshStandardMaterial({ map: tex(feltCv), roughness: 1, transparent: true }));
  felt.rotation.x = -Math.PI / 2; felt.position.set(0, TOP + 0.004, 1.6); felt.receiveShadow = true;
  scene.add(felt);
  [[0, 0, 7.2, 3.0], [-2.4, -2.4, 3.2, 2.4], [2.4, 2.4, 3.2, 2.4]].forEach(([x, z, w, d]) => {
    const sh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ map: shadowTex(), transparent: true, depthWrite: false, opacity: 0.55 }));
    sh.rotation.x = -Math.PI / 2; sh.position.set(x, TOP + 0.003, z + 0.12);
    scene.add(sh);
  });

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
    const band = new THREE.Mesh(new THREE.BoxGeometry(2.24, 0.05, 1.49), new THREE.MeshStandardMaterial({ color: 0xd8b25a, metalness: 0.6, roughness: 0.35 }));
    band.position.y = 0.03; deck.add(band);
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

function badgeTexture(color, emoji) {
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const c = cv.getContext('2d');
  c.fillStyle = '#fff'; c.beginPath(); c.arc(64, 64, 60, 0, Math.PI * 2); c.fill();
  c.strokeStyle = color; c.lineWidth = 16; c.stroke();
  c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = `66px ${FONT}`; c.fillText(emoji || '', 64, 70);
  return tex(cv);
}

function makeFrame(t, color, emoji, cssColor) {
  const g = new THREE.Group();
  // Das Feld selbst bleibt unverändert lesbar: Der Besitzer wird durch eine schmale, leuchtende
  // Leiste am äußeren Brettrand und einen kleinen Marker mit Emoji in der äußeren Ecke gezeigt.
  const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.7, roughness: 0.35 });
  const { w, d } = t.rect;
  const bc = t.side ? bandCentre(t) : { x: 0, z: 0, alongX: true };
  let strip, sx = 0, sz = 0;
  if (bc.alongX) { const sg = bc.z < 0 ? 1 : -1; strip = new THREE.BoxGeometry(w - 0.06, 0.09, 0.055); sz = sg * (d / 2 - 0.0275); }
  else { const sg = bc.x > 0 ? -1 : 1; strip = new THREE.BoxGeometry(0.055, 0.09, d - 0.06); sx = sg * (w / 2 - 0.0275); }
  const m = new THREE.Mesh(strip, mat);
  m.position.set(sx, TOP + 0.045, sz);
  m.castShadow = true;
  g.add(m);
  let bx, bz;
  if (bc.alongX) { bx = w / 2 - 0.24; bz = bc.z < 0 ? d / 2 - 0.27 : -(d / 2 - 0.27); }
  else { bz = d / 2 - 0.24; bx = bc.x > 0 ? -(w / 2 - 0.27) : w / 2 - 0.27; }
  const badge = new THREE.Mesh(new THREE.CircleGeometry(0.17, 28), new THREE.MeshBasicMaterial({ map: badgeTexture(cssColor || '#888', emoji), transparent: true }));
  badge.rotation.x = -Math.PI / 2; badge.position.set(bx, TOP + 0.03, bz);
  g.add(badge);
  g.userData.mat = mat;
  return g;
}

const houseMat = new THREE.MeshStandardMaterial({ color: 0x22b35e, roughness: 0.45 });
const roofMat = new THREE.MeshStandardMaterial({ color: 0x9c2f22, roughness: 0.55 });
const hotelMat = new THREE.MeshStandardMaterial({ color: 0xd63a2f, roughness: 0.45 });
const hotelRoof = new THREE.MeshStandardMaterial({ color: 0x5b1712, roughness: 0.6 });
const winMat = new THREE.MeshBasicMaterial({ color: 0xffe08a });
const doorMat = new THREE.MeshStandardMaterial({ color: 0x5a3b1f, roughness: 0.7 });
const houseGeo = new THREE.BoxGeometry(0.17, 0.11, 0.17);
const winGeo = new THREE.BoxGeometry(0.035, 0.04, 0.006);
const doorGeo = new THREE.BoxGeometry(0.04, 0.06, 0.006);
const hotelGeo = new THREE.BoxGeometry(0.62, 0.17, 0.24);
const hotelTopGeo = new THREE.BoxGeometry(0.4, 0.1, 0.2);
const hotelSlab = new THREE.BoxGeometry(0.66, 0.03, 0.28);
const roofPrism = (() => {
  const sh = new THREE.Shape(); sh.moveTo(-0.115, 0); sh.lineTo(0.115, 0); sh.lineTo(0, 0.1); sh.closePath();
  const g = new THREE.ExtrudeGeometry(sh, { depth: 0.2, bevelEnabled: false });
  g.translate(0, 0, -0.1);
  return g;
})();

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
  const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; g.add(m); return m; };
  if (hotel) {
    add(hotelGeo, hotelMat, 0, 0.085, 0);
    add(hotelTopGeo, hotelMat, 0, 0.22, 0);
    add(hotelSlab, hotelRoof, 0, 0.285, 0);
    for (let i = -2; i <= 2; i++) { add(winGeo, winMat, i * 0.11, 0.1, 0.123); add(winGeo, winMat, i * 0.11, 0.1, -0.123); }
    for (let i = -1; i <= 1; i++) { add(winGeo, winMat, i * 0.11, 0.225, 0.103); add(winGeo, winMat, i * 0.11, 0.225, -0.103); }
    add(doorGeo, doorMat, 0, 0.03, 0.123);
    g.scale.setScalar(1.28);
  } else {
    add(houseGeo, houseMat, 0, 0.055, 0);
    const r = add(roofPrism, roofMat, 0, 0.11, 0);
    r.scale.set(1.05, 1, 1);
    add(winGeo, winMat, -0.04, 0.07, 0.088); add(winGeo, winMat, 0.04, 0.07, 0.088);
    add(doorGeo, doorMat, 0, 0.03, -0.088);
    add(winGeo, winMat, 0.04, 0.07, -0.088);
    g.scale.setScalar(1.4);
  }
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
      const o = (i - 1.5) * 0.235;
      h.position.set(bc.x + (bc.alongX ? o : 0), TOP, bc.z + (bc.alongX ? 0 : o));
      t.group.add(h); t.houses.push(h);
      if (animate && i === n - 1) popIn(h);
    }
  }
}

function popIn(obj) {
  const base = obj.scale.x || 1;
  obj.scale.setScalar(0.01);
  tweens.push({ t: 0, dur: 0.9, fn: (k) => {
    const e = 1 + 2.2 * Math.pow(Math.min(1, k * 1.6) - 1, 3) + 1.2 * Math.pow(Math.min(1, k * 1.6) - 1, 2);
    obj.scale.setScalar(Math.max(0.01, e * base));
    obj.rotation.z = Math.sin(k * 22) * 0.14 * Math.pow(1 - k, 2);
  }, done: () => { obj.scale.setScalar(base); obj.rotation.z = 0; } });
}

function bump(t) {
  tweens.push({ t: 0, dur: 0.6, fn: (k) => { t.group.position.y = Math.sin(k * Math.PI) * 0.35 * (1 - k * 0.3); }, done: () => { t.group.position.y = 0; } });
}

// ---------------------------------------------------------------- Bahnhöfe & Werke (3D-Modelle)

function mk(geo, mat, x, y, z, parent) { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m; }

function buildLoco(color) {
  const g = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.4, metalness: 0.5 });
  const body = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.2 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xf1c14c, roughness: 0.3, metalness: 0.7 });
  const boiler = mk(new THREE.CylinderGeometry(0.09, 0.09, 0.36, 18), body, 0.06, 0.18, 0, g); boiler.rotation.z = Math.PI / 2;
  mk(new THREE.BoxGeometry(0.15, 0.2, 0.19), body, -0.19, 0.2, 0, g);
  mk(new THREE.BoxGeometry(0.17, 0.02, 0.21), dark, -0.19, 0.31, 0, g);
  mk(new THREE.CylinderGeometry(0.03, 0.045, 0.13, 12), dark, 0.16, 0.3, 0, g);
  mk(new THREE.SphereGeometry(0.05, 12, 8), gold, 0.02, 0.28, 0, g);
  mk(new THREE.BoxGeometry(0.5, 0.04, 0.16), dark, -0.02, 0.09, 0, g);
  [[-0.17, 0.075], [-0.03, 0.075], [0.11, 0.06]].forEach(([x, r]) => [-1, 1].forEach((sd) => { const w = mk(new THREE.CylinderGeometry(r, r, 0.03, 16), dark, x, r + 0.01, sd * 0.09, g); w.rotation.x = Math.PI / 2; }));
  const lamp = mk(new THREE.SphereGeometry(0.03, 8, 6), new THREE.MeshBasicMaterial({ color: 0xfff2a8 }), 0.26, 0.19, 0, g);
  lamp.castShadow = false;
  g.scale.setScalar(1.08);
  return g;
}

function buildPowerPlant() {
  const g = new THREE.Group();
  const wall = new THREE.MeshStandardMaterial({ color: 0xc9ccd2, roughness: 0.6 });
  const stripeR = new THREE.MeshStandardMaterial({ color: 0xd63a2f, roughness: 0.5 });
  mk(new THREE.BoxGeometry(0.38, 0.16, 0.24), wall, -0.04, 0.08, 0, g);
  mk(new THREE.BoxGeometry(0.4, 0.02, 0.26), new THREE.MeshStandardMaterial({ color: 0x555b66 }), -0.04, 0.17, 0, g);
  mk(new THREE.CylinderGeometry(0.045, 0.06, 0.4, 14), wall, 0.14, 0.3, 0, g);
  mk(new THREE.CylinderGeometry(0.047, 0.05, 0.05, 14), stripeR, 0.14, 0.44, 0, g);
  const bulb = mk(new THREE.SphereGeometry(0.06, 14, 10), new THREE.MeshBasicMaterial({ color: 0xffe066 }), -0.14, 0.27, 0, g); bulb.castShadow = false;
  mk(new THREE.CylinderGeometry(0.025, 0.03, 0.05, 8), new THREE.MeshStandardMaterial({ color: 0x666 }), -0.14, 0.2, 0, g);
  [-0.12, 0, 0.12].forEach((x) => mk(new THREE.BoxGeometry(0.05, 0.05, 0.005), winMat, x - 0.04, 0.09, 0.123, g));
  g.userData.bulb = bulb;
  return g;
}

function buildWaterTower() {
  const g = new THREE.Group();
  const leg = new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.5, metalness: 0.4 });
  [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([x, z]) => mk(new THREE.CylinderGeometry(0.014, 0.014, 0.26, 6), leg, x * 0.08, 0.13, z * 0.08, g));
  mk(new THREE.CylinderGeometry(0.13, 0.13, 0.17, 20), new THREE.MeshStandardMaterial({ color: 0x3c8fd9, roughness: 0.35, metalness: 0.2 }), 0, 0.34, 0, g);
  mk(new THREE.ConeGeometry(0.15, 0.09, 20), new THREE.MeshStandardMaterial({ color: 0x1f5f9e, roughness: 0.5 }), 0, 0.465, 0, g);
  mk(new THREE.TorusGeometry(0.132, 0.008, 6, 24), leg, 0, 0.3, 0, g).rotation.x = Math.PI / 2;
  return g;
}

function addModels() {
  const cols = [0xd63a2f, 0x2b6cd9, 0x22a559, 0x8a4fd6];
  let si = 0;
  tileMeshes.forEach((t) => {
    const sq = O.SQUARES[t.pos];
    let m = null;
    if (sq.type === 'station') m = buildLoco(cols[si++ % cols.length]);
    else if (sq.type === 'utility') m = t.pos === 12 ? buildPowerPlant() : buildWaterTower();
    if (!m) return;
    m.position.set(0, TOP, -t.rect.d / 2 + t.rect.d * 0.27);
    t.group.add(m);
    t.model = m;
  });
}

// ---------------------------------------------------------------- Figuren

function pawnGeo() {
  const pts = [[0.001, 0.05], [0.2, 0.05], [0.16, 0.13], [0.1, 0.2], [0.075, 0.38], [0.15, 0.4], [0.15, 0.45], [0.075, 0.5], [0.001, 0.52]].map(([x, y]) => new THREE.Vector2(x, y));
  return new THREE.LatheGeometry(pts, 28);
}
let PAWN = null;
let SHADOW_TEX = null;
function shadowTex() {
  if (SHADOW_TEX) return SHADOW_TEX;
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const c = cv.getContext('2d');
  const g = c.createRadialGradient(32, 32, 2, 32, 32, 32);
  g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = g; c.fillRect(0, 0, 64, 64);
  SHADOW_TEX = new THREE.CanvasTexture(cv);
  return SHADOW_TEX;
}

function emojiSprite(emoji, color) {
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const c = cv.getContext('2d');
  c.fillStyle = '#fff'; c.beginPath(); c.arc(64, 64, 58, 0, Math.PI * 2); c.fill();
  c.strokeStyle = color; c.lineWidth = 12; c.stroke();
  c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = `68px ${FONT}`; c.fillText(emoji, 64, 70);
  const m = new THREE.SpriteMaterial({ map: tex(cv), depthWrite: false });
  const s = new THREE.Sprite(m);
  s.scale.set(0.56, 0.56, 1);
  return s;
}

// Kleine Kopfbedeckung je Figur (Donald-Matrosenmütze, Dagobert-Zylinder, ...).
function accessory(emoji, color) {
  const g = new THREE.Group();
  const m = (c, r = 0.4, me = 0.1) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: me });
  const add = (geo, mat, x, y, z) => { const o = new THREE.Mesh(geo, mat); o.position.set(x, y, z); o.castShadow = true; g.add(o); return o; };
  if (emoji === '🦆') { add(new THREE.CylinderGeometry(0.15, 0.16, 0.09, 20), m(0x2452c8), 0, 0.03, 0); add(new THREE.CylinderGeometry(0.16, 0.16, 0.02, 20), m(0xffffff), 0, 0.08, 0); add(new THREE.SphereGeometry(0.03, 8, 6), m(0xd63a2f), 0, 0.11, 0); }
  else if (emoji === '🐧') { add(new THREE.CylinderGeometry(0.2, 0.2, 0.025, 24), m(0x15161a), 0, 0, 0); add(new THREE.CylinderGeometry(0.125, 0.135, 0.22, 24), m(0x15161a), 0, 0.12, 0); add(new THREE.CylinderGeometry(0.137, 0.137, 0.04, 24), m(0xd63a2f), 0, 0.06, 0); }
  else if (emoji === '🦢') { add(new THREE.CylinderGeometry(0.14, 0.16, 0.05, 5), m(0xf1c14c, 0.25, 0.8), 0, 0.02, 0); for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2; add(new THREE.ConeGeometry(0.03, 0.09, 6), m(0xf1c14c, 0.25, 0.8), Math.cos(a) * 0.125, 0.09, Math.sin(a) * 0.125); } add(new THREE.SphereGeometry(0.025, 8, 6), m(0xd63a2f), 0, 0.1, 0.13); }
  else if (emoji === '🦉') { add(new THREE.CylinderGeometry(0.11, 0.12, 0.06, 18), m(0x1a1a24), 0, 0.02, 0); add(new THREE.BoxGeometry(0.34, 0.025, 0.34), m(0x1a1a24), 0, 0.07, 0); add(new THREE.CylinderGeometry(0.008, 0.008, 0.12, 6), m(0xf1c14c), 0.15, 0.03, 0.15); add(new THREE.SphereGeometry(0.025, 8, 6), m(0xf1c14c), 0.15, -0.03, 0.15); }
  else if (emoji === '🦜') { add(new THREE.ConeGeometry(0.11, 0.26, 18), m(0xef5350), 0, 0.12, 0); add(new THREE.SphereGeometry(0.035, 8, 6), m(0xffd54f), 0, 0.26, 0); add(new THREE.TorusGeometry(0.075, 0.012, 6, 18), m(0xffd54f), 0, 0.06, 0).rotation.x = Math.PI / 2; }
  else { add(new THREE.SphereGeometry(0.06, 12, 8), m(0xf1c14c), 0, 0.05, 0); add(new THREE.ConeGeometry(0.05, 0.14, 8), m(0xf1c14c), 0, 0.14, 0); }
  return g;
}

function makeToken(p) {
  if (!PAWN) PAWN = pawnGeo();
  const group = new THREE.Group();
  const mat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(p.color), roughness: 0.28, metalness: 0.15, clearcoat: 0.85, clearcoatRoughness: 0.12 });
  const pawn = new THREE.Group();
  const body = new THREE.Mesh(PAWN, mat); body.castShadow = true; pawn.add(body);
  const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.235, 0.26, 0.055, 32), mat); foot.position.y = 0.0275; foot.castShadow = true; pawn.add(foot);
  const collar = new THREE.Mesh(new THREE.TorusGeometry(0.115, 0.03, 10, 28), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 }));
  collar.rotation.x = Math.PI / 2; collar.position.y = 0.4; pawn.add(collar);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.155, 24, 18), mat); head.position.y = 0.66; head.castShadow = true; pawn.add(head);
  const acc = accessory(p.emoji, p.color); acc.position.y = 0.66 + 0.13; pawn.add(acc);
  pawn.scale.setScalar(1.0);
  group.add(pawn);
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.95), new THREE.MeshBasicMaterial({ map: shadowTex(), transparent: true, depthWrite: false }));
  blob.rotation.x = -Math.PI / 2; blob.position.y = 0.004; group.add(blob);
  const sprite = emojiSprite(p.emoji, p.color);
  sprite.position.y = 1.38;
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
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.34, 4), new THREE.MeshStandardMaterial({ color: p.color, emissive: p.color, emissiveIntensity: 0.6, roughness: 0.35 }));
  arrow.rotation.x = Math.PI; arrow.visible = false; group.add(arrow);
  group.traverse((o) => { o.userData.tid = p.id; });
  return { id: p.id, group, pawn, sprite, ring, cage, arrow, mat, pos: null, target: null, from: new THREE.Vector3(), to: new THREE.Vector3(), tw: null, bob: Math.random() * 6, fxCage: false };
}

function slotFor(pos, idx, n, jailed) {
  const r = tileMeshes[pos].rect;
  let x = r.cx, z = r.cz;
  if (jailed) { x += r.w * 0.16; z -= r.d * 0.16; }
  else if (n > 1) {
    const corner = r.w > 1.2;
    if (corner) {
      const a = (idx / n) * Math.PI * 2 + 0.6;
      const rad = n === 2 ? 0.36 : 0.5;
      x += Math.cos(a) * rad; z += Math.sin(a) * rad;
    } else {
      const cols = n <= 2 ? n : 3;
      const row = Math.floor(idx / cols), col = idx % cols;
      const inRow = Math.min(cols, n - row * cols);
      x += (col - (inRow - 1) / 2) * 0.34;
      z += (row - (Math.ceil(n / cols) - 1) / 2) * 0.4;
    }
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
    if (!tk) { tk = tokens[p.id] = makeToken(p); tk.group.scale.setScalar(0.01); const g0 = tk.group, dl = Object.keys(tokens).length * 0.12; tweens.push({ t: -dl, dur: 0.6, fn: (k) => { const kk = Math.max(0, k); const e = 1 + 2.2 * Math.pow(kk - 1, 3) + 1.2 * Math.pow(kk - 1, 2); g0.scale.setScalar(Math.max(0.01, e)); }, done: () => g0.scale.setScalar(1) }); }
    tk.group.visible = !p.bankrupt;
    if (p.bankrupt) return;
    seen[p.pos] = (seen[p.pos] || 0) + 1;
    const jailed = p.inJail && p.pos === 10;
    const dest = slotFor(p.pos, seen[p.pos] - 1, counts[p.pos], jailed);
    tk.spriteDX = counts[p.pos] > 1 ? (seen[p.pos] - 1 - (counts[p.pos] - 1) / 2) * 0.16 : 0;
    tk.crowd = counts[p.pos] > 2 ? 0.82 : 1;
    if (jailed || !p.inJail) tk.fxCage = false;
    tk.cage.visible = jailed || tk.fxCage;
    if (jailed && tk.cage.position.y !== 0) tk.cage.position.y = 0;
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

export function setCameraMode(m) { camMode = m === 'fixed' || m === 'cinema' ? m : 'soft'; }

export function rollDice(a, b, ms) {
  diceUntil = performance.now() + ms + 900;
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

// ---------------------------------------------------------------- Effekte

const dustGeo = new THREE.CircleGeometry(0.13, 12);
function dust(tk) {
  if (dustCount > 40) return;
  dustCount++;
  const m = new THREE.Mesh(dustGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(tk.mat.color).lerp(new THREE.Color(0xffffff), 0.6), transparent: true, opacity: 0.55, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.position.set(tk.group.position.x, TOP + 0.03, tk.group.position.z);
  scene.add(m);
  tweens.push({ t: 0, dur: 0.6, fn: (k) => { const sc = 1 + k * 1.6; m.scale.set(sc, sc, sc); m.material.opacity = 0.55 * (1 - k); }, done: () => { scene.remove(m); m.material.dispose(); dustCount--; } });
}
let dustCount = 0;

function tokenPoint(id, y) {
  const tk = tokens[id];
  if (!tk) return new THREE.Vector3(0, y, 0);
  return new THREE.Vector3(tk.group.position.x, y, tk.group.position.z);
}

function floatText(pos, text, color) {
  const cv = document.createElement('canvas'); cv.width = 320; cv.height = 110;
  const c = cv.getContext('2d');
  c.font = `900 68px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.lineWidth = 12; c.strokeStyle = 'rgba(10,20,14,0.9)'; c.strokeText(text, 160, 56);
  c.fillStyle = color; c.fillText(text, 160, 56);
  const mat = new THREE.SpriteMaterial({ map: tex(cv), transparent: true, depthTest: false, depthWrite: false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(1.5, 0.52, 1); sp.renderOrder = 20;
  sp.position.copy(pos);
  scene.add(sp);
  tweens.push({ t: 0, dur: 1.7, fn: (k) => { sp.position.y = pos.y + k * 1.1; mat.opacity = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3; const sc = k < 0.15 ? 0.6 + k / 0.15 * 0.4 : 1; sp.scale.set(1.5 * sc, 0.52 * sc, 1); }, done: () => { scene.remove(sp); mat.map.dispose(); mat.dispose(); } });
}

function sparkle(pos, color) {
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.28, 32), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2; ring.position.set(pos.x, TOP + 0.03, pos.z);
  scene.add(ring);
  tweens.push({ t: 0, dur: 0.7, fn: (k) => { const s = 1 + k * 3.2; ring.scale.set(s, s, s); ring.material.opacity = 0.9 * (1 - k); }, done: () => { scene.remove(ring); ring.geometry.dispose(); ring.material.dispose(); } });
}

const coinGeo = new THREE.CylinderGeometry(0.11, 0.11, 0.035, 20);
const coinMat = new THREE.MeshStandardMaterial({ color: 0xf5c542, roughness: 0.25, metalness: 0.85, emissive: 0x6b4a00, emissiveIntensity: 0.35 });

// Münzen fliegen vom Zahler zum Empfänger (oder in die Bank/Tischmitte).
export function moneyFx({ from, to, amount }) {
  if (!renderer || !visible) return;
  const a = from ? tokenPoint(from, 0.9) : new THREE.Vector3(0, 1, 0);
  const b = to ? tokenPoint(to, 0.9) : new THREE.Vector3(0, 0.6, 0);
  const n = Math.max(3, Math.min(14, Math.ceil(amount / 45)));
  const dur = 0.85;
  if (from) floatText(a.clone().setY(1.5), `−${amount} ₮`, '#ff8a80');
  for (let i = 0; i < n; i++) {
    const coin = new THREE.Mesh(coinGeo, coinMat);
    coin.castShadow = true; coin.visible = false;
    scene.add(coin);
    const delay = i * 0.07;
    const spin = new THREE.Vector3(Math.random() * 9, Math.random() * 9, Math.random() * 9);
    const jit = new THREE.Vector3((Math.random() - 0.5) * 0.5, 0, (Math.random() - 0.5) * 0.5);
    const last = i === n - 1;
    tweens.push({
      t: -delay, dur,
      fn: (k) => {
        if (k <= 0) { coin.visible = false; return; }
        coin.visible = true;
        coin.position.lerpVectors(a, b, k).add(jit.clone().multiplyScalar(Math.sin(k * Math.PI)));
        coin.position.y += Math.sin(k * Math.PI) * 1.7;
        coin.rotation.set(spin.x * k, spin.y * k, spin.z * k);
      },
      done: () => {
        scene.remove(coin);
        if (last) {
          if (to) { floatText(b.clone().setY(1.5), `+${amount} ₮`, '#a5f3b5'); sparkle(b, 0xf5c542); const tk = tokens[to]; if (tk) bounce(tk); }
          else sparkle(b, 0xf5c542);
        }
      },
    });
  }
}

function bounce(tk) {
  tweens.push({ t: 0, dur: 0.5, fn: (k) => { tk.pawn.position.y = Math.abs(Math.sin(k * Math.PI * 2)) * 0.28 * (1 - k); }, done: () => { tk.pawn.position.y = 0; } });
}

const CONF = [0xef5350, 0xffd54f, 0x66bb6a, 0x42a5f5, 0xab47bc, 0xffffff].map((c) => new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide }));
const confGeo = new THREE.PlaneGeometry(0.11, 0.06);
function confettiBurst(origin, n, spread) {
  const ps = [];
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(confGeo, CONF[i % CONF.length]);
    m.position.copy(origin);
    scene.add(m);
    const ang = Math.random() * Math.PI * 2, sp = (0.4 + Math.random()) * spread;
    ps.push({ m, v: new THREE.Vector3(Math.cos(ang) * sp, 4 + Math.random() * 4, Math.sin(ang) * sp), r: new THREE.Vector3(Math.random() * 12, Math.random() * 12, Math.random() * 12) });
  }
  const dur = 2.8;
  tweens.push({
    t: 0, dur,
    fn: (k) => {
      const t = k * dur;
      ps.forEach((q) => {
        q.m.position.set(origin.x + q.v.x * t, Math.max(TOP + 0.02, origin.y + q.v.y * t - 4.5 * t * t), origin.z + q.v.z * t);
        q.m.rotation.set(q.r.x * t, q.r.y * t, q.r.z * t);
        const s = k > 0.8 ? (1 - k) / 0.2 : 1; q.m.scale.setScalar(Math.max(0.01, s));
      });
    },
    done: () => ps.forEach((q) => scene.remove(q.m)),
  });
}

export function confettiAt(pos, big) {
  if (!renderer || !visible) return;
  const r = tileMeshes[pos] ? tileMeshes[pos].rect : { cx: 0, cz: 0 };
  confettiBurst(new THREE.Vector3(r.cx, TOP + 0.4, r.cz), big ? 160 : 70, big ? 3.2 : 1.8);
}

// Streifenwagen + fallendes Gitter über der Figur.
let policeCar = null;
function buildPoliceCar() {
  const g = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: 0xf2f4f7, roughness: 0.35, metalness: 0.2 });
  const black = new THREE.MeshStandardMaterial({ color: 0x1b1e24, roughness: 0.4 });
  mk(new THREE.BoxGeometry(0.9, 0.2, 0.42), black, 0, 0.17, 0, g);
  mk(new THREE.BoxGeometry(0.9, 0.09, 0.42), white, 0, 0.11, 0, g);
  mk(new THREE.BoxGeometry(0.46, 0.17, 0.38), white, -0.04, 0.33, 0, g);
  mk(new THREE.BoxGeometry(0.4, 0.1, 0.395), new THREE.MeshStandardMaterial({ color: 0x9fd0ff, roughness: 0.1, metalness: 0.4 }), -0.04, 0.34, 0, g);
  [[-0.28, 0.2], [0.28, 0.2]].forEach(([x, z]) => [-1, 1].forEach((sd) => { const w = mk(new THREE.CylinderGeometry(0.09, 0.09, 0.07, 14), black, x, 0.09, sd * z, g); w.rotation.x = Math.PI / 2; }));
  const red = mk(new THREE.BoxGeometry(0.07, 0.05, 0.15), new THREE.MeshBasicMaterial({ color: 0xff2a2a }), -0.04, 0.45, -0.1, g);
  const blue = mk(new THREE.BoxGeometry(0.07, 0.05, 0.15), new THREE.MeshBasicMaterial({ color: 0x2a6bff }), -0.04, 0.45, 0.1, g);
  g.userData.red = red; g.userData.blue = blue;
  g.scale.setScalar(1.2);
  return g;
}

export function jailFx(id) {
  const tk = tokens[id];
  if (!renderer || !visible || !tk) return;
  tk.fxCage = true;
  tk.cage.visible = true;
  tk.cage.position.y = 5;
  tweens.push({ t: -0.9, dur: 0.75, fn: (k) => { if (k < 0) { tk.cage.position.y = 5; return; } const e = k < 0.7 ? 5 * (1 - Math.pow(k / 0.7, 2)) : Math.sin((k - 0.7) / 0.3 * Math.PI) * 0.25 * (1 - (k - 0.7) / 0.3); tk.cage.position.y = Math.max(0, e); }, done: () => { tk.cage.position.y = 0; } });
  if (!policeCar) { policeCar = buildPoliceCar(); scene.add(policeCar); }
  const car = policeCar;
  const p = tk.group.position;
  const start = new THREE.Vector3(p.x - 7, TOP, p.z + 1.1), stop = new THREE.Vector3(p.x - 1.5, TOP, p.z + 1.1);
  car.visible = true;
  tweens.push({ t: 0, dur: 2.3, fn: (k) => {
    const drive = k < 0.3 ? k / 0.3 : k > 0.75 ? 1 + (k - 0.75) / 0.25 * 5 : 1;
    car.position.lerpVectors(start, stop, Math.min(1, drive)); if (drive > 1) car.position.x = stop.x + (drive - 1) * 1.3;
    const flash = Math.floor(k * 22) % 2 === 0;
    car.userData.red.material.color.setHex(flash ? 0xff2a2a : 0x330808); car.userData.blue.material.color.setHex(flash ? 0x0a1a44 : 0x2a6bff);
  }, done: () => { car.visible = false; } });
}

// Ereigniskarte steigt vom Stapel auf, dreht sich und zeigt sich groß.
function cardFace(c) {
  const cv = document.createElement('canvas'); cv.width = 840; cv.height = 540;
  const k = cv.getContext('2d');
  k.fillStyle = c.deck === 'chance' ? '#ffd9b0' : '#cdeeff'; k.fillRect(0, 0, 840, 540);
  k.strokeStyle = '#14261b'; k.lineWidth = 14; k.strokeRect(10, 10, 820, 520);
  k.textAlign = 'center'; k.textBaseline = 'middle'; k.fillStyle = '#14261b';
  k.font = `900 58px ${FONT}`; k.fillText(c.label, 420, 82);
  k.font = `700 44px ${FONT}`;
  const lines = wrap(k, c.text, 720);
  const lh = 56, y0 = 290 - ((lines.length - 1) * lh) / 2;
  lines.forEach((l, i) => k.fillText(l, 420, y0 + i * lh));
  k.font = `600 30px ${FONT}`; k.fillStyle = '#3c5546'; k.fillText(c.who || '', 420, 490);
  return tex(cv);
}
function cardBack(c) {
  const cv = document.createElement('canvas'); cv.width = 840; cv.height = 540;
  const k = cv.getContext('2d');
  k.fillStyle = c.deck === 'chance' ? '#f5a45a' : '#8fd3f4'; k.fillRect(0, 0, 840, 540);
  k.strokeStyle = '#14261b'; k.lineWidth = 14; k.setLineDash([40, 22]); k.strokeRect(24, 24, 792, 492);
  k.setLineDash([]); k.font = '240px sans-serif'; k.textAlign = 'center'; k.textBaseline = 'middle'; k.fillText(c.deck === 'chance' ? '🔮' : '🐤', 420, 270);
  return tex(cv);
}

export function dismissCard() {
  if (!cardObj || cardObj.leaving) return;
  cardObj.leaving = true;
  const co = cardObj;
  const from = co.mesh.position.clone(), sc = co.mesh.scale.x;
  tweens.push({ t: 0, dur: 0.35, fn: (k) => { co.mesh.position.y = from.y + k * 0.5; co.mesh.scale.setScalar(Math.max(0.01, sc * (1 - k))); }, done: () => { scene.remove(co.mesh); co.mesh.geometry.dispose(); if (cardObj === co) cardObj = null; } });
}

function updateDeckHeights() {
  ['community', 'chance'].forEach((k, i) => {
    const d = decks[i]; if (!d) return;
    const sy = 0.5 + 0.5 * (1 - (drawn[k] % 16) / 16);
    d.scale.y = sy;
    d.userData.base = TOP + 0.13 * sy;
  });
}

export function showCard(c) {
  if (!renderer || !visible) return false;
  drawn[c.deck === 'chance' ? 'chance' : 'community']++;
  updateDeckHeights();
  if (cardObj) { scene.remove(cardObj.mesh); cardObj = null; }
  const front = new THREE.MeshBasicMaterial({ map: cardFace(c), toneMapped: false, transparent: true });
  const back = new THREE.MeshBasicMaterial({ map: cardBack(c), toneMapped: false, transparent: true });
  const edge = new THREE.MeshStandardMaterial({ color: 0xf4f4ea });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(4.4, 2.83, 0.05), [edge, edge, edge, edge, front, back]);
  const deck = decks[c.deck === 'chance' ? 1 : 0];
  const from = deck ? deck.position.clone() : new THREE.Vector3(0, 0.4, 0);
  const fromQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, deck ? deck.rotation.y : 0, 0, 'YXZ'));
  mesh.position.copy(from); mesh.quaternion.copy(fromQ); mesh.scale.setScalar(0.4);
  scene.add(mesh);
  const co = { mesh, leaving: false, hover: false };
  cardObj = co;
  const hoverPt = () => controls.target.clone().add(new THREE.Vector3(0, 3.1, 2.6));
  tweens.push({ t: 0, dur: 1.15, fn: (k) => {
    const e = 1 - Math.pow(1 - k, 3);
    const to = hoverPt();
    mesh.position.lerpVectors(from, to, e); mesh.position.y += Math.sin(k * Math.PI) * 1.2;
    mesh.quaternion.slerpQuaternions(fromQ, camera.quaternion, Math.min(1, Math.max(0, (k - 0.15) / 0.8)));
    mesh.scale.setScalar(0.35 + 0.45 * e);
  }, done: () => { co.hover = true; } });
  setTimeout(() => { if (cardObj === co) dismissCard(); }, 6500);
  return true;
}

// ---------------------------------------------------------------- Licht (Tag / Abend)

const LIGHTS = {
  day: { hemiC: 0xfff4e0, hemiG: 0x7a5a3a, hemiI: 0.55, sunC: 0xffe0b4, sunI: 2.5, sunP: [-7, 14, 9], fillC: 0x9db8ff, fillI: 0.5, lampI: 0, env: 0.32, exp: 1.0 },
  evening: { hemiC: 0xffc890, hemiG: 0x3a2a4a, hemiI: 0.4, sunC: 0xff9a55, sunI: 1.7, sunP: [-12, 6.5, 9], fillC: 0x6e86ff, fillI: 0.75, lampI: 26, env: 0.2, exp: 0.95 },
};
function applyLight(mode, instant) {
  lightMode = mode === 'evening' ? 'evening' : 'day';
  if (!lights) return;
  const to = LIGHTS[lightMode];
  const from = lights.cur || to;
  const col = (c) => new THREE.Color(c);
  const set = (k) => {
    lights.hemi.color.copy(col(from.hemiC).lerp(col(to.hemiC), k)); lights.hemi.groundColor.copy(col(from.hemiG).lerp(col(to.hemiG), k)); lights.hemi.intensity = from.hemiI + (to.hemiI - from.hemiI) * k;
    lights.sun.color.copy(col(from.sunC).lerp(col(to.sunC), k)); lights.sun.intensity = from.sunI + (to.sunI - from.sunI) * k;
    lights.sun.position.set(...from.sunP.map((v, i) => v + (to.sunP[i] - v) * k));
    lights.fill.color.copy(col(from.fillC).lerp(col(to.fillC), k)); lights.fill.intensity = from.fillI + (to.fillI - from.fillI) * k;
    lights.lamp.intensity = from.lampI + (to.lampI - from.lampI) * k;
    if (scene) scene.environmentIntensity = from.env + (to.env - from.env) * k;
    if (renderer) renderer.toneMappingExposure = from.exp + (to.exp - from.exp) * k;
  };
  lights.cur = to;
  if (instant) { set(1); return; }
  tweens.push({ t: 0, dur: 0.9, fn: set, done: () => set(1) });
}
export function setLightMode(m) { applyLight(m, false); }

// ---------------------------------------------------------------- Kamera & Schleife

function fitDistance() {
  const w = container.clientWidth || 800, h = container.clientHeight || 600;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  const el = (elevDeg * Math.PI) / 180;
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

export function rotateView(dir) {
  if (!camera || !controls) return;
  const off0 = camera.position.clone().sub(controls.target);
  const r = Math.hypot(off0.x, off0.z), y = off0.y;
  const az0 = Math.atan2(off0.x, off0.z), az1 = az0 + (dir > 0 ? 1 : -1) * Math.PI / 2;
  viewTweenUntil = performance.now() + 900;
  tweens.push({ t: 0, dur: 0.7, fn: (k) => {
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    const az = az0 + (az1 - az0) * e;
    camera.position.set(controls.target.x + Math.sin(az) * r, controls.target.y + y, controls.target.z + Math.cos(az) * r);
  }, done: () => { viewTweenUntil = 0; } });
}

let viewTweenUntil = 0;
export function isTopDown() { return elevDeg > 75; }
export function setTopDown(on) {
  elevDeg = on ? 84 : 65;
  if (!camera || !controls) return;
  const off0 = camera.position.clone().sub(controls.target);
  const d0 = off0.length() || 20;
  const az = Math.atan2(off0.x, off0.z);
  const el0 = Math.asin(Math.max(-1, Math.min(1, off0.y / d0)));
  const { dist } = fitDistance();
  controls.minDistance = dist * 0.45; controls.maxDistance = dist * 1.25;
  const el1 = (elevDeg * Math.PI) / 180;
  viewTweenUntil = performance.now() + 900;
  tweens.push({ t: 0, dur: 0.7, fn: (k) => {
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    const el = el0 + (el1 - el0) * e, d = d0 + (dist - d0) * e;
    camera.position.set(controls.target.x + Math.sin(az) * Math.cos(el) * d, controls.target.y + Math.sin(el) * d, controls.target.z + Math.cos(az) * Math.cos(el) * d);
  }, done: () => { viewTweenUntil = 0; } });
}

export function resetView() {
  camF = { x: 0, z: 0, zoom: 1 }; camHold = null;
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
      tk.pawn.scale.set(0.95 * (tk.crowd || 1), 0.95 * (tk.crowd || 1) * (k > 0.9 ? 0.86 + (1 - k) * 1.4 : 1), 0.95 * (tk.crowd || 1));
      if (k >= 1) { tk.group.position.copy(tk.tw.to); tk.tw = null; tk.pawn.scale.setScalar(0.95 * (tk.crowd || 1)); }
    } else {
      tk.pawn.scale.setScalar(0.95 * (tk.crowd || 1));
    }
    const active = tk.id === activeId;
    tk.ring.visible = active;
    tk.arrow.visible = active && !tk.tw;
    if (active) { tk.arrow.position.y = 1.85 + Math.sin(pulse * 3.2) * 0.1; tk.arrow.rotation.y += dt * 2.2; }
    // Staubwölkchen beim Laufen
    if (tk.tw) { tk.puff = (tk.puff || 0) + dt; if (tk.puff > 0.07) { tk.puff = 0; dust(tk); } }
    if (active) { tk.ring.material.opacity = 0.55 + Math.sin(pulse * 5) * 0.35; const s = 1 + Math.sin(pulse * 5) * 0.08; tk.ring.scale.set(s, s, s); if (!tk.tw) tk.pawn.position.y = Math.abs(Math.sin(pulse * 3)) * 0.06; }
    else tk.pawn.position.y = 0;
    tk.sprite.position.x += ((tk.spriteDX || 0) - tk.sprite.position.x) * 0.15;
    tk.sprite.position.y = 1.32 + (active ? Math.sin(pulse * 3 + tk.bob) * 0.06 : 0);
  });
  decks.forEach((d) => { d.position.y = d.userData.base + Math.sin(pulse * 1.4 + d.userData.phase) * 0.05; });

  if (cardObj && cardObj.hover && !cardObj.leaving) {
    const m = cardObj.mesh;
    m.position.copy(controls.target).add(new THREE.Vector3(0, 3.1 + Math.sin(pulse * 2) * 0.05, 2.6));
    cardObj.age = (cardObj.age || 0) + dt;
    const fade = cardObj.age > 2.5 ? 0.62 : 1;
    m.material.forEach((mm, i) => { if (i >= 4) { mm.transparent = true; mm.opacity += (fade - mm.opacity) * 0.08; } });
    m.quaternion.slerp(camera.quaternion, 0.25);
  }

  // Kamera: 'soft' schwenkt sanft zur Figur am Zug (ohne zu drehen), 'cinema' zoomt zusätzlich
  // auf Aktionen, 'fixed' bleibt stehen. Alle Bewegungen laufen über eine Glättung mit Haltezeit,
  // damit die Kamera bei Sprüngen der Figuren nicht wackelt oder zwischen Zielen pendelt.
  if (camMode !== 'fixed' && performance.now() > interactUntil && !viewTweenUntil) {
    const cin = camMode === 'cinema';
    const now = performance.now();
    const moving = Object.values(tokens).find((t) => t.tw && t.group.visible);
    const activeTk = tokens[activeId];
    let want = null;
    if (moving) { want = { x: moving.tw.to.x * (cin ? 0.42 : 0.22), z: moving.tw.to.z * (cin ? 0.42 : 0.22), zoom: cin ? 0.8 : 1 }; camHold = { until: now + 1100, want }; }
    else if (camHold && now < camHold.until) want = camHold.want;
    else if (now < diceUntil) want = { x: 0, z: 0.6, zoom: cin ? 0.8 : 1 };
    else if (cardObj && !cardObj.leaving) want = { x: 0, z: 0, zoom: cin ? 0.9 : 1 };
    else if (activeTk) want = { x: activeTk.group.position.x * 0.2, z: activeTk.group.position.z * 0.2, zoom: 1 };
    else want = { x: 0, z: 0, zoom: 1 };
    const a = 1 - Math.exp(-dt * 1.8);
    camF.x += (want.x - camF.x) * a; camF.z += (want.z - camF.z) * a; camF.zoom += (want.zoom - camF.zoom) * a;
    const d = new THREE.Vector3(camF.x, 0, camF.z).sub(controls.target);
    controls.target.add(d); camera.position.add(d);
    if (cin) {
      const off = camera.position.clone().sub(controls.target);
      off.setLength(fitDist * camF.zoom);
      camera.position.copy(controls.target).add(off);
    }
  } else if (camMode !== 'fixed') {
    // Während man selbst dreht/zoomt (oder die Ansicht wechselt): Glättung an die echte Kamera angleichen
    camF.x = controls.target.x; camF.z = controls.target.z;
    camF.zoom = camera.position.distanceTo(controls.target) / (fitDist || 20);
  }
  controls.update();
  // Verschieben (Rechtsklick / zwei Finger) nur innerhalb des Bretts
  { const lim = S / 2 + 1, t = controls.target; const cx = Math.max(-lim, Math.min(lim, t.x)), cz = Math.max(-lim, Math.min(lim, t.z));
    if (cx !== t.x || cz !== t.z || t.y !== 0) { const dx = cx - t.x, dz = cz - t.z; t.x = cx; t.z = cz; camera.position.x += dx; camera.position.z += dz; if (t.y !== 0) { camera.position.y -= t.y; t.y = 0; } } }
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
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  scene = new THREE.Scene();
  try {
    const pm = new THREE.PMREMGenerator(renderer);
    scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.32;
    pm.dispose();
  } catch (e) { /* ohne Umgebungslicht weiter */ }
  camera = new THREE.PerspectiveCamera(38, 1, 0.5, 200);
  const hemi = new THREE.HemisphereLight(0xfff4e0, 0x7a5a3a, 0.55);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffe0b4, 2.5);
  sun.position.set(-7, 14, 9);
  sun.castShadow = true;
  const small = Math.min(window.innerWidth, window.innerHeight) < 700;
  sun.shadow.mapSize.set(small ? 1024 : 2048, small ? 1024 : 2048);
  const sc = sun.shadow.camera; sc.left = -11; sc.right = 11; sc.top = 11; sc.bottom = -11; sc.near = 1; sc.far = 40;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02; sun.shadow.radius = 3;
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x9db8ff, 0.5);
  fill.position.set(9, 7, -8);
  scene.add(fill);
  const lamp = new THREE.PointLight(0xffc27a, 0, 30, 1.6); lamp.position.set(0, 5, 0); scene.add(lamp);
  lights = { hemi, sun, fill, lamp, cur: null };
  applyLight(lightMode, true);
  const table = new THREE.Mesh(new THREE.PlaneGeometry(90, 90), new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.75, metalness: 0 }));
  table.rotation.x = -Math.PI / 2; table.position.y = -0.361; table.receiveShadow = true;
  scene.add(table);

  buildBoard();
  addModels();
  buildDice();

  controls = new OrbitControls(camera, canvas);
  controls.enablePan = true; controls.screenSpacePanning = false; controls.panSpeed = 0.9;
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.minPolarAngle = 0.04; controls.maxPolarAngle = 1.3;
  controls.rotateSpeed = 0.7;
  controls.addEventListener('start', () => { interactUntil = performance.now() + 6000; });
  controls.addEventListener('change', () => { if (performance.now() < interactUntil + 1) interactUntil = performance.now() + 6000; });

  // Klicks: Feld oder Figur
  let down = null;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; controls.rotateSpeed = e.pointerType === 'touch' ? 1.25 : 0.7; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved > 6) return;
    const hit = pick(e);
    if (!hit) return;
    if (hit.card) { dismissCard(); return; }
    if (hit.token) O.onToken && O.onToken(hit.token); else if (hit.pos !== undefined) O.onTile && O.onTile(hit.pos);
  });
  canvas.addEventListener('pointerleave', () => { if (hoverPos !== null) { tileMeshes[hoverPos].topMat.emissive.setHex(0x000000); hoverPos = null; } O.onHover && O.onHover(null); });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    const hit = pick(e);
    const p = hit && hit.pos !== undefined ? hit.pos : null;
    O.onHover && O.onHover(p, e.clientX, e.clientY);
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
  if (cardObj && cardObj.mesh.visible) {
    const ch = raycaster.intersectObject(cardObj.mesh, false)[0];
    if (ch) return { card: true };
  }
  const pawns = Object.values(tokens).filter((t) => t.group.visible).flatMap((t) => [t.pawn, t.sprite]);
  const ph = raycaster.intersectObjects(pawns, true)[0];
  if (ph && ph.object.userData.tid) return { token: ph.object.userData.tid };
  const th = raycaster.intersectObjects(tileMeshes.map((t) => t.top), false)[0];
  if (th) return { pos: th.object.userData.pos };
  return null;
}

export function setVisible(v) {
  const was = visible;
  visible = v;
  if (!canvas) return;
  if (v && (!was || !canvas.style.display)) {
    canvas.style.display = 'block'; canvas.style.opacity = '0';
    requestAnimationFrame(() => requestAnimationFrame(() => { canvas.style.opacity = '1'; }));
    clock.getDelta(); resize();
  } else if (!v && (was || !canvas.style.display)) {
    canvas.style.opacity = '0';
    setTimeout(() => { if (!visible) canvas.style.display = 'none'; }, 350);
  }
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
    if (owner !== t.owner || (owner && t.ownerEmoji !== p.ownerEmoji)) {
      if (t.frame) { t.group.remove(t.frame); t.frame = null; }
      if (owner) { t.frame = makeFrame(t, new THREE.Color(p.ownerColor), p.ownerEmoji, p.ownerColor); t.group.add(t.frame); if (!firstUpdate) bump(t); }
      t.owner = owner; t.ownerEmoji = p ? p.ownerEmoji : null;
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
  updateJackpot(view);
  layoutTokens(view, !firstUpdate);
  firstUpdate = false;
}

function updateJackpot(view) {
  if (!potTile) return;
  const n = view.freeParking ? Math.min(45, Math.ceil((view.pot || 0) / 30)) : 0;
  if (n === potCount) return;
  const grew = n > potCount && potCount >= 0;
  potCount = n;
  if (potGroup) { potTile.group.remove(potGroup); potGroup = null; }
  if (!n) return;
  potGroup = new THREE.Group();
  const spots = [[-0.44, -0.36], [0.44, -0.36], [-0.28, 0.02], [0.28, 0.02], [0, -0.26]];
  for (let i = 0; i < n; i++) {
    const sp = spots[i % spots.length], layer = Math.floor(i / spots.length);
    const coin = new THREE.Mesh(coinGeo, coinMat);
    coin.scale.setScalar(0.85);
    coin.position.set(sp[0] + ((i * 7) % 5 - 2) * 0.006, TOP + 0.02 + layer * 0.03, sp[1] + ((i * 3) % 5 - 2) * 0.006);
    coin.rotation.y = (i * 1.3) % 6;
    coin.castShadow = true;
    potGroup.add(coin);
  }
  potTile.group.add(potGroup);
  if (grew) popIn(potGroup);
}

export function dispose() {
  if (!renderer) return;
  renderer.setAnimationLoop(null);
  ro && ro.disconnect();
  renderer.dispose();
  canvas.remove();
  renderer = null;
}
