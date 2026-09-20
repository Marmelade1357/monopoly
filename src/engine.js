// Monopoly-Regelwerk (deutsche Hasbro-Edition 2017) als reine Spiellogik.
//
// Der Server (server.js) hält pro Raum ein `room`-Objekt und ruft hier
// `initGame(room)` sowie `act(room, playerId, action)` auf. Die gesamte
// Spielsituation liegt in `room.g` und ist per `snapshot(room)` für alle
// Clients einsehbar (bei Monopoly gibt es keine geheimen Informationen).
//
// Ablauf pro Zug (g.phase):
//   roll     -> Person am Zug darf würfeln (im Knast: zahlen / Karte / würfeln)
//   buy      -> Unbesetztes Grundstück: kaufen oder versteigern
//   auction  -> Auktion läuft (reihum bieten oder passen)
//   debt     -> Jemand muss zahlen, hat aber zu wenig Geld (Geld beschaffen / aufgeben)
//   end      -> Zug ist gespielt, Person darf noch verwalten und beendet den Zug
//   over     -> Spiel beendet

const BOARD = require('../public/board-data.js');
const CARDS = require('./cards.js');

const { SQUARES, GROUPS, GROUP_POSITIONS } = BOARD;

const GO_SALARY = 200;

// Optionale Hausregeln (in der Lobby wählbar). Fehlende Werte = Standardregeln.
const RULE_DEFAULTS = { freeParking: false, doubleGo: false, auction: true, jailRent: true, evenBuild: true };
function rule(room, key) {
  const r = room.settings && room.settings.rules;
  return r && typeof r[key] === 'boolean' ? r[key] : RULE_DEFAULTS[key];
}
const JAIL_FEE = 50;
const JAIL_POS = 10;
const MAX_JAIL_TURNS = 3;
const HOUSES = 32;
const HOTELS = 12;
const MIN_BID = 10;

const ok = () => ({ ok: true });
const fail = (error) => ({ ok: false, error });

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

function shuffle(arr, rng) {
  const a = arr.slice();
  const r = rng || Math.random;
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function fmt(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ' Taler';
}

function nameOf(room, id) {
  const p = room.players.find((x) => x.id === id);
  return p ? p.name : '?';
}

function log(room, text) {
  room.logs.push({ text, at: Date.now() });
  if (room.logs.length > 300) room.logs.shift();
}

function rollDie(room) {
  const g = room.g;
  if (g.forcedDice && g.forcedDice.length) return g.forcedDice.shift();
  return Math.floor((room.rng || Math.random)() * 6) + 1;
}

function curId(room) { return room.g.order[room.g.turnIdx]; }
function alive(room) { return room.g.order.filter((id) => !room.g.bankrupt[id]); }
function isCurrent(room, id) { return curId(room) === id; }

function ownedBy(g, id) {
  return Object.keys(g.props).map(Number).filter((pos) => g.props[pos].owner === id).sort((a, b) => a - b);
}

function ownsAllInGroup(g, id, group) {
  return GROUP_POSITIONS[group].every((pos) => g.props[pos] && g.props[pos].owner === id);
}

function countOwned(g, id, group) {
  return GROUP_POSITIONS[group].filter((pos) => g.props[pos] && g.props[pos].owner === id).length;
}

function mortgageValue(sq) { return sq.price / 2; }
function unmortgageCost(sq) { return sq.price / 2 + Math.ceil(sq.price / 20); }
function interestOnTransfer(sq) { return Math.ceil(sq.price / 20); }

function buildingsOf(g, id) {
  let houses = 0;
  let hotels = 0;
  ownedBy(g, id).forEach((pos) => {
    const h = g.props[pos].houses;
    if (h === 5) hotels++; else houses += h;
  });
  return { houses, hotels };
}

function netWorth(room, id) {
  const g = room.g;
  let sum = g.money[id] || 0;
  ownedBy(g, id).forEach((pos) => {
    const sq = SQUARES[pos];
    const p = g.props[pos];
    sum += p.mortgaged ? mortgageValue(sq) : sq.price;
    if (p.houses) sum += p.houses * (GROUPS[sq.group].houseCost);
  });
  return sum;
}

// ---------------------------------------------------------------------------
// Spielstart
// ---------------------------------------------------------------------------

function initGame(room) {
  const rng = room.rng || Math.random;
  const ids = room.players.map((p) => p.id);
  const order = shuffle(ids, rng);
  const start = room.settings.startMoney;
  const g = {
    order,
    turnIdx: 0,
    phase: 'roll',
    next: 'roll',
    doubles: 0,
    dice: [0, 0],
    rollSeq: 0,
    money: {},
    pos: {},
    inJail: {},
    jailTurns: {},
    jailCards: {},
    bankrupt: {},
    props: {},
    housesLeft: HOUSES,
    hotelsLeft: HOTELS,
    buy: null,
    auction: null,
    auctionQueue: [],
    pot: 0,
    debts: [],
    trade: null,
    tradeSeq: 0,
    pendingMove: null,
    decks: {
      chance: { draw: shuffle(CARDS.chance.map((_, i) => i), rng), discard: [] },
      community: { draw: shuffle(CARDS.community.map((_, i) => i), rng), discard: [] },
    },
    lastCard: null,
    cardSeq: 0,
    lastMove: null,
    moves: [],
    moveSeq: 0,
    winner: null,
    placements: [],
    turnCount: 0,
    round: 1,
    startedAt: Date.now(),
    stats: {},
    events: [],
    eventSeq: 0,
    hl: { bigRent: null, monopolies: [], busts: [] },
    groupOwner: {},
    shortWarn: false, shortZero: false,
    tradeReply: null, tradeReplySeq: 0,
    lastAuction: null,
    limitReached: false,
    forcedDice: null,
  };
  ids.forEach((id) => {
    g.money[id] = start;
    g.pos[id] = 0;
    g.inJail[id] = false;
    g.jailTurns[id] = 0;
    g.jailCards[id] = [];
    g.bankrupt[id] = false;
    g.stats[id] = { rentIn: 0, rentOut: 0, taxes: 0, bought: 0, built: 0 };
  });
  room.g = g;
  log(room, `Das Spiel beginnt – jede Person startet mit ${fmt(start)}.`);
  beginTurn(room);
}

function beginTurn(room) {
  const g = room.g;
  g.turnCount++;
  g.phase = 'roll';
  g.next = 'roll';
  g.doubles = 0;
  g.buy = null;
  log(room, `${nameOf(room, curId(room))} ist am Zug.`);
}

function nextTurn(room) {
  const g = room.g;
  if (checkWinner(room)) return;
  const n = g.order.length;
  const oldIdx = g.turnIdx;
  for (let i = 1; i <= n; i++) {
    const idx = (g.turnIdx + i) % n;
    if (!g.bankrupt[g.order[idx]]) { g.turnIdx = idx; break; }
  }
  if (g.turnIdx <= oldIdx) g.round++;
  if (limitReached(room)) { finishByLimit(room); return; }
  beginTurn(room);
}

// Spielende nach Zeit oder Runden (Hausregel in der Lobby): "none", "m60" (Minuten), "r30" (Runden).
function limitOf(room) {
  const m = /^([mr])(\d+)$/.exec(String((room.settings && room.settings.limit) || 'none'));
  return m ? { mode: m[1] === 'm' ? 'minutes' : 'rounds', value: Number(m[2]) } : null;
}

function limitReached(room) {
  const lim = limitOf(room);
  const g = room.g;
  if (!lim) return false;
  if (lim.mode === 'minutes') return Date.now() - g.startedAt >= lim.value * 60000;
  return g.round > lim.value;
}

function finishByLimit(room) {
  const g = room.g;
  const left = alive(room).slice().sort((a, b) => netWorth(room, b) - netWorth(room, a));
  g.phase = 'over';
  g.limitReached = true;
  g.winner = left[0] || null;
  room.phase = 'gameover';
  g.ranking = left.concat(g.placements.slice().reverse());
  const lim = limitOf(room);
  log(room, `⏰ ${lim.mode === 'minutes' ? `Die Spielzeit von ${lim.value} Minuten ist um` : `${lim.value} Runden sind gespielt`} – ${g.winner ? nameOf(room, g.winner) : 'niemand'} ist am reichsten und gewinnt!`);
}

function recordEvent(g, e) {
  e.seq = ++g.eventSeq;
  e.move = g.moveSeq;
  g.events.push(e);
  if (g.events.length > 8) g.events.shift();
}

function checkWinner(room) {
  const g = room.g;
  const left = alive(room);
  if (left.length > 1) return false;
  g.phase = 'over';
  g.winner = left[0] || null;
  room.phase = 'gameover';
  const ranking = g.winner ? [g.winner].concat(g.placements.slice().reverse()) : g.placements.slice().reverse();
  g.ranking = ranking;
  if (g.winner) log(room, `🏆 ${nameOf(room, g.winner)} hat gewonnen und beherrscht Entenhausen!`);
  return true;
}

// ---------------------------------------------------------------------------
// Geld
// ---------------------------------------------------------------------------

function transfer(room, from, to, amount) {
  const g = room.g;
  if (from != null) g.money[from] -= amount;
  if (to != null) g.money[to] += amount;
}

// Zahlt sofort, wenn das Geld reicht - sonst entsteht eine Schuld, die erst
// beglichen werden muss (Grundstücke beleihen, Häuser verkaufen oder aufgeben).
function pay(room, from, to, amount, reason) {
  const g = room.g;
  if (amount <= 0) return;
  const hasDebt = g.debts.some((d) => d.from === from);
  if (!hasDebt && g.money[from] >= amount) {
    transfer(room, from, to, amount);
    if (!to) toPot(room, amount);
    log(room, `${nameOf(room, from)} zahlt ${fmt(amount)}${to ? ' an ' + nameOf(room, to) : rule(room, 'freeParking') ? ' in die Mitte' : ''} (${reason}).`);
    return;
  }
  g.debts.push({ from, to: to || null, amount, reason });
  log(room, `${nameOf(room, from)} schuldet ${to ? nameOf(room, to) : 'der Bank'} ${fmt(amount)} (${reason}) – Geld beschaffen oder aufgeben!`);
}

// Strafen und Steuern wandern bei "Frei Parken mit Jackpot" in die Tischmitte.
function toPot(room, amount) {
  if (rule(room, 'freeParking')) room.g.pot += amount;
}

function settleDebts(room) {
  const g = room.g;
  let changed = true;
  while (changed) {
    changed = false;
    const debtors = Array.from(new Set(g.debts.map((d) => d.from)));
    for (const id of debtors) {
      for (const d of g.debts.filter((x) => x.from === id)) {
        if (g.money[id] >= d.amount) {
          transfer(room, id, d.to, d.amount);
          if (!d.to) toPot(room, d.amount);
          g.debts.splice(g.debts.indexOf(d), 1);
          log(room, `${nameOf(room, id)} begleicht ${fmt(d.amount)}${d.to ? ' an ' + nameOf(room, d.to) : ''} (${d.reason}).`);
          changed = true;
        } else break; // Reihenfolge beibehalten
      }
    }
  }
}

function debtTotal(g, id) {
  return g.debts.filter((d) => d.from === id).reduce((s, d) => s + d.amount, 0);
}

// ---------------------------------------------------------------------------
// Ablauf-Steuerung
// ---------------------------------------------------------------------------

// Wird nach jeder Aktion aufgerufen, die eine blockierende Situation lösen
// könnte. Bestimmt die nächste Phase.
function proceed(room) {
  const g = room.g;
  if (g.phase === 'over') return;
  settleDebts(room);
  if (g.debts.length) { g.phase = 'debt'; return; }
  if (g.pendingMove) {
    const m = g.pendingMove;
    g.pendingMove = null;
    movePlayer(room, m.id, m.steps, { dice: m.steps });
    return proceed(room);
  }
  if (g.buy) { g.phase = 'buy'; return; }
  if (g.auction) { g.phase = 'auction'; return; }
  if (g.auctionQueue.length) {
    startAuction(room, g.auctionQueue.shift());
    return proceed(room);
  }
  if (g.bankrupt[curId(room)]) { nextTurn(room); return; }
  if (checkWinner(room)) return;
  g.phase = g.next;
}

// ---------------------------------------------------------------------------
// Bewegung und Landen
// ---------------------------------------------------------------------------

// Jede Bewegung wird protokolliert, damit die Clients sie nacheinander zeigen
// können (erst zum Feld laufen, Karte/Knast-Animation, dann der Sprung).
function recordMove(g, m) {
  m.seq = ++g.moveSeq;
  m.card = g.cardSeq;
  g.lastMove = m;
  g.moves.push(m);
  if (g.moves.length > 12) g.moves.shift();
}

function movePlayer(room, id, steps, ctx) {
  const g = room.g;
  const from = g.pos[id];
  const raw = from + steps;
  const to = ((raw % 40) + 40) % 40;
  g.pos[id] = to;
  recordMove(g, { id, from, to, kind: steps >= 0 ? 'steps' : 'back' });
  if (steps > 0 && raw >= 40) {
    const bonus = rule(room, 'doubleGo') && to === 0;
    const sum = bonus ? GO_SALARY * 2 : GO_SALARY;
    transfer(room, null, id, sum);
    log(room, `${nameOf(room, id)} ${bonus ? 'landet genau auf LOS und erhält das doppelte Gehalt:' : 'zieht über LOS und erhält'} ${fmt(sum)}.`);
  }
  landOn(room, id, ctx || {});
}

function advanceTo(room, id, pos, ctx) {
  const g = room.g;
  const from = g.pos[id];
  g.pos[id] = pos;
  recordMove(g, { id, from, to: pos, kind: 'steps' });
  if (pos < from) {
    const bonus = rule(room, 'doubleGo') && pos === 0;
    const sum = bonus ? GO_SALARY * 2 : GO_SALARY;
    transfer(room, null, id, sum);
    log(room, `${nameOf(room, id)} ${bonus ? 'landet genau auf LOS und erhält das doppelte Gehalt:' : 'zieht über LOS und erhält'} ${fmt(sum)}.`);
  }
  landOn(room, id, ctx || {});
}

function sendToJail(room, id) {
  const g = room.g;
  const from = g.pos[id];
  g.pos[id] = JAIL_POS;
  g.inJail[id] = true;
  g.jailTurns[id] = 0;
  g.doubles = 0;
  g.next = 'end';
  recordMove(g, { id, from, to: JAIL_POS, kind: 'jail' });
  log(room, `🚔 ${nameOf(room, id)} landet im Panzerknacker-Knast!`);
}

function computeRent(room, sq, ctx) {
  const g = room.g;
  const p = g.props[sq.pos];
  if (sq.type === 'property') {
    if (p.houses > 0) return sq.rent[p.houses];
    return ownsAllInGroup(g, p.owner, sq.group) ? sq.rent[0] * 2 : sq.rent[0];
  }
  if (sq.type === 'station') {
    const n = countOwned(g, p.owner, 'station');
    return 25 * Math.pow(2, n - 1) * (ctx.doubleRent ? 2 : 1);
  }
  // Versorgungswerk
  const n = countOwned(g, p.owner, 'utility');
  let dice = ctx.dice || (g.dice[0] + g.dice[1]);
  let mult = n === 2 ? 10 : 4;
  if (ctx.tenTimes) {
    dice = rollDie(room) + rollDie(room);
    mult = 10;
    log(room, `${nameOf(room, curId(room))} würfelt ${dice} für die Werke-Miete.`);
  }
  return dice * mult;
}

function landOn(room, id, ctx) {
  const g = room.g;
  const sq = SQUARES[g.pos[id]];
  switch (sq.type) {
    case 'property':
    case 'station':
    case 'utility': {
      const p = g.props[sq.pos];
      if (!p) {
        g.buy = { pos: sq.pos, playerId: id, price: sq.price };
        log(room, `${nameOf(room, id)} landet auf ${sq.name} (frei, ${fmt(sq.price)}).`);
        return;
      }
      if (p.owner === id) { log(room, `${nameOf(room, id)} landet auf dem eigenen Feld ${sq.name}.`); return; }
      if (p.mortgaged) { log(room, `${nameOf(room, id)} landet auf ${sq.name} – beliehen, keine Miete.`); return; }
      if (!rule(room, 'jailRent') && g.inJail[p.owner]) { log(room, `${nameOf(room, id)} landet auf ${sq.name} – ${nameOf(room, p.owner)} sitzt im Knast, keine Miete.`); return; }
      const rent = computeRent(room, sq, ctx);
      g.stats[id].rentOut += rent; g.stats[p.owner].rentIn += rent;
      recordEvent(g, { kind: 'rent', payer: id, owner: p.owner, pos: sq.pos, amount: rent });
      if (!g.hl.bigRent || rent > g.hl.bigRent.amount) g.hl.bigRent = { payer: id, owner: p.owner, pos: sq.pos, amount: rent, round: g.round };
      pay(room, id, p.owner, rent, `Miete für ${sq.name}`);
      return;
    }
    case 'tax':
      g.stats[id].taxes += sq.amount;
      recordEvent(g, { kind: 'tax', payer: id, pos: sq.pos, amount: sq.amount });
      pay(room, id, null, sq.amount, sq.name);
      return;
    case 'parking':
      if (g.pot > 0) {
        transfer(room, null, id, g.pot);
        log(room, `🅿️ ${nameOf(room, id)} räumt bei Frei Parken den Jackpot ab: ${fmt(g.pot)}!`);
        g.pot = 0;
      }
      return;
    case 'gotojail':
      sendToJail(room, id);
      return;
    case 'chance':
      drawCard(room, id, 'chance');
      return;
    case 'community':
      drawCard(room, id, 'community');
      return;
    default:
      return;
  }
}

function nearest(g, from, type) {
  for (let i = 1; i <= 40; i++) {
    const pos = (from + i) % 40;
    if (SQUARES[pos].type === type) return pos;
  }
  return from;
}

function drawCard(room, id, deckName) {
  const g = room.g;
  const deck = g.decks[deckName];
  if (!deck.draw.length) {
    deck.draw = shuffle(deck.discard, room.rng);
    deck.discard = [];
  }
  const idx = deck.draw.shift();
  const card = CARDS[deckName][idx];
  g.lastCard = { seq: ++g.cardSeq, deck: deckName, label: CARDS.LABEL[deckName], text: card.text, playerId: id };
  log(room, `🃏 ${nameOf(room, id)} zieht eine ${CARDS.LABEL[deckName]}: ${card.text}`);
  const a = card.a;
  if (a.t === 'jailFree') {
    g.jailCards[id].push(deckName);
  } else {
    deck.discard.push(idx);
  }
  switch (a.t) {
    case 'collect':
      transfer(room, null, id, a.n);
      break;
    case 'pay':
      pay(room, id, null, a.n, 'Karte');
      break;
    case 'collectEach':
      alive(room).filter((o) => o !== id).forEach((o) => pay(room, o, id, a.n, 'Karte'));
      break;
    case 'payEach':
      alive(room).filter((o) => o !== id).forEach((o) => pay(room, id, o, a.n, 'Karte'));
      break;
    case 'advance':
      advanceTo(room, id, a.pos, {});
      break;
    case 'nearestStation':
      advanceTo(room, id, nearest(g, g.pos[id], 'station'), { doubleRent: true });
      break;
    case 'nearestUtility':
      advanceTo(room, id, nearest(g, g.pos[id], 'utility'), { tenTimes: true });
      break;
    case 'back':
      movePlayer(room, id, -a.n, {});
      break;
    case 'jail':
      sendToJail(room, id);
      break;
    case 'repairs': {
      const b = buildingsOf(g, id);
      const cost = b.houses * a.house + b.hotels * a.hotel;
      if (cost > 0) pay(room, id, null, cost, 'Reparaturen');
      else log(room, `${nameOf(room, id)} hat keine Gebäude – keine Kosten.`);
      break;
    }
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Würfeln
// ---------------------------------------------------------------------------

function doRoll(room, id) {
  const g = room.g;
  if (!isCurrent(room, id) || g.phase !== 'roll') return fail('Du kannst gerade nicht würfeln.');
  const d1 = rollDie(room);
  const d2 = rollDie(room);
  const total = d1 + d2;
  const dbl = d1 === d2;
  g.dice = [d1, d2];
  g.rollSeq++;
  log(room, `🎲 ${nameOf(room, id)} würfelt ${d1} + ${d2} = ${total}${dbl ? ' (Pasch!)' : ''}.`);

  if (g.inJail[id]) {
    if (dbl) {
      g.inJail[id] = false;
      g.jailTurns[id] = 0;
      g.next = 'end'; // nach dem Knast gibt es für den Pasch keinen Extrawurf
      log(room, `${nameOf(room, id)} kommt mit einem Pasch aus dem Knast frei.`);
      movePlayer(room, id, total, { dice: total });
    } else {
      g.jailTurns[id]++;
      g.next = 'end';
      if (g.jailTurns[id] >= MAX_JAIL_TURNS) {
        log(room, `${nameOf(room, id)} hat den dritten Versuch verpasst und zahlt ${fmt(JAIL_FEE)}.`);
        g.inJail[id] = false;
        g.jailTurns[id] = 0;
        g.pendingMove = { id, steps: total };
        pay(room, id, null, JAIL_FEE, 'Knast-Kaution');
      } else {
        log(room, `${nameOf(room, id)} bleibt im Knast (Versuch ${g.jailTurns[id]}/${MAX_JAIL_TURNS}).`);
      }
    }
  } else if (dbl) {
    g.doubles++;
    if (g.doubles >= 3) {
      log(room, `${nameOf(room, id)} würfelt den dritten Pasch in Folge – ab in den Knast!`);
      sendToJail(room, id);
    } else {
      g.next = 'roll';
      movePlayer(room, id, total, { dice: total });
    }
  } else {
    g.next = 'end';
    movePlayer(room, id, total, { dice: total });
  }
  proceed(room);
  return ok();
}

function payJail(room, id) {
  const g = room.g;
  if (!isCurrent(room, id) || g.phase !== 'roll' || !g.inJail[id]) return fail('Das geht gerade nicht.');
  if (g.money[id] < JAIL_FEE) return fail(`Dir fehlen ${fmt(JAIL_FEE)} für die Kaution.`);
  transfer(room, id, null, JAIL_FEE);
  toPot(room, JAIL_FEE);
  g.inJail[id] = false;
  g.jailTurns[id] = 0;
  log(room, `${nameOf(room, id)} zahlt ${fmt(JAIL_FEE)} Kaution und ist frei.`);
  return ok();
}

function useJailCard(room, id) {
  const g = room.g;
  if (!isCurrent(room, id) || g.phase !== 'roll' || !g.inJail[id]) return fail('Das geht gerade nicht.');
  if (!g.jailCards[id].length) return fail('Du hast keine Freikarte.');
  const deckName = g.jailCards[id].shift();
  g.decks[deckName].discard.push(deckName === 'chance'
    ? CARDS.chance.findIndex((c) => c.a.t === 'jailFree')
    : CARDS.community.findIndex((c) => c.a.t === 'jailFree'));
  g.inJail[id] = false;
  g.jailTurns[id] = 0;
  log(room, `${nameOf(room, id)} nutzt eine Freikarte und verlässt den Knast.`);
  return ok();
}

function endTurn(room, id) {
  const g = room.g;
  if (!isCurrent(room, id) || g.phase !== 'end') return fail('Du kannst den Zug gerade nicht beenden.');
  nextTurn(room);
  return ok();
}

// ---------------------------------------------------------------------------
// Kaufen und Versteigern
// ---------------------------------------------------------------------------

function buy(room, id) {
  const g = room.g;
  if (g.phase !== 'buy' || !g.buy || g.buy.playerId !== id) return fail('Es gibt nichts zu kaufen.');
  const sq = SQUARES[g.buy.pos];
  if (g.money[id] < sq.price) return fail('Dafür reicht dein Geld nicht.');
  transfer(room, id, null, sq.price);
  g.props[sq.pos] = { owner: id, houses: 0, mortgaged: false };
  g.stats[id].bought++;
  g.buy = null;
  log(room, `🏠 ${nameOf(room, id)} kauft ${sq.name} für ${fmt(sq.price)}.`);
  proceed(room);
  return ok();
}

function declineBuy(room, id) {
  const g = room.g;
  if (g.phase !== 'buy' || !g.buy || g.buy.playerId !== id) return fail('Es gibt nichts zu versteigern.');
  const pos = g.buy.pos;
  g.buy = null;
  if (!rule(room, 'auction')) {
    log(room, `${nameOf(room, id)} kauft nicht – ${SQUARES[pos].name} bleibt frei.`);
    proceed(room);
    return ok();
  }
  log(room, `${nameOf(room, id)} kauft nicht – ${SQUARES[pos].name} wird versteigert.`);
  startAuction(room, pos);
  proceed(room);
  return ok();
}

function startAuction(room, pos) {
  const g = room.g;
  const n = g.order.length;
  const order = [];
  for (let i = 1; i <= n; i++) {
    const id = g.order[(g.turnIdx + i) % n];
    if (!g.bankrupt[id]) order.push(id);
  }
  g.auction = { pos, order, idx: 0, highBid: 0, highBidder: null, passed: [], minBid: MIN_BID, bids: [] };
  log(room, `🔨 Auktion für ${SQUARES[pos].name} (Mindestgebot ${fmt(MIN_BID)}).`);
  auctionNext(room);
}

function auctionNext(room) {
  const g = room.g;
  const a = g.auction;
  if (!a) return;
  const n = a.order.length;
  for (let guard = 0; guard < 3 * n + 3; guard++) {
    const active = a.order.filter((x) => !a.passed.includes(x));
    if (active.length === 0 || (a.highBidder && active.length <= 1)) { finishAuction(room); return; }
    const cur = a.order[a.idx];
    if (a.passed.includes(cur)) { a.idx = (a.idx + 1) % n; continue; }
    if (cur === a.highBidder) { a.idx = (a.idx + 1) % n; continue; }
    const minRaise = Math.max(a.minBid, a.highBid + 1);
    if (g.money[cur] < minRaise) {
      a.passed.push(cur);
      log(room, `${nameOf(room, cur)} kann nicht mehr mitbieten.`);
      a.idx = (a.idx + 1) % n;
      continue;
    }
    return; // cur ist am Zug
  }
  finishAuction(room);
}

function finishAuction(room) {
  const g = room.g;
  const a = g.auction;
  const sq = SQUARES[a.pos];
  g.auction = null;
  if (a.highBidder) {
    transfer(room, a.highBidder, null, a.highBid);
    g.props[a.pos] = { owner: a.highBidder, houses: 0, mortgaged: false };
    g.stats[a.highBidder].bought++;
    g.lastAuction = { seq: (g.lastAuction ? g.lastAuction.seq : 0) + 1, pos: a.pos, winner: a.highBidder, amount: a.highBid };
    log(room, `🔨 ${nameOf(room, a.highBidder)} ersteigert ${sq.name} für ${fmt(a.highBid)}.`);
  } else {
    log(room, `Niemand bietet – ${sq.name} bleibt bei der Bank.`);
  }
  proceed(room);
}

function auctionBidder(g) {
  return g.auction ? g.auction.order[g.auction.idx] : null;
}

function bid(room, id, amount) {
  const g = room.g;
  const a = g.auction;
  if (g.phase !== 'auction' || !a || auctionBidder(g) !== id) return fail('Du bist gerade nicht mit Bieten dran.');
  amount = Math.round(Number(amount));
  const minRaise = Math.max(a.minBid, a.highBid + 1);
  if (!Number.isFinite(amount) || amount < minRaise) return fail(`Das Gebot muss mindestens ${fmt(minRaise)} betragen.`);
  if (amount > g.money[id]) return fail('Du hast nicht genug Geld für dieses Gebot.');
  a.highBid = amount;
  a.highBidder = id;
  a.bids.push({ id, amount });
  log(room, `${nameOf(room, id)} bietet ${fmt(amount)}.`);
  a.idx = (a.idx + 1) % a.order.length;
  auctionNext(room);
  return ok();
}

function passAuction(room, id) {
  const g = room.g;
  const a = g.auction;
  if (g.phase !== 'auction' || !a || auctionBidder(g) !== id) return fail('Du bist gerade nicht mit Bieten dran.');
  a.passed.push(id);
  log(room, `${nameOf(room, id)} passt.`);
  a.idx = (a.idx + 1) % a.order.length;
  auctionNext(room);
  return ok();
}

// ---------------------------------------------------------------------------
// Bauen, Beleihen
// ---------------------------------------------------------------------------

function canManage(room, id) {
  const g = room.g;
  if (g.phase === 'over') return 'Das Spiel ist vorbei.';
  if (g.phase === 'auction') return 'Während einer Auktion geht das nicht.';
  if (g.bankrupt[id]) return 'Du bist ausgeschieden.';
  return null;
}

function groupHouses(g, group) {
  return GROUP_POSITIONS[group].map((pos) => (g.props[pos] ? g.props[pos].houses : 0));
}

function buildCheck(room, id, pos) {
  const g = room.g;
  const err = canManage(room, id);
  if (err) return err;
  const sq = SQUARES[pos];
  const p = g.props[pos];
  if (!sq || sq.type !== 'property' || !p || p.owner !== id) return 'Das Grundstück gehört dir nicht.';
  if (g.debts.some((d) => d.from === id)) return 'Erst die Schulden begleichen.';
  if (!ownsAllInGroup(g, id, sq.group)) return 'Du brauchst alle Straßen dieser Farbe.';
  if (GROUP_POSITIONS[sq.group].some((x) => g.props[x].mortgaged)) return 'Ein Grundstück dieser Farbe ist beliehen.';
  if (p.houses >= 5) return 'Hier steht schon ein Hotel.';
  if (rule(room, 'evenBuild') && p.houses > Math.min(...groupHouses(g, sq.group))) return 'Baue gleichmäßig: erst auf den anderen Straßen der Farbe.';
  const cost = GROUPS[sq.group].houseCost;
  if (g.money[id] < cost) return `Dir fehlen ${fmt(cost)}.`;
  if (p.houses < 4 && g.housesLeft <= 0) return 'Die Bank hat keine Häuser mehr.';
  if (p.houses === 4 && g.hotelsLeft <= 0) return 'Die Bank hat keine Hotels mehr.';
  return null;
}

function build(room, id, pos) {
  const g = room.g;
  const err = buildCheck(room, id, pos);
  if (err) return fail(err);
  const sq = SQUARES[pos];
  const p = g.props[pos];
  const cost = GROUPS[sq.group].houseCost;
  transfer(room, id, null, cost);
  p.houses++;
  g.stats[id].built++;
  if (p.houses === 5) { g.housesLeft += 4; g.hotelsLeft--; } else g.housesLeft--;
  log(room, `🏗️ ${nameOf(room, id)} baut auf ${sq.name} ${p.houses === 5 ? 'ein Hotel' : 'ein Haus'} (${fmt(cost)}).`);
  return ok();
}

function sellCheck(room, id, pos) {
  const g = room.g;
  const err = canManage(room, id);
  if (err) return err;
  const sq = SQUARES[pos];
  const p = g.props[pos];
  if (!sq || sq.type !== 'property' || !p || p.owner !== id) return 'Das Grundstück gehört dir nicht.';
  if (p.houses <= 0) return 'Hier stehen keine Gebäude.';
  if (rule(room, 'evenBuild') && p.houses < Math.max(...groupHouses(g, sq.group))) return 'Verkaufe gleichmäßig: erst auf der Straße mit den meisten Gebäuden.';
  if (p.houses === 5 && g.housesLeft < 4) return 'Die Bank hat nicht genug Häuser, um das Hotel zu ersetzen.';
  return null;
}

function sellBuilding(room, id, pos) {
  const g = room.g;
  const err = sellCheck(room, id, pos);
  if (err) return fail(err);
  const sq = SQUARES[pos];
  const p = g.props[pos];
  const refund = GROUPS[sq.group].houseCost / 2;
  if (p.houses === 5) { g.hotelsLeft++; g.housesLeft -= 4; } else g.housesLeft++;
  p.houses--;
  transfer(room, null, id, refund);
  log(room, `${nameOf(room, id)} verkauft ein Gebäude auf ${sq.name} und erhält ${fmt(refund)}.`);
  if (g.debts.length) proceed(room);
  return ok();
}

function mortgageCheck(room, id, pos) {
  const g = room.g;
  const err = canManage(room, id);
  if (err) return err;
  const sq = SQUARES[pos];
  const p = g.props[pos];
  if (!sq || !p || p.owner !== id) return 'Das Grundstück gehört dir nicht.';
  if (p.mortgaged) return 'Schon beliehen.';
  if (sq.type === 'property' && groupHouses(g, sq.group).some((h) => h > 0)) return 'Verkaufe zuerst alle Gebäude dieser Farbe.';
  return null;
}

function mortgage(room, id, pos) {
  const g = room.g;
  const err = mortgageCheck(room, id, pos);
  if (err) return fail(err);
  const sq = SQUARES[pos];
  g.props[pos].mortgaged = true;
  transfer(room, null, id, mortgageValue(sq));
  log(room, `${nameOf(room, id)} beleiht ${sq.name} und erhält ${fmt(mortgageValue(sq))}.`);
  if (g.debts.length) proceed(room);
  return ok();
}

function unmortgageCheck(room, id, pos) {
  const g = room.g;
  const err = canManage(room, id);
  if (err) return err;
  const sq = SQUARES[pos];
  const p = g.props[pos];
  if (!sq || !p || p.owner !== id) return 'Das Grundstück gehört dir nicht.';
  if (!p.mortgaged) return 'Nicht beliehen.';
  const cost = unmortgageCost(sq);
  if (g.money[id] < cost) return `Dir fehlen ${fmt(cost)}.`;
  return null;
}

function unmortgage(room, id, pos) {
  const g = room.g;
  const err = unmortgageCheck(room, id, pos);
  if (err) return fail(err);
  const sq = SQUARES[pos];
  const cost = unmortgageCost(sq);
  transfer(room, id, null, cost);
  g.props[pos].mortgaged = false;
  log(room, `${nameOf(room, id)} löst die Hypothek auf ${sq.name} ein (${fmt(cost)}).`);
  return ok();
}

// ---------------------------------------------------------------------------
// Handeln
// ---------------------------------------------------------------------------

function cleanSide(side) {
  const s = side || {};
  const props = Array.from(new Set((Array.isArray(s.props) ? s.props : []).map(Number).filter(Number.isInteger)));
  return {
    cash: Math.max(0, Math.round(Number(s.cash)) || 0),
    props,
    cards: Math.max(0, Math.round(Number(s.cards)) || 0),
  };
}

function tradeError(room, t) {
  const g = room.g;
  if (t.from === t.to) return 'Du kannst nicht mit dir selbst handeln.';
  if (g.bankrupt[t.from] || g.bankrupt[t.to]) return 'Jemand ist bereits ausgeschieden.';
  const empty = (s) => !s.cash && !s.props.length && !s.cards;
  if (empty(t.give) && empty(t.get)) return 'Das Angebot ist leer.';
  const sides = [[t.from, t.give], [t.to, t.get]];
  for (const [owner, side] of sides) {
    if (side.cash > g.money[owner]) return `${nameOf(room, owner)} hat nicht genug Geld dafür.`;
    if (side.cards > g.jailCards[owner].length) return `${nameOf(room, owner)} hat nicht so viele Freikarten.`;
    for (const pos of side.props) {
      const p = g.props[pos];
      if (!p || p.owner !== owner) return 'Ein Grundstück gehört nicht der angegebenen Person.';
      const sq = SQUARES[pos];
      if (sq.type === 'property' && groupHouses(g, sq.group).some((h) => h > 0)) {
        return `${sq.name}: In dieser Farbgruppe stehen noch Gebäude – erst verkaufen.`;
      }
    }
  }
  return null;
}

function proposeTrade(room, id, a) {
  const g = room.g;
  const err = canManage(room, id);
  if (err) return fail(err);
  if (g.trade) return fail('Es läuft bereits ein Handelsangebot.');
  const to = a.to;
  if (!room.players.some((p) => p.id === to)) return fail('Unbekannte Person.');
  const t = { id: ++g.tradeSeq, from: id, to, give: cleanSide(a.give), get: cleanSide(a.get) };
  const e = tradeError(room, t);
  if (e) return fail(e);
  g.trade = t;
  log(room, `🤝 ${nameOf(room, id)} macht ${nameOf(room, to)} ein Handelsangebot.`);
  return ok();
}

function cancelTrade(room, id, a) {
  const g = room.g;
  if (!g.trade || (g.trade.from !== id && g.trade.to !== id)) return fail('Kein Angebot vorhanden.');
  const declined = g.trade.to === id;
  const me = room.players.find((x) => x.id === id);
  const reason = declined && me && me.isBot && a && typeof a.reason === 'string' ? a.reason.trim().slice(0, 90) : '';
  log(room, declined
    ? `${nameOf(room, id)} lehnt das Angebot von ${nameOf(room, g.trade.from)} ab${reason ? ': „' + reason + '“' : '.'}`
    : `${nameOf(room, id)} zieht das Angebot zurück.`);
  if (reason) g.tradeReply = { seq: ++g.tradeReplySeq, by: id, to: g.trade.from, text: reason };
  g.trade = null;
  return ok();
}

function acceptTrade(room, id) {
  const g = room.g;
  const t = g.trade;
  if (!t || t.to !== id) return fail('Kein Angebot für dich.');
  if (g.phase === 'auction') return fail('Während einer Auktion geht das nicht.');
  const e = tradeError(room, t);
  if (e) { g.trade = null; return fail(`Angebot ungültig geworden: ${e}`); }
  const move = (fromId, toId, side) => {
    transfer(room, fromId, toId, side.cash);
    side.props.forEach((pos) => {
      g.props[pos].owner = toId;
      if (g.props[pos].mortgaged) {
        const fee = Math.min(interestOnTransfer(SQUARES[pos]), g.money[toId]);
        if (fee > 0) { transfer(room, toId, null, fee); }
        log(room, `${nameOf(room, toId)} zahlt ${fmt(fee)} Zinsen für das beliehene ${SQUARES[pos].name}.`);
      }
    });
    for (let i = 0; i < side.cards; i++) g.jailCards[toId].push(g.jailCards[fromId].shift());
  };
  move(t.from, t.to, t.give);
  move(t.to, t.from, t.get);
  const desc = (side) => {
    const parts = [];
    if (side.cash) parts.push(fmt(side.cash));
    side.props.forEach((pos) => parts.push(SQUARES[pos].name));
    if (side.cards) parts.push(`${side.cards}× Freikarte`);
    return parts.join(', ') || 'nichts';
  };
  log(room, `🤝 Handel: ${nameOf(room, t.from)} gibt ${desc(t.give)} an ${nameOf(room, t.to)} und erhält ${desc(t.get)}.`);
  g.trade = null;
  if (g.debts.length) proceed(room);
  return ok();
}

// ---------------------------------------------------------------------------
// Pleite
// ---------------------------------------------------------------------------

function declareBankrupt(room, id) {
  const g = room.g;
  if (g.phase === 'over') return fail('Das Spiel ist vorbei.');
  if (g.bankrupt[id]) return fail('Du bist bereits ausgeschieden.');
  if (g.phase === 'auction') return fail('Während einer Auktion geht das nicht.');

  // Gläubiger bestimmen: gemeinsame Person aller Schulden, sonst Bank.
  const mine = g.debts.filter((d) => d.from === id);
  let creditor = null;
  if (mine.length && mine.every((d) => d.to && d.to === mine[0].to)) creditor = mine[0].to;

  // Gebäude an die Bank zum halben Preis verkaufen.
  ownedBy(g, id).forEach((pos) => {
    const p = g.props[pos];
    if (!p.houses) return;
    const sq = SQUARES[pos];
    const cost = GROUPS[sq.group].houseCost;
    if (p.houses === 5) { g.hotelsLeft++; } else { g.housesLeft += p.houses; }
    g.money[id] += (p.houses === 5 ? 5 : p.houses) * (cost / 2);
    p.houses = 0;
  });

  const cash = g.money[id];
  g.money[id] = 0;
  log(room, `💥 ${nameOf(room, id)} ist pleite${creditor ? ' – alles geht an ' + nameOf(room, creditor) : ' – alles geht an die Bank'}.`);

  if (creditor) {
    g.money[creditor] += cash;
    ownedBy(g, id).forEach((pos) => {
      const p = g.props[pos];
      p.owner = creditor;
      if (p.mortgaged) {
        const fee = Math.min(interestOnTransfer(SQUARES[pos]), g.money[creditor]);
        if (fee > 0) transfer(room, creditor, null, fee);
      }
    });
    g.jailCards[id].forEach((d) => g.jailCards[creditor].push(d));
  } else {
    ownedBy(g, id).forEach((pos) => {
      delete g.props[pos];
      if (rule(room, 'auction')) g.auctionQueue.push(pos);
    });
    g.jailCards[id].forEach((d) => {
      g.decks[d].discard.push(CARDS[d].findIndex((c) => c.a.t === 'jailFree'));
    });
  }
  g.jailCards[id] = [];

  g.debts = g.debts.filter((d) => d.from !== id).map((d) => (d.to === id ? Object.assign({}, d, { to: creditor }) : d));
  if (g.trade && (g.trade.from === id || g.trade.to === id)) g.trade = null;
  if (g.pendingMove && g.pendingMove.id === id) g.pendingMove = null;
  if (g.buy && g.buy.playerId === id) { if (rule(room, 'auction')) g.auctionQueue.push(g.buy.pos); g.buy = null; }
  g.bankrupt[id] = true;
  g.hl.busts.push({ id, round: g.round, creditor });
  g.inJail[id] = false;
  g.placements.push(id);
  proceed(room);
  return ok();
}

// ---------------------------------------------------------------------------
// Dispatcher und Zustandsabfragen
// ---------------------------------------------------------------------------

function act(room, id, a) {
  const res = actInner(room, id, a);
  if (res && res.ok && room.g) { try { afterAct(room); } catch (e) { console.error('afterAct:', e); } }
  return res;
}

// Nach jeder Aktion: neue Monopole und Häuserknappheit erkennen (für Banner und Zusammenfassung).
function afterAct(room) {
  const g = room.g;
  Object.keys(GROUP_POSITIONS).forEach((group) => {
    if (group === 'station' || group === 'utility') return;
    const ps = GROUP_POSITIONS[group];
    const first = g.props[ps[0]];
    const owner = first && !g.bankrupt[first.owner] && ps.every((pos) => g.props[pos] && g.props[pos].owner === first.owner) ? first.owner : null;
    const prev = g.groupOwner[group] || null;
    g.groupOwner[group] = owner;
    if (owner && owner !== prev) {
      g.hl.monopolies.push({ id: owner, group, round: g.round });
      recordEvent(g, { kind: 'monopoly', id: owner, group, pos: ps[Math.floor(ps.length / 2)] });
      log(room, `🌟 ${nameOf(room, owner)} besitzt jetzt die ganze Farbgruppe ${GROUPS[group].name} – Monopol!`);
    }
  });
  if (g.housesLeft >= 10) { g.shortWarn = false; g.shortZero = false; }
  if (g.housesLeft < HOUSES) {
    if (g.housesLeft === 0 && !g.shortZero) {
      g.shortZero = true; g.shortWarn = true;
      recordEvent(g, { kind: 'shortage', left: 0 });
      log(room, '🏚️ Die Bank hat keine Häuser mehr!');
    } else if (g.housesLeft > 0 && g.housesLeft <= 4 && !g.shortWarn) {
      g.shortWarn = true;
      recordEvent(g, { kind: 'shortage', left: g.housesLeft });
      log(room, `🏚️ Häuserknappheit: Nur noch ${g.housesLeft} Häuser in der Bank.`);
    }
  }
}

function actInner(room, id, a) {
  const g = room.g;
  if (!g || g.phase === 'over') return fail('Es läuft gerade kein Spiel.');
  if (g.bankrupt[id]) return fail('Du bist bereits ausgeschieden.');
  switch (a && a.type) {
    case 'roll': return doRoll(room, id);
    case 'buy': return buy(room, id);
    case 'declineBuy': return declineBuy(room, id);
    case 'bid': return bid(room, id, a.amount);
    case 'passBid': return passAuction(room, id);
    case 'endTurn': return endTurn(room, id);
    case 'payJail': return payJail(room, id);
    case 'useJailCard': return useJailCard(room, id);
    case 'build': return build(room, id, Number(a.pos));
    case 'sell': return sellBuilding(room, id, Number(a.pos));
    case 'mortgage': return mortgage(room, id, Number(a.pos));
    case 'unmortgage': return unmortgage(room, id, Number(a.pos));
    case 'proposeTrade': return proposeTrade(room, id, a);
    case 'acceptTrade': return acceptTrade(room, id);
    case 'cancelTrade': return cancelTrade(room, id, a);
    case 'resign': return declareBankrupt(room, id);
    default: return fail('Unbekannte Aktion.');
  }
}

// Wer müsste gerade etwas tun? (für Bots und "Überspringen")
function pendingActors(room) {
  const g = room.g;
  if (!g || g.phase === 'over') return [];
  const out = [];
  // Ein offenes Handelsangebot wird zuerst beantwortet (sonst blockiert es alle weiteren).
  if (g.trade && g.phase !== 'auction') out.push({ id: g.trade.to, kind: 'trade' });
  switch (g.phase) {
    case 'roll':
    case 'buy':
    case 'end':
      out.push({ id: curId(room), kind: g.phase });
      break;
    case 'auction':
      out.push({ id: auctionBidder(g), kind: 'auction' });
      break;
    case 'debt':
      Array.from(new Set(g.debts.map((d) => d.from))).forEach((id) => out.push({ id, kind: 'debt' }));
      break;
    default:
      break;
  }
  return out;
}

function snapshot(room) {
  const g = room.g;
  const players = {};
  g.order.forEach((id) => {
    players[id] = {
      money: g.money[id],
      pos: g.pos[id],
      inJail: g.inJail[id],
      jailCards: g.jailCards[id].length,
      bankrupt: g.bankrupt[id],
      netWorth: netWorth(room, id),
      debt: debtTotal(g, id),
    };
  });
  return {
    order: g.order,
    turnId: curId(room),
    phase: g.phase,
    doubles: g.doubles,
    dice: g.dice,
    rollSeq: g.rollSeq,
    players,
    props: Object.keys(g.props).map((k) => {
      const pos = Number(k);
      const p = g.props[pos];
      return {
        pos,
        owner: p.owner,
        houses: p.houses,
        mortgaged: p.mortgaged,
        // Gründe, warum eine Verwaltungsaktion gerade nicht geht (null = erlaubt) - für die Buttons.
        errBuild: buildCheck(room, p.owner, pos),
        errSell: sellCheck(room, p.owner, pos),
        errMortgage: mortgageCheck(room, p.owner, pos),
        errUnmortgage: unmortgageCheck(room, p.owner, pos),
      };
    }),
    housesLeft: g.housesLeft,
    hotelsLeft: g.hotelsLeft,
    pot: g.pot,
    rules: Object.keys(RULE_DEFAULTS).reduce((o, k) => { o[k] = rule(room, k); return o; }, {}),
    buy: g.buy,
    auction: g.auction && {
      pos: g.auction.pos,
      highBid: g.auction.highBid,
      highBidder: g.auction.highBidder,
      bidderId: auctionBidder(g),
      passed: g.auction.passed,
      order: g.auction.order,
      minBid: g.auction.minBid,
      bids: g.auction.bids,
    },
    lastAuction: g.lastAuction,
    debts: g.debts,
    trade: g.trade,
    lastCard: g.lastCard,
    lastMove: g.lastMove,
    moves: g.moves,
    winner: g.winner,
    round: g.round,
    stats: g.stats,
    hl: g.hl,
    tradeReply: g.tradeReply,
    events: g.events,
    limit: (function () { const l = limitOf(room); return l ? { mode: l.mode, value: l.value, endsAt: l.mode === 'minutes' ? g.startedAt + l.value * 60000 : null } : null; })(),
    limitReached: g.limitReached,
    ranking: g.ranking || null,
    turnCount: g.turnCount,
  };
}

module.exports = {
  RULE_DEFAULTS, GO_SALARY, JAIL_FEE, MIN_BID, HOUSES, HOTELS,
  initGame, act, snapshot, pendingActors,
  // von den Bots und Tests genutzt:
  curId, alive, ownedBy, ownsAllInGroup, countOwned, groupHouses, computeRent, netWorth,
  buildCheck, sellCheck, mortgageCheck, unmortgageCheck, unmortgageCost, mortgageValue, tradeError, debtTotal,
  fmt, nameOf, auctionBidder, shuffle,
};
