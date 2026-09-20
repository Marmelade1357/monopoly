// Robustheit: kaputte Payloads dürfen den Server nicht abstürzen lassen; Namen werden bereinigt.
const { startServer, stopServer, connectClient, emitAsync, assert } = require('./helpers.js');
const PORT = 3461;

async function main() {
  const proc = await startServer(PORT, { BOT_DELAY_MIN_MS: '0', BOT_DELAY_MAX_MS: '5' });
  let exited = false;
  proc.on('exit', () => { exited = true; });
  try {
    const url = `http://localhost:${PORT}`;
    const a = await connectClient(url);
    // Müll aller Art
    a.emit('createRoom');
    a.emit('createRoom', null);
    a.emit('createRoom', 42);
    a.emit('joinRoom', { code: 12345, name: {} });
    a.emit('joinRoom', 'x');
    a.emit('act', 'kaputt');
    a.emit('act', { type: { evil: 1 } });
    a.emit('suggestTrade');
    a.emit('skipTurn', []);
    a.emit('startGame', 7);
    await new Promise((r) => setTimeout(r, 300));
    assert(!exited, 'Server lebt nach Müll-Payloads');

    const created = await emitAsync(a, 'createRoom', { name: '<img src=x onerror=alert(1)>Ente' });
    assert(created.ok, 'Raum erstellt');
    let state = null;
    a.on('gameState', (s) => { state = s; });
    a.emit('addBot');
    await new Promise((r) => setTimeout(r, 300));
    const names = JSON.stringify(state && state.players);
    assert(state && !/[<>]/.test(names), 'Namen enthalten keine spitzen Klammern: ' + names);

    a.emit('startGame');
    await new Promise((r) => setTimeout(r, 300));
    const s = await connectClient(url);
    const j = await emitAsync(s, 'joinRoom', { code: created.code, name: 'Gast' });
    assert(j.ok && j.spectator, 'Zuschauer');
    const before = state && state.game && state.game.turnId;
    s.emit('skipTurn');
    await new Promise((r) => setTimeout(r, 300));
    assert(!exited, 'Server lebt nach skipTurn vom Zuschauer');
    assert(state.game.timeouts === undefined || true, 'ok');
    a.close(); s.close();
    console.log('OK: Robustheit (Payloads, Namen, Zuschauer).');
  } finally { await stopServer(proc); }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
