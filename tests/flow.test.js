// Integrationstest über echte Sockets: Raum erstellen, Bots hinzufügen, Spiel
// starten, ein "Autopilot"-Mensch spielt mit, Wiederverbindung, Berechtigungen.

const { startServer, stopServer, connectClient, emitAsync, assert } = require('./helpers.js');

const PORT = 3457;

async function main() {
  const proc = await startServer(PORT, { BOT_DELAY_MIN_MS: '0', BOT_DELAY_MAX_MS: '5' });
  const url = `http://localhost:${PORT}`;
  try {
    const a = await connectClient(url);
    let state = null;
    a.on('gameState', (s) => { state = s; });

    const created = await emitAsync(a, 'createRoom', { name: 'Oualid' });
    assert(created.ok && created.code.length === 4, 'Raum erstellt');
    const myId = created.playerId;

    // Zweite Person tritt bei; doppelter Name wird abgelehnt.
    const b = await connectClient(url);
    let stateB = null;
    b.on('gameState', (s) => { stateB = s; });
    const dup = await emitAsync(b, 'joinRoom', { code: created.code, name: 'oualid' });
    assert(!dup.ok, 'Doppelter Name wird abgelehnt');
    const joined = await emitAsync(b, 'joinRoom', { code: created.code, name: 'Daisy' });
    assert(joined.ok, 'Beitritt');

    // Nur der Host darf starten.
    b.emit('startGame');
    await new Promise((r) => setTimeout(r, 150));
    assert(state.phase === 'lobby', 'Nicht-Host kann nicht starten');

    a.emit('addBot');
    a.emit('setSettings', { startMoney: 2000 });
    await new Promise((r) => setTimeout(r, 150));
    assert(state.players.length === 3 && state.players.some((p) => p.isBot), 'Bot ist im Raum');
    assert(state.settings.startMoney === 2000, 'Startgeld eingestellt');

    a.emit('startGame');
    await new Promise((r) => setTimeout(r, 150));
    assert(state.phase === 'playing' && state.game, 'Spiel läuft');
    assert(state.game.players[myId].money === 2000, 'Startgeld gilt');

    // Autopilot für beide Menschen.
    function pilot(sock, id, getState) {
      let busy = false;
      const step = async () => {
        if (busy) return;
        const s = getState();
        if (!s || s.phase !== 'playing') return;
        const g = s.game;
        let action = null;
        if (g.trade && g.trade.to === id) action = { type: 'cancelTrade' };
        else if (g.phase === 'roll' && g.turnId === id) action = { type: 'roll' };
        else if (g.phase === 'buy' && g.turnId === id) {
          action = g.players[id].money > g.buy.price + 150 ? { type: 'buy' } : { type: 'declineBuy' };
        } else if (g.phase === 'auction' && g.auction.bidderId === id) action = { type: 'passBid' };
        else if (g.phase === 'debt' && g.debts.some((d) => d.from === id)) action = { type: 'resign' };
        else if (g.phase === 'end' && g.turnId === id) action = { type: 'endTurn' };
        if (!action) return;
        busy = true;
        await emitAsync(sock, 'act', action);
        busy = false;
        await step(); // während der Aktion eingetroffene Zustände erneut prüfen
      };
      sock.on('gameState', () => { step().catch(() => { busy = false; }); });
      step();
    }
    pilot(a, myId, () => state);
    pilot(b, joined.playerId, () => stateB);
    a.emit('skipTurn'); // wirkt nicht (zu früh) - darf nichts kaputt machen

    // Wartet, bis einige Züge gespielt wurden oder das Spiel endet.
    const started = Date.now();
    while (Date.now() - started < 20000) {
      if (state.game && (state.game.turnCount >= 40 || state.game.phase === 'over')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert(state.game.turnCount >= 40 || state.game.phase === 'over', 'Mindestens 40 Züge gespielt');
    Object.values(state.game.players).forEach((p) => assert(p.money >= 0, 'Kein negatives Geld'));
    assert(state.logs.length > 0, 'Verlauf wird mitgeschickt');

    // Wiederverbindung: neuer Socket mit dem Token übernimmt den Platz.
    if (state.game.phase !== 'over') {
      const a2 = await connectClient(url);
      let state2 = null;
      a2.on('gameState', (s) => { state2 = s; });
      const re = await emitAsync(a2, 'joinRoom', { code: created.code, name: 'Oualid', token: created.token });
      assert(re.ok && re.rejoined && re.playerId === myId, 'Wiederverbindung mit Token');
      await new Promise((r) => setTimeout(r, 150));
      assert(state2 && state2.players.find((p) => p.id === myId).connected, 'Wieder als verbunden markiert');
      a2.close();
    }

    // Unbekannte Aktion / Spielfremde Person
    const c = await connectClient(url);
    const late = await emitAsync(c, 'joinRoom', { code: created.code, name: 'Spätzünder' });
    assert(!late.ok, 'Beitritt mitten im Spiel nicht möglich');
    const noRoom = await emitAsync(c, 'act', { type: 'roll' });
    assert(!noRoom.ok, 'Aktion ohne Raum wird abgelehnt');

    [a, b, c].forEach((s) => s.close());
    console.log(`OK: Socket-Ablauf (${state.game.turnCount} Züge gespielt).`);
  } finally {
    await stopServer(proc);
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
