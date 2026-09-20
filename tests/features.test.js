// Gegenangebote, Bot-Verhalten beim Handel (Gegenangebot, Nachfassen, Hinweis), Sprüche, Bestenliste/Revanche.
const E = require('../src/engine.js');
const Bots = require('../src/bots.js');
const banter = require('../src/banter.js');
const { assert, startServer, stopServer, connectClient, emitAsync } = require('./helpers.js');

function makeRoom(specs) {
  const players = specs.map((s, i) => ({ id: 'p' + i, name: s.name || 'P' + i, isBot: !!s.bot, persona: s.persona || 'balanced', connected: true }));
  const room = { players, settings: { startMoney: 1500, botLevel: 'normal' }, logs: [], phase: 'playing' };
  E.initGame(room);
  room.g.order = players.map((p) => p.id); room.g.turnIdx = 0;
  return room;
}
const own = (room, id, pos, extra) => { room.g.props[pos] = Object.assign({ owner: id, houses: 0, mortgaged: false }, extra || {}); };
const act = (room, id, a) => E.act(room, id, a);

async function main() {
  // 1. Gegenangebot (Mensch gegen Mensch)
  {
    const room = makeRoom([{}, {}]);
    const g = room.g;
    own(room, 'p0', 1); own(room, 'p1', 3);
    assert(act(room, 'p0', { type: 'proposeTrade', to: 'p1', give: { cash: 100 }, get: { props: [3] } }).ok, 'Angebot');
    assert(!act(room, 'p0', { type: 'counterTrade', give: {}, get: {} }).ok, 'Absender kann nicht gegenbieten');
    const c = act(room, 'p1', { type: 'counterTrade', give: { props: [3] }, get: { cash: 200 } });
    assert(c.ok, 'Gegenangebot: ' + c.error);
    assert(g.trade.from === 'p1' && g.trade.to === 'p0' && g.trade.counterOf, 'Gegenangebot ersetzt das Angebot');
    assert(!act(room, 'p0', { type: 'counterTrade', give: { cash: 1 }, get: {} }).ok, 'Kein Gegenangebot auf ein Gegenangebot');
    assert(act(room, 'p0', { type: 'acceptTrade' }).ok, 'Gegenangebot annehmen');
    assert(g.props[3].owner === 'p0' && g.money.p0 === 1300 && g.money.p1 === 1700, 'Gegenangebot wirkt');
  }

  // 2. Bot macht Gegenangebot statt Absage; Hinweis für das Handelsfenster
  {
    const room = makeRoom([{}, { bot: true, persona: 'careful', name: 'Klaas' }]);
    const g = room.g;
    own(room, 'p1', 3); own(room, 'p0', 1);
    // Mensch bietet zu wenig für Ententeich
    act(room, 'p0', { type: 'proposeTrade', to: 'p1', give: { cash: 40 }, get: { props: [3] } });
    const h = Bots.tradeHint(room, 'p0', 'p1', { cash: 40, props: [], cards: 0 }, { cash: 0, props: [3], cards: 0 });
    assert(h && h.level !== 'yes', 'Hinweis: 40 ₮ reichen nicht');
    const h2 = Bots.tradeHint(room, 'p0', 'p1', { cash: 200, props: [], cards: 0 }, { cash: 0, props: [3], cards: 0 });
    assert(h2 && h2.level === 'yes', 'Hinweis: 200 ₮ reichen');
    const d = Bots.decide(room, { id: 'p1', kind: 'trade' });
    assert(d.type === 'counterTrade' || d.type === 'cancelTrade', 'Bot antwortet');
    if (d.type === 'counterTrade') {
      const r = act(room, 'p1', d);
      assert(r.ok, 'Bot-Gegenangebot gültig: ' + r.error);
      assert(g.trade.get.cash > 40, 'Gegenangebot verlangt mehr Geld');
    }
  }

  // 3. Bot fasst nach einer Absage nach (höheres Angebot im selben Zug)
  {
    const room = makeRoom([{}, { bot: true, persona: 'trader', name: 'Karlo' }]);
    const g = room.g;
    own(room, 'p0', 3);
    g.turnIdx = 1; g.phase = 'roll'; g.next = 'roll';
    act(room, 'p1', { type: 'proposeTrade', to: 'p0', give: { cash: 100 }, get: { props: [3] } });
    act(room, 'p0', { type: 'cancelTrade' });
    assert(g.tradeRetry && g.tradeRetry.amount === 100, 'Nachfassen wird gemerkt');
    const idea = Bots.decide(room, { id: 'p1', kind: 'roll' });
    assert(idea.type === 'proposeTrade' && idea.give.cash > 100, 'Nachfass-Angebot ist höher: ' + JSON.stringify(idea));
  }

  // 4. Sprüche
  {
    const room = makeRoom([{}, { bot: true, persona: 'bold', name: 'Gustav' }]);
    let said = false;
    for (let i = 0; i < 50 && !said; i++) { room.g.sayAt = 0; said = banter.say(room, 'p1', 'monopoly'); }
    assert(said && room.g.say && room.g.say.text && room.logs.some((l) => l.text.includes('💬 Gustav')), 'Bot spricht');
    assert(!banter.say(room, 'p0', 'monopoly'), 'Menschen sprechen nicht');
  }

  // 5. Bestenliste und Revanche über echte Sockets
  {
    const PORT = 3462;
    const proc = await startServer(PORT, { BOT_DELAY_MIN_MS: '0', BOT_DELAY_MAX_MS: '3', ANIM_SCALE: '0' });
    try {
      const a = await connectClient(`http://localhost:${PORT}`);
      let st = null; a.on('gameState', (s) => { st = s; });
      const created = await emitAsync(a, 'createRoom', { name: 'Host' });
      a.emit('addBot'); await new Promise((r) => setTimeout(r, 100));
      a.emit('startGame'); await new Promise((r) => setTimeout(r, 300));
      const me = created.playerId;
      const t0 = Date.now();
      while (Date.now() - t0 < 25000 && !(st.game && st.game.phase === 'debt')) {
        if (st.game.turnId === me) {
          if (st.game.phase === 'roll') a.emit('act', { type: 'roll' }, () => {});
          else if (st.game.phase === 'buy') a.emit('act', { type: 'buy' }, () => {});
          else if (st.game.phase === 'end') a.emit('act', { type: 'endTurn' }, () => {});
        }
        await new Promise((r) => setTimeout(r, 40));
        if (Date.now() - t0 > 3000) break;
      }
      // Partie sofort beenden: Host gibt auf
      let res = null;
      for (let i = 0; i < 40; i++) {
        if (st.game.phase === 'auction') { a.emit('act', { type: 'passBid' }, () => {}); await new Promise((r) => setTimeout(r, 120)); continue; }
        res = await emitAsync(a, 'act', { type: 'resign' }, 8000);
        if (res && res.ok) break;
        await new Promise((r) => setTimeout(r, 120));
      }
      await new Promise((r) => setTimeout(r, 300));
      assert(st.phase === 'gameover', 'Spiel beendet nach Aufgabe: ' + JSON.stringify(res));
      if (st.phase === 'gameover') {
        assert(st.series && st.series.games === 1, 'Bestenliste zählt die Partie');
        assert(st.series.rows.some((r) => r.wins === 1), 'Ein Sieg vermerkt');
        const id1 = st.game.gameId;
        a.emit('rematch'); await new Promise((r) => setTimeout(r, 400));
        assert(st.phase === 'playing' && st.game && st.game.gameId !== id1, 'Revanche startet direkt eine neue Partie');
        assert(st.series && st.series.games === 1, 'Bestenliste bleibt erhalten');
      }
      a.close();
    } finally { await stopServer(proc); }
  }
  console.log('OK: Handel-Komfort, Sprüche, Bestenliste und Revanche.');
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
