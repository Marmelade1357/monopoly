// Einfache Bot-KI für Monopoly. Ein Aufruf von botAct() führt genau EINE
// Aktion aus; der Server ruft danach (mit kurzer Verzögerung) erneut auf,
// bis die Person/der Bot nichts mehr zu tun hat.

const BOARD = require('../public/board-data.js');
const E = require('./engine.js');

const { SQUARES, GROUPS, GROUP_POSITIONS } = BOARD;

// Charaktere der Bots: unterschiedliche Vorsicht beim Kaufen, Bauen und Bieten.
const PERSONAS = {
  balanced: { buyReserve: 120, buildReserve: 200, bidFactor: 0.85, tradeStart: 1.5, tradeAccept: 1.15 },
  careful:  { buyReserve: 300, buildReserve: 400, bidFactor: 0.7,  tradeStart: 1.4, tradeAccept: 1.3 },
  bold:     { buyReserve: 20,  buildReserve: 60,  bidFactor: 1.1,  tradeStart: 1.5, tradeAccept: 1.1 },
  trader:   { buyReserve: 120, buildReserve: 200, bidFactor: 0.85, tradeStart: 1.25, tradeAccept: 1.0 },
};
// Schwierigkeitsgrad (Lobby-Einstellung): verändert die Charaktere der Bots.
const LEVELS = {
  easy:   { buyReserve: (v) => v + 200, buildReserve: (v) => v + 300, bidFactor: (v) => v * 0.65, tradeStart: (v) => v * 1.3, tradeAccept: (v) => v * 0.8, humanCooldown: 14 },
  normal: { humanCooldown: 10 },
  hard:   { buyReserve: (v) => v * 0.6, buildReserve: (v) => v * 0.7, bidFactor: (v) => v * 1.15, tradeStart: (v) => v * 0.85, tradeAccept: (v) => v * 1.12, humanCooldown: 5 },
};
function levelOf(room) {
  return LEVELS[(room.settings && room.settings.botLevel) || 'normal'] || LEVELS.normal;
}
function persona(room, id) {
  const p = room.players.find((x) => x.id === id);
  const base = PERSONAS[(p && p.persona) || 'balanced'] || PERSONAS.balanced;
  const lv = levelOf(room);
  const out = Object.assign({}, base);
  ['buyReserve', 'buildReserve', 'bidFactor', 'tradeStart', 'tradeAccept'].forEach((k) => { if (lv[k]) out[k] = lv[k](base[k]); });
  return out;
}

function rnd(room) { return (room.rng || Math.random)(); }

function completesSet(g, id, pos) {
  const sq = SQUARES[pos];
  if (!sq.group || sq.group === 'utility') return false;
  return GROUP_POSITIONS[sq.group].every((x) => x === pos || (g.props[x] && g.props[x].owner === id));
}

function valueOf(g, forId, pos) {
  const sq = SQUARES[pos];
  let v = sq.price;
  if (completesSet(g, forId, pos)) v *= 1.6;
  else if (sq.type === 'station') v *= 1.1;
  return v;
}

function manage(room, id) {
  const g = room.g;
  const money = g.money[id];
  const owned = E.ownedBy(g, id);

  // 1. Hypotheken zurückzahlen, wenn genug Geld da ist.
  const mortgaged = owned.filter((pos) => g.props[pos].mortgaged)
    .sort((a, b) => SQUARES[b].price - SQUARES[a].price);
  for (const pos of mortgaged) {
    if (money >= E.unmortgageCost(SQUARES[pos]) + 350) return { type: 'unmortgage', pos };
  }

  // 2. Bauen, solange ein Puffer bleibt.
  const reserve = persona(room, id).buildReserve;
  const candidates = owned
    .filter((pos) => SQUARES[pos].type === 'property' && !E.buildCheck(room, id, pos))
    .filter((pos) => money - GROUPS[SQUARES[pos].group].houseCost >= reserve)
    .sort((a, b) => g.props[a].houses - g.props[b].houses || SQUARES[b].price - SQUARES[a].price);
  if (candidates.length) return { type: 'build', pos: candidates[0] };
  return null;
}

function liquidationPotential(room, id) {
  const g = room.g;
  let sum = g.money[id];
  E.ownedBy(g, id).forEach((pos) => {
    const sq = SQUARES[pos];
    const p = g.props[pos];
    if (p.houses) sum += p.houses * (GROUPS[sq.group].houseCost / 2);
    if (!p.mortgaged) sum += sq.price / 2;
  });
  return sum;
}

function decideDebt(room, id) {
  const g = room.g;
  const total = E.debtTotal(g, id);
  if (liquidationPotential(room, id) < total) return { type: 'resign' };
  const owned = E.ownedBy(g, id);
  // Erst unbebaute Grundstücke beleihen (billigste zuerst), dann Gebäude verkaufen.
  const mortgageable = owned.filter((pos) => !E.mortgageCheck(room, id, pos))
    .sort((a, b) => SQUARES[a].price - SQUARES[b].price);
  if (mortgageable.length) return { type: 'mortgage', pos: mortgageable[0] };
  const sellable = owned.filter((pos) => !E.sellCheck(room, id, pos))
    .sort((a, b) => g.props[b].houses - g.props[a].houses);
  if (sellable.length) return { type: 'sell', pos: sellable[0] };
  return { type: 'resign' };
}

// Wie bewertet `id` das Angebot t? receives = was er bekommt, gives = was er hergibt.
function evalTrade(room, id, t) {
  const g = room.g;
  const mine = t.to === id ? t.give : t.get;
  const theirs = t.to === id ? t.get : t.give;
  const receives = mine.cash + mine.props.reduce((s, p) => s + valueOf(g, id, p) * (g.props[p].mortgaged ? 0.6 : 1), 0) + mine.cards * 50;
  let breaks = null, needs = null;
  const gives = theirs.cash + theirs.props.reduce((s, p) => {
    const sq = SQUARES[p];
    const breaksSet = sq.group && E.ownsAllInGroup(g, id, sq.group) && sq.group !== 'utility' && sq.group !== 'station';
    if (breaksSet && !breaks) breaks = p;
    if (!breaksSet && sq.group && sq.group !== 'utility' && sq.group !== 'station' && E.countOwned(g, id, sq.group) >= Math.ceil(GROUP_POSITIONS[sq.group].length / 2) && !needs) needs = p;
    return s + sq.price * (breaksSet ? 3 : 1.15);
  }, 0) + theirs.cards * 60;
  return { receives, gives, breaks, needs };
}

function decideTrade(room, id) {
  const g = room.g;
  const t = g.trade;
  const { receives, gives, breaks, needs } = evalTrade(room, id, t);
  if (receives > 0 && receives >= gives * persona(room, id).tradeAccept) return { type: 'acceptTrade' };
  let reason;
  if (breaks !== null) reason = 'Dafür müsste ich mein Farbset aufgeben.';
  else if (needs !== null) reason = 'Das Grundstück brauche ich selbst.';
  else if (receives <= 0) reason = 'Für mich springt dabei nichts raus.';
  else if (t.get.cash > g.money[id] * 0.6) reason = 'Dafür habe ich gerade zu wenig Geld.';
  else if (receives < gives * 0.6) reason = 'Das ist mir deutlich zu wenig.';
  else reason = 'Ein bisschen mehr müsste es schon sein.';
  return { type: 'cancelTrade', reason };
}

// Fairer Vorschlag für `from` an `to` (für den Knopf "Vorschlag" im Handelsfenster).
// Gibt { ok, give, get, note } oder { ok: false, error } zurück; ändert nichts am Spiel.
function suggestTrade(room, from, to) {
  const g = room.g;
  if (!g || from === to || g.bankrupt[from] || g.bankrupt[to]) return { ok: false, error: 'Kein Vorschlag möglich.' };
  const toBot = !!(room.players.find((p) => p.id === to) || {}).isBot;
  const need = toBot ? persona(room, to).tradeAccept * 1.03 : 1.15;
  const fair = (t) => { const e = evalTrade(room, to, t); return e.receives > 0 && e.receives >= e.gives * need; };
  const side = (cash, props) => ({ cash, props: props || [], cards: 0 });
  const tradeable = (pos) => SQUARES[pos].type === 'property' || SQUARES[pos].type === 'station' || SQUARES[pos].type === 'utility';
  const mineIn = (pos) => (SQUARES[pos].group ? E.countOwned(g, from, SQUARES[pos].group) : 0);
  const wants = E.ownedBy(g, to).filter(tradeable).filter((pos) => mineIn(pos) > 0)
    .sort((a, b) => (completesSet(g, from, b) - completesSet(g, from, a)) || (mineIn(b) - mineIn(a)) || (SQUARES[b].price - SQUARES[a].price))
    .slice(0, 6);
  if (!wants.length) return { ok: false, error: 'Bei dieser Person gibt es nichts, das zu deinen Grundstücken passt.' };
  const myMax = g.money[from] - 50;
  const mk = (give, get) => ({ id: 0, from, to, give, get });
  for (const pos of wants) {
    const price = SQUARES[pos].price;
    // 1. Kaufen: kleinstes faires Bargeldangebot
    for (let cash = Math.ceil((price * 0.7) / 10) * 10; cash <= Math.min(myMax, price * 4); cash += 10) {
      const t = mk(side(cash), side(0, [pos]));
      if (fair(t) && !E.tradeError(room, t)) {
        return { ok: true, give: t.give, get: t.get, note: `${SQUARES[pos].name} ${completesSet(g, from, pos) ? 'vervollständigt dein Farbset' : 'passt zu deinem Besitz'} – für ${cash} ₮ sollte ${E.nameOf(room, to)} zustimmen.` };
      }
    }
  }
  // 2. Tauschen: eigenes Grundstück, das der anderen Person passt (nur aus Gruppen, in denen ich wenig habe)
  const spare = E.ownedBy(g, from).filter(tradeable).filter((pos) => mineIn(pos) <= 1 && SQUARES[pos].type === 'property');
  for (const pos of wants) {
    for (const mp of spare) {
      for (let cash = 0; cash <= Math.max(0, Math.min(myMax, 400)); cash += 10) {
        const t = mk(side(cash, [mp]), side(0, [pos]));
        if (fair(t) && !E.tradeError(room, t)) {
          return { ok: true, give: t.give, get: t.get, note: `Tausch: ${SQUARES[mp].name}${cash ? ' plus ' + cash + ' ₮' : ''} gegen ${SQUARES[pos].name}.` };
        }
      }
    }
  }
  return { ok: false, error: 'Mir fällt kein faires Angebot ein – vielleicht fehlt das Geld.' };
}

// Bots schlagen anderen Bots (und, seltener, anwesenden Menschen) Tauschgeschäfte vor, mit denen sie ein Farbset
// vervollständigen - sonst würden reine Bot-Runden nie zu Monopolen kommen.
// Pro Zug höchstens ein Angebot; nach jedem Angebot wird das nächste großzügiger.
function tradeIdea(room, id) {
  const g = room.g;
  if (g.trade || (g.botTradeTurn && g.botTradeTurn[id] === g.turnCount)) return null;
  const botIds = new Set(room.players.filter((p) => p.isBot).map((p) => p.id));
  const humanIds = new Set(room.players.filter((p) => !p.isBot && p.connected && !p.left && !p.afk).map((p) => p.id));
  const groups = Object.keys(GROUP_POSITIONS).filter((k) => k !== 'station' && k !== 'utility');
  const options = [];
  for (const group of groups) {
    const positions = GROUP_POSITIONS[group];
    if (positions.some((pos) => g.props[pos] && g.props[pos].houses > 0)) continue;
    const mine = positions.filter((pos) => g.props[pos] && g.props[pos].owner === id);
    if (!mine.length || mine.length === positions.length) continue;
    positions.filter((pos) => !mine.includes(pos)).forEach((pos) => {
      const p = g.props[pos];
      if (!p || g.bankrupt[p.owner] || p.owner === id) return;
      if (!botIds.has(p.owner)) {
        // Menschen bekommen höchstens alle 10 Züge ein Angebot von demselben Bot.
        if (!humanIds.has(p.owner)) return;
        const last = (g.botHumanTrade || {})[id + ':' + p.owner];
        if (last !== undefined && g.turnCount - last < levelOf(room).humanCooldown) return;
      }
      // Nur von Bots kaufen, die mit diesem Feld selbst keinen Satz aufbauen.
      const theirs = positions.filter((x) => g.props[x] && g.props[x].owner === p.owner).length;
      if (theirs > 1 && positions.length - mine.length > 1) return;
      options.push({ pos, owner: p.owner, mine: mine.length, human: !botIds.has(p.owner) });
    });
  }
  options.sort((a, b) => b.mine - a.mine);
  for (const o of options) {
    g.botTradeFactor = g.botTradeFactor || {};
    const factor = g.botTradeFactor[id] || persona(room, id).tradeStart;
    const offer = Math.ceil((SQUARES[o.pos].price * (o.human ? Math.max(factor, (room.settings && room.settings.botLevel) === 'hard' ? 1.5 : 1.7) : factor)) / 10) * 10;
    if (g.money[id] - offer < 100) continue;
    const toHuman = !botIds.has(o.owner);
    g.botTradeTurn = g.botTradeTurn || {};
    if (toHuman) { g.botHumanTrade = g.botHumanTrade || {}; g.botHumanTrade[id + ':' + o.owner] = g.turnCount; }
    g.botTradeTurn[id] = g.turnCount;
    g.botTradeFactor[id] = Math.min(6, factor + 0.35);
    return { type: 'proposeTrade', to: o.owner, give: { cash: offer, props: [], cards: 0 }, get: { cash: 0, props: [o.pos], cards: 0 } };
  }
  return null;
}

function decide(room, actor) {
  const g = room.g;
  const id = actor.id;
  switch (actor.kind) {
    case 'roll': {
      if (g.inJail[id]) {
        if (g.jailCards[id].length) return { type: 'useJailCard' };
        const unowned = 28 - Object.keys(g.props).length;
        if (unowned >= 6 && g.money[id] >= 300) return { type: 'payJail' };
      }
      return tradeIdea(room, id) || manage(room, id) || { type: 'roll' };
    }
    case 'buy': {
      const sq = SQUARES[g.buy.pos];
      const left = g.money[id] - sq.price;
      if (left < 0) return { type: 'declineBuy' };
      if (completesSet(g, id, sq.pos) || left >= persona(room, id).buyReserve) return { type: 'buy' };
      return { type: 'declineBuy' };
    }
    case 'auction': {
      const a = g.auction;
      const sq = SQUARES[a.pos];
      const max = Math.min(Math.floor(valueOf(g, id, a.pos) * persona(room, id).bidFactor), g.money[id] - 20);
      const minRaise = Math.max(a.minBid, a.highBid + 1);
      if (minRaise > max) return { type: 'passBid' };
      const step = Math.max(1, Math.round(sq.price * (0.03 + rnd(room) * 0.06)));
      return { type: 'bid', amount: Math.min(max, minRaise + step - 1) };
    }
    case 'end':
      return manage(room, id) || { type: 'endTurn' };
    case 'debt':
      return decideDebt(room, id);
    case 'trade':
      return decideTrade(room, id);
    default:
      return null;
  }
}

// Sicherer Rückfall, falls eine Bot-Aktion (unerwartet) abgelehnt wird.
function fallback(actor) {
  switch (actor.kind) {
    case 'roll': return { type: 'roll' };
    case 'buy': return { type: 'declineBuy' };
    case 'auction': return { type: 'passBid' };
    case 'end': return { type: 'endTurn' };
    case 'debt': return { type: 'resign' };
    case 'trade': return { type: 'cancelTrade' };
    default: return null;
  }
}

// Führt eine Aktion für `actor` ({ id, kind }) aus. Gibt true zurück, wenn etwas passiert ist.
function botAct(room, actor) {
  const action = decide(room, actor);
  if (!action) return false;
  let res = E.act(room, actor.id, action);
  if (!res.ok) {
    const fb = fallback(actor);
    if (!fb) return false;
    res = E.act(room, actor.id, fb);
  }
  return res.ok;
}

// Zug-Timer: Für Menschen, die zu lange brauchen. Bewusst vorsichtig - würfeln,
// nichts kaufen, nicht mitbieten, Zug beenden, Schulden nur durch Verkauf/Beleihen.
function autoAct(room, actor) {
  const g = room.g;
  const id = actor.id;
  let action = null;
  switch (actor.kind) {
    case 'roll': action = g.inJail[id] && g.jailCards[id].length ? { type: 'useJailCard' } : { type: 'roll' }; break;
    case 'buy': action = { type: 'declineBuy' }; break;
    case 'auction': action = { type: 'passBid' }; break;
    case 'end': action = { type: 'endTurn' }; break;
    case 'debt': action = decideDebt(room, id); break;
    case 'trade': action = { type: 'cancelTrade' }; break;
    default: return false;
  }
  let res = E.act(room, id, action);
  if (!res.ok) { const fb = fallback(actor); if (fb) res = E.act(room, id, fb); }
  return res.ok;
}

module.exports = { botAct, autoAct, decide, PERSONAS, suggestTrade };
