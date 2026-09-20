// Zug-Timer: Wer nicht reagiert, wird automatisch gespielt.

const { startServer, stopServer, connectClient, emitAsync, assert } = require('./helpers.js');

const PORT = 3459;

async function main() {
  const proc = await startServer(PORT, { BOT_DELAY_MIN_MS: '0', BOT_DELAY_MAX_MS: '5', ANIM_SCALE: '0', TIMER_SCALE: '0.04' });
  try {
    const a = await connectClient(`http://localhost:${PORT}`);
    let state = null;
    a.on('gameState', (s) => { state = s; });
    await emitAsync(a, 'createRoom', { name: 'Oualid' });
    a.emit('addBot');
    a.emit('setSettings', { turnTimer: 30, limit: 'r15', speed: 'fast' });
    await new Promise((r) => setTimeout(r, 200));
    assert(state.settings.turnTimer === 30 && state.settings.limit === 'r15' && state.settings.speed === 'fast', 'Einstellungen übernommen');
    a.emit('setSettings', { turnTimer: 7, limit: 'x99' });
    await new Promise((r) => setTimeout(r, 150));
    assert(state.settings.turnTimer === 0 && state.settings.limit === 'none', 'Ungültige Werte werden zurückgesetzt');
    a.emit('setSettings', { turnTimer: 30 });
    await new Promise((r) => setTimeout(r, 150));
    a.emit('startGame');

    // Wir tun nichts - der Timer muss für uns handeln.
    const t0 = Date.now();
    while (Date.now() - t0 < 15000 && !state.logs.some((l) => /Zeit abgelaufen/.test(l.text))) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(state.logs.some((l) => /Zeit abgelaufen/.test(l.text)), 'Timer greift ein');
    assert(state.game.turnCount >= 1, 'Spiel läuft weiter');
    a.close();
    console.log('OK: Zug-Timer und Lobby-Einstellungen.');
  } finally {
    await stopServer(proc);
  }
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
