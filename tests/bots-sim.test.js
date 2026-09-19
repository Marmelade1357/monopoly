// Simuliert komplette Partien nur mit Bots direkt gegen die Engine (ohne Server)
// und prüft dabei laufend Invarianten (kein negatives Geld, Gebäude-Bilanz,
// gültige Besitzer, keine Endlosschleifen).

const E = require('../src/engine.js');
const { botAct } = require('../src/bots.js');
const { SQUARES } = require('../public/board-data.js');
const { assert } = require('./helpers.js');

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRoom(n, seed, startMoney) {
  const players = [];
  for (let i = 0; i < n; i++) players.push({ id: 'p' + i, name: 'Bot' + i, isBot: true, connected: true });
  return { players, settings: { startMoney: startMoney || 1500 }, logs: [], rng: mulberry32(seed), phase: 'playing' };
}

function checkInvariants(room) {
  const g = room.g;
  let houses = 0;
  let hotels = 0;
  Object.keys(g.props).forEach((pos) => {
    const p = g.props[pos];
    assert(g.order.includes(p.owner), `Besitzer ${p.owner} ungültig`);
    assert(!g.bankrupt[p.owner], `Pleite-Person besitzt noch ${pos}`);
    assert(p.houses >= 0 && p.houses <= 5, 'Häuserzahl ungültig');
    if (p.houses) assert(SQUARES[pos].type === 'property', 'Gebäude auf Nicht-Straße');
    if (p.houses === 5) hotels++; else houses += p.houses;
  });
  assert(houses + g.housesLeft === E.HOUSES, `Haus-Bilanz stimmt nicht (${houses}+${g.housesLeft})`);
  assert(hotels + g.hotelsLeft === E.HOTELS, `Hotel-Bilanz stimmt nicht (${hotels}+${g.hotelsLeft})`);
  g.order.forEach((id) => {
    assert(g.money[id] >= 0, `${id} hat negatives Geld: ${g.money[id]}`);
    assert(g.pos[id] >= 0 && g.pos[id] < 40, 'Position ungültig');
    if (g.bankrupt[id]) assert(g.money[id] === 0, 'Pleite-Person hat Geld');
  });
}

function playGame(n, seed, startMoney, maxSteps) {
  const room = makeRoom(n, seed, startMoney);
  E.initGame(room);
  let steps = 0;
  while (room.g.phase !== 'over' && steps < maxSteps) {
    const actors = E.pendingActors(room);
    assert(actors.length > 0, `Kein Akteur in Phase ${room.g.phase}`);
    let acted = false;
    for (const actor of actors) {
      if (botAct(room, actor)) { acted = true; break; }
    }
    assert(acted, `Keine Aktion möglich in Phase ${room.g.phase}`);
    checkInvariants(room);
    steps++;
  }
  return { room, steps };
}

let finished = 0;
let totalSteps = 0;
const GAMES = 40;
for (let seed = 1; seed <= GAMES; seed++) {
  const n = 2 + (seed % 5); // 2..6 Spieler
  const { room, steps } = playGame(n, seed, seed % 3 === 0 ? 800 : 1500, 60000);
  totalSteps += steps;
  if (room.g.phase === 'over') {
    finished++;
    assert(room.g.winner, 'Spiel ohne Gewinner beendet');
    assert(E.alive(room).length === 1, 'Am Ende muss genau eine Person übrig sein');
  }
}
console.log(`${finished}/${GAMES} Bot-Partien bis zum Ende gespielt (Ø ${Math.round(totalSteps / GAMES)} Aktionen).`);
assert(finished >= GAMES * 0.6, 'Zu wenige Partien wurden beendet (Endlosspiele?)');
console.log('OK: Bot-Simulation ohne Regelverletzung.');
