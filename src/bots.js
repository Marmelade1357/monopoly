// Einfache Bot-KI für Monopoly. Ein Aufruf von botAct() führt genau EINE
// Aktion aus; der Server ruft danach (mit kurzer Verzögerung) erneut auf,
// bis die Person/der Bot nichts mehr zu tun hat.

const BOARD = require('../public/board-data.js');
const E = require('./engine.js');

const { SQUARES, GROUPS, GROUP_POSITIONS } = BOARD;

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
  const reserve = 200;
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

function decideTrade(room, id) {
  const g = room.g;
  const t = g.trade;
  const receives = t.give.cash + t.give.props.reduce((s, p) => s + valueOf(g, id, p) * (g.props[p].mortgaged ? 0.6 : 1), 0) + t.give.cards * 50;
  const gives = t.get.cash + t.get.props.reduce((s, p) => {
    const sq = SQUARES[p];
    const breaksSet = sq.group && E.ownsAllInGroup(g, id, sq.group) && sq.group !== 'utility' && sq.group !== 'station';
    return s + sq.price * (breaksSet ? 3 : 1.15);
  }, 0) + t.get.cards * 60;
  if (receives > 0 && receives >= gives * 1.15) return { type: 'acceptTrade' };
  return { type: 'cancelTrade' };
}

// Bots schlagen (nur anderen Bots) Tauschgeschäfte vor, mit denen sie ein Farbset
// vervollständigen - sonst würden reine Bot-Runden nie zu Monopolen kommen.
// Pro Zug höchstens ein Angebot; nach jedem Angebot wird das nächste großzügiger.
function tradeIdea(room, id) {
  const g = room.g;
  if (g.trade || (g.botTradeTurn && g.botTradeTurn[id] === g.turnCount)) return null;
  const botIds = new Set(room.players.filter((p) => p.isBot).map((p) => p.id));
  const groups = Object.keys(GROUP_POSITIONS).filter((k) => k !== 'station' && k !== 'utility');
  const options = [];
  for (const group of groups) {
    const positions = GROUP_POSITIONS[group];
    if (positions.some((pos) => g.props[pos] && g.props[pos].houses > 0)) continue;
    const mine = positions.filter((pos) => g.props[pos] && g.props[pos].owner === id);
    if (!mine.length || mine.length === positions.length) continue;
    positions.filter((pos) => !mine.includes(pos)).forEach((pos) => {
      const p = g.props[pos];
      if (!p || !botIds.has(p.owner) || g.bankrupt[p.owner] || p.owner === id) return;
      // Nur von Bots kaufen, die mit diesem Feld selbst keinen Satz aufbauen.
      const theirs = positions.filter((x) => g.props[x] && g.props[x].owner === p.owner).length;
      if (theirs > 1 && positions.length - mine.length > 1) return;
      options.push({ pos, owner: p.owner, mine: mine.length });
    });
  }
  options.sort((a, b) => b.mine - a.mine);
  for (const o of options) {
    g.botTradeFactor = g.botTradeFactor || {};
    const factor = g.botTradeFactor[id] || 1.5;
    const offer = Math.ceil((SQUARES[o.pos].price * factor) / 10) * 10;
    if (g.money[id] - offer < 100) continue;
    g.botTradeTurn = g.botTradeTurn || {};
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
      if (completesSet(g, id, sq.pos) || left >= 120) return { type: 'buy' };
      return { type: 'declineBuy' };
    }
    case 'auction': {
      const a = g.auction;
      const sq = SQUARES[a.pos];
      const max = Math.min(Math.floor(valueOf(g, id, a.pos) * 0.85), g.money[id] - 20);
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

module.exports = { botAct, decide };
