// Der Server sperrt Aktionen, solange Würfel- und Lauf-Animationen laufen.

const { startServer, stopServer, connectClient, emitAsync, assert } = require('./helpers.js');

const PORT = 3458;

async function main() {
  const proc = await startServer(PORT, { BOT_DELAY_MIN_MS: '0', BOT_DELAY_MAX_MS: '5', ANIM_SCALE: '1' });
  try {
    const a = await connectClient(`http://localhost:${PORT}`);
    let state = null;
    a.on('gameState', (s) => { state = s; });
    const created = await emitAsync(a, 'createRoom', { name: 'Oualid' });
    a.emit('addBot');
    await new Promise((r) => setTimeout(r, 150));
    a.emit('startGame');
    await new Promise((r) => setTimeout(r, 300));
    const me = created.playerId;

    // Warten, bis wir dran sind (Bots spielen mit Animationspausen).
    const t0 = Date.now();
    while (Date.now() - t0 < 30000 && !(state.game.turnId === me && state.game.phase === 'roll')) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(state.game.turnId === me, 'Wir sind am Zug');
    await new Promise((r) => setTimeout(r, 200));
    const rolled = await emitAsync(a, 'act', { type: 'roll' });
    assert(rolled.ok, 'Würfeln klappt');
    const tEarly = Date.now();
    const early = await emitAsync(a, 'act', { type: 'endTurn' }, 15000);
    assert(Date.now() - tEarly > 500, 'Zu frühe Folgeaktion wird zurückgehalten, nicht sofort ausgeführt: ' + (Date.now() - tEarly) + ' ms');
    assert(!/unterwegs/.test(early.error || ''), 'Zu frühe Aktion wird nicht mehr abgelehnt');
    await new Promise((r) => setTimeout(r, 6000));
    const later = await emitAsync(a, 'act', { type: 'endTurn' });
    assert(later.error === undefined || !/unterwegs/.test(later.error), 'Nach der Animation nicht mehr gesperrt');
    a.close();
    console.log('OK: Animations-Sperre.');
  } finally {
    await stopServer(proc);
  }
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
