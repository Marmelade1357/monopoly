(function () {
  'use strict';

  // Ermittelt automatisch, unter welchem Pfad-Präfix diese Seite gerade läuft
  // (z.B. "" bei direktem Zugriff, "/monopoly" hinter einem gemeinsamen Hub).
  const MOUNT_PREFIX = window.location.pathname.replace(/\/[^/]*$/, '');
  const socket = io({ path: MOUNT_PREFIX + '/socket.io/' });

  const { SQUARES, GROUPS, GROUP_POSITIONS } = window.BOARD;

  if (MOUNT_PREFIX) {
    const backHub = document.getElementById('btn-back-hub-home');
    if (backHub) {
      backHub.href = '/';
      backHub.classList.remove('hidden');
    }
  }

  const SESSION_KEY = 'monopoly_session';
  const SOUND_KEY = 'monopoly_sound';
  const SKIP_MIN_WAIT_MS = 20000;

  let session = null; // { code, playerId, token, name }
  let S = null; // letzter Server-Zustand
  let stateReceivedAt = 0;
  let soundOn = safeGet(SOUND_KEY) !== 'off';

  function safeGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function safeSet(key, val) { try { localStorage.setItem(key, val); } catch (e) { /* optional */ } }
  function safeDel(key) { try { localStorage.removeItem(key); } catch (e) { /* optional */ } }

  // ---------------------------------------------------------------------
  // Sound - kurze synthetisierte Töne statt Audio-Dateien
  // ---------------------------------------------------------------------

  let audioCtx = null;
  function playTone(freq, duration, delay, volume, type) {
    if (!soundOn) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const t0 = audioCtx.currentTime + (delay || 0);
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = freq;
      osc.type = type || 'sine';
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(volume || 0.15, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0);
      osc.stop(t0 + duration + 0.02);
    } catch (e) { /* Web Audio nicht verfügbar */ }
  }
  function playDiceSound() { for (let i = 0; i < 6; i++) playTone(200 + Math.random() * 200, 0.05, i * 0.07, 0.1, 'square'); }
  function playTurnSound() { playTone(660, 0.1, 0, 0.14); playTone(880, 0.12, 0.1, 0.14); }
  function playCardSound() { playTone(440, 0.08, 0, 0.12); playTone(587, 0.12, 0.08, 0.12); }
  function playWinSound() { [523, 659, 784, 1046].forEach((f, i) => playTone(f, 0.2, i * 0.11, 0.16)); }
  function vibrate(p) { if (navigator.vibrate) { try { navigator.vibrate(p); } catch (e) { /* optional */ } } }

  // ---------------------------------------------------------------------
  // Helfer
  // ---------------------------------------------------------------------

  function $(id) { return document.getElementById(id); }
  function show(e) { e.classList.remove('hidden'); }
  function hide(e) { e.classList.add('hidden'); }
  function fmtM(n) { return Number(n).toLocaleString('de-DE') + ' ₮'; }
  // Weiche Trennstellen für lange Feldnamen (sonst werden sie auf dem Brett abgeschnitten).
  function soft(name) {
    return name.replace(/([a-zäöüß]{3,})(meister|gräber|straße|steuer|viertel|platz|allee|wiese|teich|werk)/g, '$1\u00AD$2');
  }

  function el(tag, opts, children) {
    const e = document.createElement(tag);
    if (opts) {
      Object.entries(opts).forEach(([k, v]) => {
        if (v === undefined || v === null || v === false) return;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k === 'html') e.innerHTML = v;
        else if (k === 'style') e.style.cssText = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v);
      });
    }
    (children || []).forEach((c) => { if (c) e.appendChild(c); });
    return e;
  }

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => hide(s));
    show($(id));
    if (id === 'screen-home') releaseWakeLock(); else requestWakeLock();
  }

  let wakeLock = null;
  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) { /* ignorieren */ }
  }
  function releaseWakeLock() {
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    const onHome = !$('screen-home').classList.contains('hidden');
    if (document.visibilityState === 'visible' && !onHome) requestWakeLock();
  });

  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    show(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => hide(t), 3200);
  }

  function saveSession() { safeSet(SESSION_KEY, JSON.stringify(session)); }
  function clearSession() { safeDel(SESSION_KEY); session = null; }
  function loadSession() {
    try { const raw = safeGet(SESSION_KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }

  function myId() { return session ? session.playerId : null; }
  function pinfo(id) { return S && S.players.find((p) => p.id === id); }
  function pname(id) { const p = pinfo(id); return p ? p.name : '?'; }
  function pcolor(id) { const p = pinfo(id); return p ? p.color : '#888'; }
  function isHost() { return S && S.hostId === myId(); }

  function tokdot(id, small) {
    const p = pinfo(id);
    return el('span', { class: 'tokdot' + (small ? ' sm' : ''), style: `--pc:${p ? p.color : '#888'}`, text: p ? p.emoji : '?' });
  }

  function act(action, cb) {
    socket.emit('act', action, (res) => {
      if (res && !res.ok) toast(res.error || 'Das geht gerade nicht.');
      if (cb) cb(res);
    });
  }

  function attachConfirmClick(btn, onConfirm) {
    if (!btn) return;
    const originalText = btn.textContent;
    let timer = null;
    const reset = () => { clearTimeout(timer); timer = null; btn.classList.remove('danger'); btn.textContent = originalText; };
    btn.addEventListener('click', () => {
      if (timer) { reset(); onConfirm(); return; }
      btn.classList.add('danger');
      btn.textContent = 'Sicher?';
      timer = setTimeout(reset, 3000);
    });
  }

  // ---------------------------------------------------------------------
  // Startseite
  // ---------------------------------------------------------------------

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach((p) => hide(p));
      show($('tab-' + btn.dataset.tab));
    });
  });

  // Einladungslink: ?code=AB12 füllt den Beitritts-Tab vor.
  (function prefillFromLink() {
    const code = new URLSearchParams(window.location.search).get('code');
    if (!code) return;
    $('join-code').value = code.toUpperCase().slice(0, 4);
    document.querySelector('.tab-btn[data-tab="join"]').click();
  })();

  const savedName = safeGet('monopoly_name');
  if (savedName) { $('create-name').value = savedName; $('join-name').value = savedName; }

  $('btn-create').addEventListener('click', () => {
    const name = $('create-name').value.trim();
    if (!name) return toast('Bitte gib deinen Namen ein.');
    safeSet('monopoly_name', name);
    socket.emit('createRoom', { name }, (res) => {
      if (!res.ok) return toast(res.error || 'Fehler beim Erstellen.');
      session = { code: res.code, playerId: res.playerId, token: res.token, name };
      saveSession();
    });
  });

  $('btn-join').addEventListener('click', () => {
    const name = $('join-name').value.trim();
    const code = $('join-code').value.trim().toUpperCase();
    if (!name) return toast('Bitte gib deinen Namen ein.');
    if (!code) return toast('Bitte gib den Raum-Code ein.');
    safeSet('monopoly_name', name);
    socket.emit('joinRoom', { code, name }, (res) => {
      if (!res.ok) return toast(res.error || 'Beitritt fehlgeschlagen.');
      session = { code: res.code, playerId: res.playerId, token: res.token, name };
      saveSession();
    });
  });

  function leaveToHome() {
    socket.emit('leaveRoom');
    clearSession();
    S = null;
    closeAllModals();
    showScreen('screen-home');
  }
  attachConfirmClick($('btn-leave-lobby'), leaveToHome);
  attachConfirmClick($('btn-leave-game'), leaveToHome);

  function updateSoundButton() { $('btn-toggle-sound').textContent = soundOn ? '🔊' : '🔇'; }
  updateSoundButton();
  $('btn-toggle-sound').addEventListener('click', () => {
    soundOn = !soundOn;
    safeSet(SOUND_KEY, soundOn ? 'on' : 'off');
    updateSoundButton();
  });

  // Modals schließen
  document.querySelectorAll('[data-close]').forEach((b) => {
    b.addEventListener('click', () => hide($(b.dataset.close)));
  });
  document.querySelectorAll('.modal').forEach((m) => {
    m.addEventListener('mousedown', (e) => {
      if (e.target === m && m.id !== 'trade-in-modal' && m.id !== 'over-modal') hide(m);
    });
  });
  function closeAllModals() {
    document.querySelectorAll('.modal').forEach((m) => hide(m));
    propModalPos = null;
  }

  $('btn-show-rules').addEventListener('click', () => show($('rules-modal')));
  $('btn-show-rules-lobby').addEventListener('click', () => show($('rules-modal')));
  $('btn-show-log').addEventListener('click', () => { renderLogModal(); show($('log-modal')); });

  // ---------------------------------------------------------------------
  // Lobby
  // ---------------------------------------------------------------------

  $('btn-add-bot').addEventListener('click', () => socket.emit('addBot'));
  $('btn-fill-bots').addEventListener('click', () => socket.emit('fillBots'));
  $('btn-start').addEventListener('click', () => socket.emit('startGame'));
  [['set-timer', 'turnTimer'], ['set-limit', 'limit'], ['set-speed', 'speed']].forEach(([id, key]) => {
    $(id).addEventListener('change', () => socket.emit('setSettings', { [key]: $(id).value }));
  });
  document.querySelectorAll('#lobby-rules input[data-rule]').forEach((cb) => {
    cb.addEventListener('change', () => socket.emit('setSettings', { rules: { [cb.dataset.rule]: cb.checked } }));
  });
  $('input-money').addEventListener('change', () => socket.emit('setSettings', { startMoney: $('input-money').value }));

  $('btn-share-link').addEventListener('click', async () => {
    if (!S) return;
    const url = window.location.origin + window.location.pathname + '?code=' + S.code;
    try {
      await navigator.clipboard.writeText(url);
      toast('Einladungslink kopiert!');
    } catch (e) {
      window.prompt('Einladungslink:', url);
    }
  });

  function renderLobby(s) {
    $('lobby-code').textContent = s.code;
    $('lobby-count').textContent = s.players.length;
    const list = $('lobby-players');
    list.innerHTML = '';
    s.players.forEach((p) => {
      const li = el('li', { class: p.connected ? '' : 'disconnected' });
      const name = el('span', { class: 'player-name' }, [
        el('span', { class: 'tokdot', style: `--pc:${p.color}`, text: p.emoji }),
        el('span', { text: p.name }),
      ]);
      if (p.isHost) name.appendChild(el('span', { class: 'tag host', text: 'Host' }));
      if (p.isBot) name.appendChild(el('span', { class: 'tag bot', text: 'Bot' }));
      if (p.isBot && p.persona) name.appendChild(el('span', { class: 'tag persona', text: { careful: '🧐 vorsichtig', bold: '🔥 mutig', trader: '🤝 Händler' }[p.persona] || p.persona }));
      if (!p.connected && !p.isBot) name.appendChild(el('span', { class: 'tag', text: 'offline' }));
      li.appendChild(name);
      if (isHost() && !p.isHost) {
        const btn = el('button', { class: 'remove-bot-btn', title: 'Entfernen', text: '✕' });
        let timer = null;
        btn.addEventListener('click', () => {
          if (timer) { clearTimeout(timer); socket.emit(p.isBot ? 'removeBot' : 'kickPlayer', p.isBot ? { botId: p.id } : { playerId: p.id }); return; }
          btn.classList.add('confirm'); btn.textContent = 'Entfernen?';
          timer = setTimeout(() => { timer = null; btn.classList.remove('confirm'); btn.textContent = '✕'; }, 3000);
        });
        li.appendChild(btn);
      }
      list.appendChild(li);
    });

    const host = isHost();
    $('lobby-bot-controls').classList.toggle('hidden', !host);
    $('btn-add-bot').classList.toggle('hidden', s.players.length >= s.maxPlayers);
    $('btn-fill-bots').classList.toggle('hidden', s.players.length >= s.minPlayers);
    $('lobby-settings').classList.toggle('hidden', !host);
    $('lobby-settings-display').classList.toggle('hidden', host);
    if (document.activeElement !== $('input-money')) $('input-money').value = s.settings.startMoney;
    $('lobby-settings-display').textContent = `Startkapital: ${fmtM(s.settings.startMoney)}`;
    [['set-timer', 'turnTimer'], ['set-limit', 'limit'], ['set-speed', 'speed']].forEach(([id, key]) => {
      const sel = $(id);
      if (document.activeElement !== sel) sel.value = String(s.settings[key] === undefined ? '' : s.settings[key]);
      sel.disabled = !host;
    });
    document.querySelectorAll('#lobby-rules input[data-rule]').forEach((cb) => {
      cb.checked = !!(s.settings.rules && s.settings.rules[cb.dataset.rule]);
      cb.disabled = !host;
      cb.closest('.rule-item').classList.toggle('locked', !host);
    });
    const enough = s.players.length >= s.minPlayers;
    $('btn-start').classList.toggle('hidden', !host);
    $('btn-start').disabled = !enough;
    $('lobby-status').textContent = !enough
      ? `Mindestens ${s.minPlayers} Spieler nötig (Bots zählen mit).`
      : host ? 'Alles bereit – starte, wenn alle da sind.' : 'Warte, bis der Host das Spiel startet …';
  }

  // ---------------------------------------------------------------------
  // Spielbrett
  // ---------------------------------------------------------------------

  const LIGHT_BANDS = { lightblue: true, yellow: true };
  const SQ_ICONS = { station: '🚂', tax: '💸', chance: '🔮', community: '🐤', jail: '🚔', parking: '🅿️', gotojail: '👮', go: '➡️' };

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
  function sideOf(pos) {
    if (pos % 10 === 0) return 'corner';
    if (pos < 10) return 'bottom';
    if (pos < 20) return 'left';
    if (pos < 30) return 'top';
    return 'right';
  }

  const sqEls = {};
  let diceEls = null;
  let statusEl = null;
  let auctionEl = null;
  let cardSlot = null;

  function pipsFor(n) {
    const map = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
    const on = map[n] || [];
    const cells = [];
    for (let i = 0; i < 9; i++) cells.push(el('span', { class: on.includes(i) ? 'pip' : '' }));
    return cells;
  }
  function setDie(dieEl, n) {
    dieEl.innerHTML = '';
    pipsFor(n).forEach((c) => dieEl.appendChild(c));
  }

  function buildBoard() {
    const board = $('board');
    board.innerHTML = '';
    SQUARES.forEach((sq) => {
      const side = sideOf(sq.pos);
      const div = el('div', { class: `sq t-${sq.type} ${side === 'corner' ? 'corner' : 'side-' + side}`, 'data-pos': sq.pos });
      const [r, c] = gridPos(sq.pos);
      div.style.gridRow = r;
      div.style.gridColumn = c;

      if (sq.type === 'property') {
        div.appendChild(el('div', { class: 'band', style: `--band:${GROUPS[sq.group].color}` }));
        div.appendChild(el('div', { class: 'sq-body' }, [
          el('div', { class: 'sq-name', text: soft(sq.name) }),
          el('div', { class: 'sq-price', text: sq.price + ' ₮' }),
        ]));
      } else if (sq.type === 'station' || sq.type === 'utility') {
        div.appendChild(el('div', { class: 'sq-body' }, [
          el('div', { class: 'sq-icon', text: sq.icon || SQ_ICONS.station }),
          el('div', { class: 'sq-name', text: soft(sq.name) }),
          el('div', { class: 'sq-price', text: sq.price + ' ₮' }),
        ]));
      } else {
        let sub = '';
        if (sq.type === 'tax') sub = 'zahle ' + sq.amount + ' ₮';
        if (sq.type === 'go') sub = 'Ziehe 200 ₮ ein';
        if (sq.type === 'jail') sub = 'nur zu Besuch';
        if (sq.type === 'parking') sub = 'Kleine Pause';
        div.appendChild(el('div', { class: 'sq-body' }, [
          el('div', { class: 'sq-icon', text: SQ_ICONS[sq.type] || '' }),
          el('div', { class: 'sq-name', text: soft(sq.name) }),
          sub ? el('div', { class: 'sq-price' + (sq.type === 'parking' ? ' sq-parking' : ''), text: sub }) : null,
        ]));
      }
      div.appendChild(el('div', { class: 'tokens' }));
      div.addEventListener('click', () => {
        if (sq.type === 'property' || sq.type === 'station' || sq.type === 'utility') openProp(sq.pos);
      });
      sqEls[sq.pos] = div;
      board.appendChild(div);
    });

    // Mitte: Logo, Kartenstapel, Würfel, Status
    const dieA = el('div', { class: 'die' });
    const dieB = el('div', { class: 'die' });
    setDie(dieA, 1); setDie(dieB, 1);
    diceEls = [dieA, dieB];
    statusEl = el('div', { class: 'status-box' });
    auctionEl = el('div', { class: 'auction-panel hidden' });
    cardSlot = el('div', {});
    const center = el('div', { class: 'board-center' }, [
      el('div', { class: 'deck community' }, [el('div', { class: 'di', text: '🐤' }), el('div', { text: 'Tick, Trick & Track' })]),
      el('div', { class: 'deck chance' }, [el('div', { class: 'di', text: '🔮' }), el('div', { text: 'Gundels Zauberei' })]),
      el('div', { class: 'logo' }, [el('div', { class: 'l1', text: 'MONOPOLY' }), el('div', { class: 'l2', text: 'Entenhausen' })]),
      el('div', { class: 'dice-row' }, [dieA, dieB]),
      statusEl,
      auctionEl,
      cardSlot,
    ]);
    board.appendChild(center);
  }

  // --- Figuren & Bewegungs-Animation ---

  const shownPos = {};
  let hopId = null;
  const animTimers = {};

  function renderTokens() {
    if (!S || !S.game) return;
    const g = S.game;
    Object.values(sqEls).forEach((sqEl) => { sqEl.querySelector('.tokens').innerHTML = ''; });
    g.order.forEach((id) => {
      if (g.players[id].bankrupt) return;
      const pos = shownPos[id] !== undefined ? shownPos[id] : g.players[id].pos;
      const holder = sqEls[pos].querySelector('.tokens');
      const p = pinfo(id);
      holder.appendChild(el('span', {
        class: 'tk' + (hopId === id ? ' hop' : '') + (g.turnId === id && g.phase !== 'over' ? ' turn' : '') + (g.players[id].inJail && pos === 10 ? ' jailed' : ''),
        style: `--pc:${p ? p.color : '#888'}`,
        title: p ? p.name : '',
        text: p ? p.emoji : '?',
      }));
    });
  }

  // Solange Würfel rollen oder Figuren laufen, werden Aktionen im Dock zurückgehalten.
  let busyUntilDice = 0;
  const walking = new Set();
  function isBusy() { return Date.now() < busyUntilDice || walking.size > 0; }
  function whenIdle(fn) {
    const t = setInterval(() => { if (!isBusy()) { clearInterval(t); fn(); } }, 80);
  }
  function refreshAfterIdle() {
    whenIdle(() => { if (S && S.game) { dockKey = ''; renderDockActions(S); } });
  }

  // Bewegungen werden der Reihe nach gezeigt: Figur läuft Feld für Feld, dann
  // erscheint ggf. die Karte, bei "Geh in den Knast" fallen Gitter und erst dann
  // wird die Figur in den Knast gesetzt.
  const moveQueue = [];
  let lastMoveSeq = null;
  let queueRunning = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Tempo-Regel: im Schnell-Modus laufen alle Animationen schneller.
  function T(ms) { return ms * (S && S.settings && S.settings.speed === 'fast' ? 0.55 : 1); }

  function snapTokens() {
    if (!S || !S.game) return;
    S.game.order.forEach((id) => { shownPos[id] = S.game.players[id].pos; });
    renderTokens();
  }

  function playJailSound() { [220, 165, 110].forEach((f, i) => playTone(f, 0.18, i * 0.16, 0.2, 'square')); }

  async function jailAnimation(id) {
    const board = $('board');
    const wrap = el('div', { class: 'jail-anim', style: 'position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:30' }, [
      el('div', { class: 'jail-bars' }, Array.from({ length: 9 }, (_, i) => el('i', { style: `--i:${i}` }))),
      el('div', { class: 'jail-text' }, [el('div', { class: 'jail-ico', text: '🚔' }), el('div', { text: `${pname(id)} geht in den Knast!` })]),
    ]);
    board.appendChild(wrap);
    playJailSound();
    await sleep(T(1300));
    shownPos[id] = 10;
    renderTokens();
    await sleep(T(1100));
    wrap.classList.add('out');
    await sleep(400);
    wrap.remove();
  }

  async function walk(id, from, to, dir) {
    const dist = dir === 1 ? (to - from + 40) % 40 : (from - to + 40) % 40;
    shownPos[id] = from;
    if (dist === 0 || dist > 16) { shownPos[id] = to; renderTokens(); await sleep(T(250)); return; }
    renderTokens();
    while (shownPos[id] !== to) {
      await sleep(T(230));
      shownPos[id] = (shownPos[id] + dir + 40) % 40;
      hopId = id;
      renderTokens();
      playTone(300 + (shownPos[id] % 10) * 20, 0.05, 0, 0.06, 'triangle');
    }
    await sleep(T(350));
    hopId = null;
    renderTokens();
  }

  async function runQueue() {
    queueRunning = true;
    walking.add('queue');
    try {
      while (moveQueue.length) {
        const m = moveQueue.shift();
        await sleep(Math.max(0, busyUntilDice - Date.now()));
        const g = S && S.game;
        if (g && g.lastCard && m.card === g.lastCard.seq && m.card !== shownCardSeq) {
          updateCard(g);
          await sleep(T(m.kind === 'jail' ? 2600 : 1900));
        }
        if (m.kind === 'jail') await jailAnimation(m.id);
        else await walk(m.id, m.from, m.to, m.kind === 'back' ? -1 : 1);
      }
    } finally {
      walking.delete('queue');
      queueRunning = false;
      snapTokens();
      refreshAfterIdle();
    }
  }

  function syncPositions(g) {
    const ms = g.moves || [];
    const max = ms.length ? ms[ms.length - 1].seq : 0;
    if (lastMoveSeq === null) {
      lastMoveSeq = max;
      snapTokens();
      return;
    }
    const fresh = ms.filter((m) => m.seq > lastMoveSeq);
    if (fresh.length) {
      fresh.forEach((m) => moveQueue.push(m));
      lastMoveSeq = max;
    }
    if (!queueRunning) {
      if (moveQueue.length) runQueue();
      else if (g.order.some((id) => shownPos[id] !== g.players[id].pos)) snapTokens();
    }
    refreshAfterIdle();
  }

  // --- Besitz, Gebäude ---

  let boardOwnersInit = false;
  function updateBoardOwnership(g) {
    const byPos = {};
    g.props.forEach((p) => { byPos[p.pos] = p; });
    SQUARES.forEach((sq) => {
      if (sq.type !== 'property' && sq.type !== 'station' && sq.type !== 'utility') return;
      const div = sqEls[sq.pos];
      const p = byPos[sq.pos];
      const prevOwner = div.dataset.owner || '';
      const nowOwner = p ? p.owner : '';
      if (nowOwner && prevOwner !== nowOwner && prevOwner !== undefined && boardOwnersInit) {
        div.classList.remove('claimed'); void div.offsetWidth; div.classList.add('claimed');
        setTimeout(() => div.classList.remove('claimed'), 1500);
      }
      div.dataset.owner = nowOwner;
      div.classList.toggle('owned', !!p);
      div.classList.toggle('mortgaged', !!(p && p.mortgaged));
      if (p) div.style.setProperty('--own', pcolor(p.owner)); else div.style.removeProperty('--own');
      if (sq.type === 'property') {
        const band = div.querySelector('.band');
        const key = p ? p.houses + (p.mortgaged ? 'm' : '') : '';
        if (band.dataset.k !== key) {
          const oldH = Number(band.dataset.h || 0);
          band.dataset.k = key;
          band.dataset.h = p ? p.houses : 0;
          band.innerHTML = '';
          if (p && p.houses === 5) band.appendChild(el('span', { class: 'hotel' }));
          else if (p) for (let i = 0; i < p.houses; i++) band.appendChild(el('span', { class: 'house' }));
          if (p && p.mortgaged) band.appendChild(el('span', { class: 'mort', text: 'H' }));
          if (p && p.houses > oldH && boardOwnersInit) { const nb = band.querySelector('.house:last-of-type, .hotel'); if (nb) nb.classList.add('pop'); playTone(520, 0.06, 0, 0.1, 'square'); }
        }
      }
    });
    boardOwnersInit = true;
  }

  // --- Würfel ---

  let lastRollSeq = null;
  let rollTimer = null;
  function updateDice(g) {
    if (lastRollSeq === null) {
      lastRollSeq = g.rollSeq;
      if (g.rollSeq > 0) { setDie(diceEls[0], g.dice[0]); setDie(diceEls[1], g.dice[1]); }
      return;
    }
    if (g.rollSeq !== lastRollSeq) {
      lastRollSeq = g.rollSeq;
      playDiceSound();
      busyUntilDice = Date.now() + T(1300);
      diceEls.forEach((d) => d.classList.add('rolling'));
      clearInterval(rollTimer);
      let n = 0;
      rollTimer = setInterval(() => {
        n++;
        if (n < 12) {
          setDie(diceEls[0], 1 + Math.floor(Math.random() * 6));
          setDie(diceEls[1], 1 + Math.floor(Math.random() * 6));
        } else {
          clearInterval(rollTimer);
          diceEls.forEach((d) => d.classList.remove('rolling'));
          setDie(diceEls[0], S.game.dice[0]);
          setDie(diceEls[1], S.game.dice[1]);
          if (S.game.dice[0] === S.game.dice[1]) splash('PASCH!', 'pasch', 1300);
        }
      }, T(90));
    }
  }

  // --- Statusbox & Karte ---

  function sqName(pos) { return SQUARES[pos].name; }

  // Kurzer Hinweis, was ein Kauf strategisch bedeutet.
  function buyHint(g, pos, buyer) {
    const sq = SQUARES[pos];
    const ps = GROUP_POSITIONS[sq.group] || [];
    const ownerOf = (x) => { const q = g.props.find((p) => p.pos === x); return q ? q.owner : null; };
    const others = ps.filter((x) => x !== pos);
    const mine = others.filter((x) => ownerOf(x) === buyer).length;
    if (sq.type === 'property') {
      if (mine === others.length) return '🎉 Damit gehört dir die ganze Farbe – du kannst bauen!';
      const foreign = others.map(ownerOf);
      const single = foreign.length && foreign.every((o) => o && o !== buyer && o === foreign[0]);
      if (single) return `🛡 Kaufen verhindert, dass ${pname(foreign[0])} die ganze Farbe bekommt.`;
      if (mine > 0) return `👍 ${mine + 1} von ${ps.length} Straßen dieser Farbe wären deine.`;
      return `${ps.length} Straßen in dieser Farbe – du hättest 1.`;
    }
    const n = others.filter((x) => ownerOf(x) === buyer).length;
    return sq.type === 'station' ? `🚂 Damit besitzt du ${n + 1} von 4 Bahnhöfen (mehr = höhere Miete).` : `Werke: mit beiden zahlen Gegner 10 × Augenzahl.`;
  }

  function statusFor(s) {
    const g = s.game;
    const cur = pname(g.turnId);
    if (g.phase === 'over') return { t: g.winner ? `🏆 ${pname(g.winner)} gewinnt!` : 'Spiel beendet' };
    switch (g.phase) {
      case 'roll':
        return { t: `${cur} ist am Zug`, sub: g.players[g.turnId].inJail ? 'sitzt im Knast' : (g.doubles ? 'darf nach dem Pasch noch einmal würfeln' : 'würfelt gleich …') };
      case 'buy':
        return { t: `${cur} überlegt`, sub: `${sqName(g.buy.pos)} für ${fmtM(g.buy.price)} zu kaufen`, hint: buyHint(g, g.buy.pos, g.turnId) };
      case 'auction': {
        const a = g.auction;
        return { t: `🔨 Auktion: ${sqName(a.pos)}`, sub: a.highBidder ? `Höchstgebot ${fmtM(a.highBid)} von ${pname(a.highBidder)} · ${pname(a.bidderId)} ist dran` : `Noch kein Gebot · ${pname(a.bidderId)} ist dran` };
      }
      case 'debt': {
        const d = g.debts[0];
        return { t: `${pname(d.from)} kann nicht zahlen`, sub: `${fmtM(g.players[d.from].debt)} offen – Geld beschaffen oder aufgeben` };
      }
      case 'end':
        return { t: `${cur} ist fertig`, sub: 'beendet gleich den Zug' };
      default:
        return { t: '' };
    }
  }

  let shownCardSeq = null;
  let cardTimer = null;
  function updateCard(g) {
    if (shownCardSeq === null) { shownCardSeq = g.lastCard ? g.lastCard.seq : 0; return; }
    if (g.lastCard && g.lastCard.seq !== shownCardSeq) {
      shownCardSeq = g.lastCard.seq;
      playCardSound();
      const c = g.lastCard;
      cardSlot.innerHTML = '';
      const card = el('div', { class: `center-card ${c.deck}` }, [
        el('div', { class: 'cc-title', text: c.label }),
        el('div', { class: 'cc-text', text: c.text }),
        el('div', { class: 'cc-who', text: `gezogen von ${pname(c.playerId)} – zum Schließen antippen` }),
      ]);
      card.addEventListener('click', () => { cardSlot.innerHTML = ''; clearTimeout(cardTimer); });
      cardSlot.appendChild(card);
      clearTimeout(cardTimer);
      cardTimer = setTimeout(() => { cardSlot.innerHTML = ''; }, 6500);
    }
  }

  // ---------------------------------------------------------------------
  // Spielerliste, Ereignisse
  // ---------------------------------------------------------------------

  function renderPlayersPanel(s) {
    const g = s.game;
    const panel = $('players-panel');
    panel.innerHTML = '';
    g.order.forEach((id) => {
      const gp = g.players[id];
      const info = pinfo(id);
      const owned = g.props.filter((p) => p.owner === id).length;
      const sub = [];
      sub.push(`${owned} Grundstück${owned === 1 ? '' : 'e'}`);
      if (gp.inJail) sub.push('🚔 Knast');
      if (gp.jailCards) sub.push(`🔑×${gp.jailCards}`);
      if (info && info.isBot) sub.push('Bot');
      if (info && !info.isBot && !info.connected) sub.push('offline');
      const row = el('div', {
        class: 'pp-row' + (g.turnId === id && g.phase !== 'over' ? ' turn' : '') + (id === myId() ? ' me' : '') + (gp.bankrupt ? ' bankrupt' : '') + (info && !info.isBot && !info.connected ? ' offline' : ''),
        style: `--pc:${info ? info.color : '#888'}`,
      }, [
        tokdot(id),
        el('div', {}, [el('div', { class: 'pp-name', text: pname(id) }), el('div', { class: 'pp-sub', text: gp.bankrupt ? 'pleite' : sub.join(' · ') })]),
        el('div', { class: 'pp-money', 'data-mid': id, text: gp.bankrupt ? '–' : fmtM(moneyShown(id, gp.money)) }),
      ]);
      const chips = el('div', { class: 'pp-props' });
      if (!gp.bankrupt) {
        Object.keys(GROUPS).forEach((gr) => {
          const ps = g.props.filter((p) => p.owner === id && SQUARES[p.pos].group === gr).sort((a, b) => a.pos - b.pos);
          if (!ps.length) return;
          const grp = el('div', { class: 'pp-grp' });
          ps.forEach((p) => {
            const chip = el('div', {
              class: 'pp-chip' + (p.mortgaged ? ' mortgaged' : '') + (gr === 'lightblue' || gr === 'yellow' ? ' light' : ''),
              style: `--band:${GROUPS[gr].color}`,
              title: SQUARES[p.pos].name + (p.houses === 5 ? ' (Hotel)' : p.houses ? ` (${p.houses} Häuser)` : '') + (p.mortgaged ? ' – beliehen' : ''),
              text: p.houses === 5 ? 'H' : p.houses ? String(p.houses) : '',
            });
            chip.addEventListener('click', (e) => { e.stopPropagation(); openProp(p.pos); });
            grp.appendChild(chip);
          });
          chips.appendChild(grp);
        });
        if (!chips.children.length) chips.appendChild(el('span', { class: 'pp-none', text: 'noch kein Besitz' }));
      }
      row.appendChild(chips);
      row.addEventListener('click', () => openPlayer(id));
      panel.appendChild(row);
    });
  }

  let feedFirst = null;
  function renderFeed(s) {
    if (isBusy()) { whenIdle(() => { if (S && S.game) renderFeed(S); }); return; }
    const feed = $('event-feed');
    feed.innerHTML = '';
    const items = s.logs.slice(-6).reverse();
    const known = feedFirst;
    items.forEach((l, i) => feed.appendChild(el('li', { text: l.text, class: known !== null && i === 0 && l.text !== known ? 'fresh' : '' })));
    feedFirst = items.length ? items[0].text : '';
  }

  function renderLogModal() {
    const list = $('log-list');
    list.innerHTML = '';
    if (!S) return;
    S.logs.forEach((l) => list.appendChild(el('li', { text: l.text })));
  }

  // ---------------------------------------------------------------------
  // Grundstückskarten
  // ---------------------------------------------------------------------

  function propOf(pos) { return S.game.props.find((p) => p.pos === pos); }

  function ownsFullGroup(id, group) {
    return GROUP_POSITIONS[group].every((pos) => { const p = propOf(pos); return p && p.owner === id; });
  }

  function propCard(pos, opts) {
    opts = opts || {};
    const sq = SQUARES[pos];
    const p = propOf(pos);
    const band = el('div', { class: 'pc-band', style: `--band:${GROUPS[sq.group].color}` });
    if (sq.type === 'station') band.appendChild(el('span', { class: 'pc-icon', text: '🚂' }));
    if (sq.type === 'utility') band.appendChild(el('span', { class: 'pc-icon', text: sq.icon }));
    if (p && p.houses === 5) band.appendChild(el('span', { class: 'hotel' }));
    else if (p) for (let i = 0; i < p.houses; i++) band.appendChild(el('span', { class: 'house' }));
    const meta = sq.type === 'property' && p && p.houses ? `Miete ${sq.rent[p.houses]} ₮` : `${sq.price} ₮`;
    const card = el('div', {
      class: 'pc' + (opts.small ? ' small' : '') + (p && p.mortgaged ? ' mortgaged' : '') + (opts.mono ? ' mono' : '') + (opts.cls ? ' ' + opts.cls : ''),
      title: sq.name,
    }, [band, el('div', { class: 'pc-name', text: soft(sq.name) }), el('div', { class: 'pc-meta', text: meta })]);
    if (opts.onclick) card.addEventListener('click', opts.onclick);
    return card;
  }

  // ---------------------------------------------------------------------
  // Dock: eigenes Geld, Aktionen, eigene Grundstücke
  // ---------------------------------------------------------------------

  let dockKey = '';
  let bidDraft = null;

  function myProps(g) {
    return g.props.filter((p) => p.owner === myId()).map((p) => p.pos).sort((a, b) => a - b);
  }

  function renderDockMe(s) {
    const g = s.game;
    const me = g.players[myId()];
    const box = $('dock-me');
    box.innerHTML = '';
    if (!me) return;
    box.appendChild(tokdot(myId()));
    const info = [
      el('div', { class: 'who', text: pname(myId()) }),
      el('div', { class: 'dock-money' }, [
        me.bankrupt ? document.createTextNode('Pleite') : el('span', { 'data-mid': myId(), text: fmtM(moneyShown(myId(), me.money)) }),
        el('small', { text: me.bankrupt ? 'du bist ausgeschieden' : `Vermögen ${fmtM(me.netWorth)}${me.jailCards ? ` · 🔑 ${me.jailCards} Freikarte${me.jailCards > 1 ? 'n' : ''}` : ''}${me.inJail ? ' · 🚔 im Knast' : ''}` }),
      ]),
    ];
    info.forEach((i) => box.appendChild(i));
  }

  function renderDockProps(s) {
    const g = s.game;
    const list = $('dock-props');
    list.innerHTML = '';
    const mine = myProps(g);
    $('dock-props-title').textContent = `Meine Grundstücke (${mine.length})`;
    if (!mine.length) {
      list.appendChild(el('div', { class: 'empty', text: 'Noch keine Grundstücke – kaufe oder ersteigere welche!' }));
      return;
    }
    Object.keys(GROUPS).forEach((gr) => {
      const inGroup = mine.filter((pos) => SQUARES[pos].group === gr);
      if (!inGroup.length) return;
      const total = SQUARES.filter((q) => q.group === gr).length;
      const cards = el('div', { class: 'grp-cards' });
      inGroup.forEach((pos) => {
        const sq = SQUARES[pos];
        const mono = sq.type === 'property' && ownsFullGroup(myId(), sq.group);
        cards.appendChild(propCard(pos, { mono, onclick: () => openProp(pos) }));
      });
      list.appendChild(el('div', { class: 'grp-row', title: `${GROUPS[gr].name}: ${inGroup.length}/${total}` }, [
        el('div', { class: 'grp-bar', style: `--band:${GROUPS[gr].color}` }), cards,
      ]));
    });
  }

  function bidButtons(a, myMoney) {
    const minRaise = Math.max(a.minBid, a.highBid + 1);
    const opts = [];
    const add = (v) => { if (v >= minRaise && v <= myMoney && !opts.includes(v)) opts.push(v); };
    add(minRaise);
    add(a.highBid + 10);
    add(a.highBid + 50);
    add(a.highBid + 100);
    return { minRaise, opts };
  }

  function renderDockActions(s) {
    const g = s.game;
    const id = myId();
    const me = g.players[id];
    const box = $('dock-actions');
    const waited = s.wait ? s.wait.elapsedMs + (Date.now() - stateReceivedAt) : 0;
    const canSkip = !!(s.wait && isHost() && !s.wait.ids.includes(id) && waited >= SKIP_MIN_WAIT_MS);
    if (isBusy()) {
      box.innerHTML = '';
      box.appendChild(el('span', { class: 'msg', text: '🎲 …' }));
      dockKey = '';
      refreshAfterIdle();
      return;
    }
    const key = JSON.stringify([g.phase, g.turnId, g.buy, g.auction, g.debts.length, me && me.money, me && me.inJail, me && me.jailCards, me && me.bankrupt, g.trade && g.trade.id, canSkip, g.doubles]);
    if (key === dockKey) return;
    dockKey = key;
    box.innerHTML = '';
    $('dock').classList.toggle('my-turn', g.turnId === id && g.phase !== 'over' && !(me && me.bankrupt));
    if (!me || me.bankrupt) { box.appendChild(el('span', { class: 'msg', text: 'Du schaust jetzt nur noch zu.' })); return; }
    if (g.phase === 'over') return;

    const msg = (html) => box.appendChild(el('span', { class: 'msg', html }));
    const btn = (label, cls, fn, disabled) => {
      const b = el('button', { class: 'btn ' + (cls || ''), text: label });
      if (disabled) b.disabled = true;
      b.addEventListener('click', fn);
      box.appendChild(b);
      return b;
    };
    const mineTurn = g.turnId === id;

    if (g.phase === 'roll' && mineTurn) {
      if (me.inJail) {
        msg('🚔 <b>Du sitzt im Knast.</b>');
        if (me.jailCards) btn('🔑 Freikarte nutzen', 'good', () => act({ type: 'useJailCard' }));
        btn('50 ₮ Kaution zahlen', '', () => act({ type: 'payJail' }), me.money < 50);
        btn('🎲 Pasch versuchen', 'secondary', () => act({ type: 'roll' }));
      } else {
        btn(g.doubles ? '🎲 Nochmal würfeln (Pasch!)' : '🎲 Würfeln', 'secondary', () => act({ type: 'roll' }));
      }
    } else if (g.phase === 'buy' && mineTurn) {
      const sq = SQUARES[g.buy.pos];
      msg(`<b>${sq.name}</b> ist frei – ${fmtM(g.buy.price)}`);
      btn(`Kaufen (${fmtM(g.buy.price)})`, 'good', () => act({ type: 'buy' }), me.money < g.buy.price);
      btn('Versteigern', '', () => act({ type: 'declineBuy' }));
    } else if (g.phase === 'auction') {
      const a = g.auction;
      const sq = SQUARES[a.pos];
      if (a.bidderId === id) {
        const { minRaise, opts } = bidButtons(a, me.money);
        msg(`🔨 <b>${sq.name}</b> – ${a.highBidder ? `Höchstgebot ${fmtM(a.highBid)} (${pname(a.highBidder)})` : 'noch kein Gebot'}. Du bist dran:`);
        opts.forEach((v) => btn(fmtM(v), 'secondary', () => act({ type: 'bid', amount: v })));
        const input = el('input', { class: 'bid-input', type: 'number', min: minRaise, max: me.money, placeholder: `ab ${minRaise}` });
        if (bidDraft) input.value = bidDraft;
        input.addEventListener('input', () => { bidDraft = input.value; });
        box.appendChild(input);
        btn('Bieten', 'good', () => { const v = Number(input.value); bidDraft = null; act({ type: 'bid', amount: v }); });
        btn('Passen', '', () => { bidDraft = null; act({ type: 'passBid' }); });
      } else {
        const passed = a.passed.includes(id);
        msg(`🔨 Auktion: <b>${sq.name}</b> – ${a.highBidder ? `Höchstgebot ${fmtM(a.highBid)} von ${pname(a.highBidder)}` : 'noch kein Gebot'}. ${passed ? 'Du hast gepasst.' : `${pname(a.bidderId)} ist dran.`}`);
      }
    } else if (g.phase === 'debt') {
      const mine = g.debts.filter((d) => d.from === id);
      if (mine.length) {
        const total = mine.reduce((sum, d) => sum + d.amount, 0);
        const to = mine[0].to ? pname(mine[0].to) : 'die Bank';
        msg(`💸 Du schuldest <b>${fmtM(total)}</b> (${to}). Verkaufe Gebäude oder beleihe Grundstücke – oder gib auf.`);
        btn('🏳️ Aufgeben', 'danger', () => act({ type: 'resign' }));
      } else {
        msg(`Warte auf ${g.debts.map((d) => pname(d.from)).filter((v, i, a) => a.indexOf(v) === i).join(', ')} – Schulden begleichen …`);
      }
    } else if (g.phase === 'end' && mineTurn) {
      msg('Zug gespielt – du kannst noch bauen, handeln oder Hypotheken verwalten.');
      btn('✅ Zug beenden', 'good', () => act({ type: 'endTurn' }));
    } else {
      msg(`Warte auf <b>${pname(g.turnId)}</b> …`);
    }

    // Immer verfügbar
    if (g.phase !== 'auction') {
      if (g.trade && g.trade.from === id) {
        msg(`🤝 Angebot an ${pname(g.trade.to)} wartet auf Antwort.`);
        btn('Zurückziehen', 'ghost small', () => act({ type: 'cancelTrade' }));
      } else if (!g.trade) {
        btn('🤝 Handeln', 'ghost', () => openTrade());
      }
    }
    if (canSkip) btn('⏭ Überspringen', 'ghost small', () => socket.emit('skipTurn'));
  }

  // ---------------------------------------------------------------------
  // Grundstück-Detail (Besitzurkunde + Verwaltung)
  // ---------------------------------------------------------------------

  let propModalPos = null;

  function openProp(pos) {
    if (!S || !S.game) return;
    propModalPos = pos;
    renderPropModal();
    show($('prop-modal'));
  }

  function renderPropModal() {
    if (propModalPos === null || !S || !S.game) return;
    const g = S.game;
    const pos = propModalPos;
    const sq = SQUARES[pos];
    const p = propOf(pos);
    const grp = GROUPS[sq.group];
    const body = $('prop-modal-body');
    body.innerHTML = '';

    const rows = [];
    if (sq.type === 'property') {
      const hs = p ? p.houses : 0;
      rows.push(['Miete', sq.rent[0] + ' ₮', hs === 0]);
      rows.push(['Miete mit allen Straßen der Farbe (unbebaut)', sq.rent[0] * 2 + ' ₮', false]);
      for (let i = 1; i <= 4; i++) rows.push([`Mit ${i} Haus${i > 1 ? 'häusern' : ''}`, sq.rent[i] + ' ₮', hs === i]);
      rows.push(['Mit Hotel', sq.rent[5] + ' ₮', hs === 5]);
    } else if (sq.type === 'station') {
      const n = p ? GROUP_POSITIONS.station.filter((x) => { const q = propOf(x); return q && q.owner === p.owner; }).length : 0;
      [25, 50, 100, 200].forEach((v, i) => rows.push([`${i + 1} Bahnhof${i ? 'höfe' : ''} besitzen`, v + ' ₮', n === i + 1]));
    } else {
      rows.push(['1 Werk besitzen', '4 × Augenzahl', false]);
      rows.push(['Beide Werke besitzen', '10 × Augenzahl', false]);
    }
    const table = el('table', {}, rows.map((r) => el('tr', { class: r[2] ? 'cur' : '' }, [el('td', { text: r[0] }), el('td', { text: r[1] })])));
    const foot = [`Preis ${sq.price} ₮`, `Hypothek ${sq.price / 2} ₮`];
    if (sq.type === 'property') foot.push(`Haus/Hotel je ${grp.houseCost} ₮`);
    const deed = el('div', { class: 'deed' }, [
      el('div', { class: 'deed-head' + (LIGHT_BANDS[sq.group] ? ' lightband' : ''), style: `--band:${grp.color}` }, [el('small', { text: sq.type === 'property' ? 'Besitzurkunde · ' + grp.name : sq.type === 'station' ? 'Bahnhof' : 'Versorgungswerk' }), el('b', { text: sq.name })]),
      table,
      el('div', { class: 'deed-foot', text: foot.join(' · ') }),
    ]);
    body.appendChild(deed);

    const ownerLine = el('p', { class: 'hint', style: 'margin:0 0 10px' });
    if (p) {
      ownerLine.textContent = `Besitzer: ${pname(p.owner)}${p.mortgaged ? ' (beliehen)' : ''}${sq.type === 'property' && p.houses ? ` · ${p.houses === 5 ? 'Hotel' : p.houses + ' Haus/Häuser'}` : ''}`;
    } else ownerLine.textContent = 'Noch frei – gehört der Bank.';
    body.appendChild(ownerLine);

    if (p && p.owner === myId() && sq.type === 'property') {
      const ps = GROUP_POSITIONS[sq.group];
      const missing = ps.filter((x) => { const q = propOf(x); return !q || q.owner !== myId(); });
      if (missing.length) {
        const box = el('div', { class: 'set-missing' }, [el('h4', { text: `Was fehlt für das ${grp.name}-Set?` })]);
        missing.forEach((x) => {
          const q = propOf(x);
          const row = el('div', { class: 'tip-row' }, [el('span', { text: `${SQUARES[x].name} – ${q ? 'gehört ' + pname(q.owner) : 'noch frei'}` })]);
          if (q && !q.mortgaged) {
            const b = el('button', { class: 'btn ghost small', text: '🤝 Anfragen' });
            b.addEventListener('click', () => { hide($('prop-modal')); propModalPos = null; openTrade(q.owner, { get: [x], giveCash: offerFor(x, missing.length === 1) }); });
            row.appendChild(b);
          }
          box.appendChild(row);
        });
        body.appendChild(box);
      }
    }

    const col = el('div', { class: 'btn-col' });
    const mineNow = p && p.owner === myId();
    const addAction = (label, cls, err, action) => {
      const b = el('button', { class: 'btn ' + cls, text: label });
      if (err) b.disabled = true;
      b.addEventListener('click', () => act(action));
      col.appendChild(b);
      if (err) col.appendChild(el('div', { class: 'reason', text: err }));
    };
    if (mineNow) {
      if (sq.type === 'property') {
        const cost = grp.houseCost;
        addAction(p.houses === 4 ? `🏨 Hotel bauen (−${cost} ₮)` : `🏠 Haus bauen (−${cost} ₮)`, 'good', p.errBuild, { type: 'build', pos });
        if (p.houses > 0) addAction(`Gebäude verkaufen (+${cost / 2} ₮)`, '', p.errSell, { type: 'sell', pos });
      }
      if (!p.mortgaged) addAction(`Hypothek aufnehmen (+${sq.price / 2} ₮)`, '', p.errMortgage, { type: 'mortgage', pos });
      else addAction(`Hypothek tilgen (−${sq.price / 2 + Math.ceil(sq.price / 20)} ₮)`, 'secondary', p.errUnmortgage, { type: 'unmortgage', pos });
    } else if (p && g.players[myId()] && !g.players[myId()].bankrupt && !p.mortgaged) {
      const b = el('button', { class: 'btn secondary', text: `🤝 Angebot an ${pname(p.owner)} machen` });
      b.addEventListener('click', () => { hide($('prop-modal')); propModalPos = null; openTrade(p.owner, { get: [pos] }); });
      col.appendChild(b);
    }
    body.appendChild(col);
  }

  // ---------------------------------------------------------------------
  // Spieler-Detail
  // ---------------------------------------------------------------------

  let playerModalId = null;
  function openPlayer(id) {
    playerModalId = id;
    renderPlayerModal();
    show($('player-modal'));
  }
  function renderPlayerModal() {
    if (!playerModalId || !S || !S.game) return;
    const g = S.game;
    const id = playerModalId;
    const gp = g.players[id];
    const body = $('player-modal-body');
    body.innerHTML = '';
    body.appendChild(el('h2', {}, [tokdot(id), document.createTextNode(' ' + pname(id))]));
    body.appendChild(el('p', { class: 'hint', style: 'margin:0', text: gp.bankrupt ? 'Ist pleite.' : `Bargeld ${fmtM(gp.money)} · Vermögen ${fmtM(gp.netWorth)}${gp.jailCards ? ` · ${gp.jailCards} Freikarte(n)` : ''}${gp.inJail ? ' · im Knast' : ''}` }));
    const mine = g.props.filter((p) => p.owner === id).map((p) => p.pos).sort((a, b) => a - b);
    const cards = el('div', { class: 'pl-cards' });
    if (!mine.length) cards.appendChild(el('span', { class: 'hint', text: 'Keine Grundstücke.' }));
    mine.forEach((pos) => cards.appendChild(propCard(pos, {
      mono: SQUARES[pos].type === 'property' && ownsFullGroup(id, SQUARES[pos].group),
      onclick: () => { hide($('player-modal')); playerModalId = null; openProp(pos); },
    })));
    body.appendChild(cards);
    const me = g.players[myId()];
    if (id !== myId() && !gp.bankrupt && me && !me.bankrupt) {
      const b = el('button', { class: 'btn secondary', text: `🤝 Mit ${pname(id)} handeln` });
      b.addEventListener('click', () => { hide($('player-modal')); playerModalId = null; openTrade(id); });
      body.appendChild(b);
    }
  }

  // ---------------------------------------------------------------------
  // Handel
  // ---------------------------------------------------------------------

  let draft = null; // { to, give: { cash, props:Set, cards }, get: { ... } }

  function groupHasBuildings(pos) {
    const sq = SQUARES[pos];
    if (sq.type !== 'property') return false;
    return GROUP_POSITIONS[sq.group].some((x) => { const q = propOf(x); return q && q.houses > 0; });
  }

  function openTrade(partnerId, preset) {
    if (!S || !S.game) return;
    const g = S.game;
    const me = g.players[myId()];
    if (!me || me.bankrupt) return;
    if (g.phase === 'auction') return toast('Während einer Auktion kannst du nicht handeln.');
    if (g.trade) return toast('Es läuft bereits ein Handelsangebot.');
    const others = g.order.filter((id) => id !== myId() && !g.players[id].bankrupt);
    if (!others.length) return toast('Niemand zum Handeln da.');
    draft = {
      to: partnerId && others.includes(partnerId) ? partnerId : others[0],
      give: { cash: Math.min(me.money, (preset && preset.giveCash) || 0), props: new Set((preset && preset.give) || []), cards: (preset && preset.giveCards) || 0 },
      get: { cash: (preset && preset.getCash) || 0, props: new Set((preset && preset.get) || []), cards: (preset && preset.getCards) || 0 },
    };
    renderTradeModal();
    show($('trade-modal'));
  }

  // Vorschläge: Grundstücke des Partners, die mir zu einem Farbset fehlen.
  function offerFor(pos, completes) {
    const me = S.game.players[myId()];
    return Math.min(me.money, Math.ceil((SQUARES[pos].price * (completes ? 1.8 : 1.3)) / 10) * 10);
  }

  function tradeTips() {
    const g = S.game;
    const box = el('div', { class: 'trade-tips' }, [el('h4', { text: '💡 Was fehlt mir bei ' + pname(draft.to) + '?' })]);
    const tips = [];
    Object.keys(GROUP_POSITIONS).forEach((gr) => {
      const ps = GROUP_POSITIONS[gr];
      const mine = ps.filter((x) => { const q = propOf(x); return q && q.owner === myId(); });
      if (!mine.length || mine.length === ps.length) return;
      const theirs = ps.filter((x) => { const q = propOf(x); return q && q.owner === draft.to && !groupHasBuildings(x); });
      theirs.forEach((pos) => tips.push({ pos, gr, completes: theirs.length === ps.length - mine.length, mine: mine.length, total: ps.length }));
    });
    tips.sort((a, b) => Number(b.completes) - Number(a.completes));
    if (!tips.length) box.appendChild(el('div', { class: 'hint', style: 'margin:0', text: 'Bei dieser Person liegt gerade nichts, was dir zu einem Set fehlt.' }));
    tips.slice(0, 4).forEach((t) => {
      const offer = offerFor(t.pos, t.completes);
      const row = el('div', { class: 'tip-row' }, [
        propCard(t.pos, { small: true }),
        el('span', { text: `${SQUARES[t.pos].name} – ${t.completes ? `vervollständigt dein ${GROUPS[t.gr].name}-Set!` : `du hast ${t.mine} von ${t.total} in ${GROUPS[t.gr].name}`}` }),
      ]);
      const b = el('button', { class: 'btn ghost small', text: `Anfragen (${fmtM(offer)})` });
      b.addEventListener('click', () => { draft.get.props = new Set([t.pos]); draft.give.cash = offer; renderTradeModal(); });
      row.appendChild(b);
      box.appendChild(row);
    });
    return box;
  }

  function tradeColumn(title, ownerId, side) {
    const g = S.game;
    const gp = g.players[ownerId];
    const col = el('div', { class: 'trade-col' }, [el('h4', { text: title })]);
    const cashIn = el('input', { type: 'number', min: 0, max: gp.money, value: side.cash || '', placeholder: `0 – ${gp.money}` });
    cashIn.addEventListener('input', () => { side.cash = Math.max(0, Math.min(gp.money, Math.round(Number(cashIn.value) || 0))); renderTradeSummary(); });
    col.appendChild(el('label', { text: 'Geld (Taler)' }));
    col.appendChild(cashIn);
    if (gp.jailCards) {
      col.appendChild(el('label', { text: `Freikarten (max. ${gp.jailCards})` }));
      const cIn = el('input', { type: 'number', min: 0, max: gp.jailCards, value: side.cards || '', placeholder: '0' });
      cIn.addEventListener('input', () => { side.cards = Math.max(0, Math.min(gp.jailCards, Math.round(Number(cIn.value) || 0))); renderTradeSummary(); });
      col.appendChild(cIn);
    }
    col.appendChild(el('label', { text: 'Grundstücke' }));
    const cards = el('div', { class: 'pl-cards', style: 'margin:0' });
    const owned = g.props.filter((p) => p.owner === ownerId).map((p) => p.pos).sort((a, b) => a - b);
    if (!owned.length) cards.appendChild(el('span', { class: 'hint', style: 'margin:0', text: 'Keine' }));
    owned.forEach((pos) => {
      const locked = groupHasBuildings(pos);
      const c = propCard(pos, { small: true, cls: 'pick' + (side.props.has(pos) ? ' picked' : '') + (locked ? ' locked' : '') });
      c.title = locked ? SQUARES[pos].name + ' – Gebäude erst verkaufen' : SQUARES[pos].name;
      c.addEventListener('click', () => {
        if (locked) return toast('In dieser Farbgruppe stehen Gebäude – erst verkaufen.');
        if (side.props.has(pos)) side.props.delete(pos); else side.props.add(pos);
        c.classList.toggle('picked');
        renderTradeSummary();
      });
      cards.appendChild(c);
    });
    col.appendChild(cards);
    return col;
  }

  function sideText(side) {
    const parts = [];
    if (side.cash) parts.push(fmtM(side.cash));
    Array.from(side.props).forEach((pos) => parts.push(SQUARES[pos].name));
    if (side.cards) parts.push(`${side.cards}× Freikarte`);
    return parts.length ? parts.join(', ') : 'nichts';
  }

  function renderTradeSummary() {
    const s = document.getElementById('trade-summary');
    if (!s || !draft) return;
    s.innerHTML = '';
    s.appendChild(el('div', { html: `Du gibst <b></b> und erhältst <b></b>.` }));
    const bs = s.querySelectorAll('b');
    bs[0].textContent = sideText(draft.give);
    bs[1].textContent = sideText(draft.get);
  }

  function renderTradeModal() {
    if (!draft || !S || !S.game) return;
    const g = S.game;
    const body = $('trade-modal-body');
    body.innerHTML = '';
    body.appendChild(el('h2', { text: '🤝 Handelsangebot' }));

    const sel = el('select', {});
    g.order.filter((id) => id !== myId() && !g.players[id].bankrupt).forEach((id) => {
      const o = el('option', { value: id, text: pname(id) });
      if (id === draft.to) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => {
      draft.to = sel.value;
      draft.get = { cash: 0, props: new Set(), cards: 0 };
      renderTradeModal();
    });
    body.appendChild(el('label', { class: 'hint', style: 'display:block;margin:0 0 4px', text: 'Handeln mit' }));
    body.appendChild(sel);

    body.appendChild(tradeTips());
    body.appendChild(el('div', { class: 'trade-cols' }, [
      tradeColumn('Du gibst', myId(), draft.give),
      tradeColumn(`${pname(draft.to)} gibt`, draft.to, draft.get),
    ]));
    body.appendChild(el('div', { class: 'trade-summary', id: 'trade-summary' }));
    body.appendChild(el('p', { class: 'hint', style: 'margin:4px 0', text: 'Beliehene Grundstücke kosten den neuen Besitzer sofort 10 % Zinsen.' }));

    const send = el('button', { class: 'btn good', text: 'Angebot senden' });
    send.addEventListener('click', () => {
      act({
        type: 'proposeTrade', to: draft.to,
        give: { cash: draft.give.cash, props: Array.from(draft.give.props), cards: draft.give.cards },
        get: { cash: draft.get.cash, props: Array.from(draft.get.props), cards: draft.get.cards },
      }, (res) => { if (res && res.ok) { hide($('trade-modal')); draft = null; toast('Angebot gesendet.'); } });
    });
    const cancel = el('button', { class: 'btn ghost', text: 'Abbrechen' });
    cancel.addEventListener('click', () => { hide($('trade-modal')); draft = null; });
    body.appendChild(el('div', { class: 'row-btns' }, [cancel, send]));
    renderTradeSummary();
  }

  let tradeInId = null;
  function renderIncomingTrade(s) {
    const g = s.game;
    const t = g && g.trade;
    const modal = $('trade-in-modal');
    if (!t || t.to !== myId() || g.phase === 'over') {
      if (tradeInId !== null) { tradeInId = null; hide(modal); }
      return;
    }
    if (tradeInId === t.id) return;
    tradeInId = t.id;
    playCardSound(); vibrate(100);
    const body = $('trade-in-body');
    body.innerHTML = '';
    body.appendChild(el('h2', { text: `🤝 Angebot von ${pname(t.from)}` }));
    const side = (title, sideData) => {
      const box = el('div', { class: 'trade-col' }, [el('h4', { text: title })]);
      if (sideData.cash) box.appendChild(el('div', { text: fmtM(sideData.cash), style: 'font-weight:800;color:var(--gold-bright);margin-bottom:6px' }));
      if (sideData.cards) box.appendChild(el('div', { text: `🔑 ${sideData.cards}× Freikarte`, style: 'margin-bottom:6px' }));
      const cards = el('div', { class: 'pl-cards', style: 'margin:0' });
      sideData.props.forEach((pos) => cards.appendChild(propCard(pos, { small: true })));
      box.appendChild(cards);
      if (!sideData.cash && !sideData.cards && !sideData.props.length) box.appendChild(el('span', { class: 'hint', style: 'margin:0', text: 'nichts' }));
      return box;
    };
    body.appendChild(el('div', { class: 'trade-cols' }, [side('Du erhältst', t.give), side('Du gibst', t.get)]));
    const counter = el('button', { class: 'btn secondary', text: '↩ Gegenangebot' });
    counter.addEventListener('click', () => {
      act({ type: 'cancelTrade' }, (res) => {
        if (!res || !res.ok) return;
        setTimeout(() => openTrade(t.from, { give: t.get.props, giveCash: t.get.cash, giveCards: t.get.cards, get: t.give.props, getCash: t.give.cash, getCards: t.give.cards }), 250);
      });
    });
    const no = el('button', { class: 'btn ghost', text: 'Ablehnen' });
    no.addEventListener('click', () => act({ type: 'cancelTrade' }));
    const yes = el('button', { class: 'btn good', text: 'Annehmen' });
    yes.addEventListener('click', () => act({ type: 'acceptTrade' }));
    body.appendChild(el('div', { class: 'row-btns' }, [no, counter, yes]));
    show(modal);
  }

  // ---------------------------------------------------------------------
  // Spielende
  // ---------------------------------------------------------------------

  function statsBlock(g) {
    const wrap = el('div', {});
    const ids = g.order;
    const st = g.stats || {};
    const cols = [
      ['💰 Miete kassiert', 'rentIn'], ['💸 Miete gezahlt', 'rentOut'], ['🏠 Gekauft', 'bought'], ['🏗️ Gebaut', 'built'],
    ];
    const best = {};
    cols.forEach(([, k]) => { best[k] = Math.max(...ids.map((id) => (st[id] ? st[id][k] : 0))); });
    const bestNet = Math.max(...ids.map((id) => g.players[id].netWorth));
    const awards = el('div', { class: 'awards' });
    const award = (k, label) => {
      if (!best[k]) return;
      const w = ids.filter((id) => st[id] && st[id][k] === best[k]);
      awards.appendChild(el('span', { class: 'award', text: `${label}: ${w.map(pname).join(', ')}` }));
    };
    award('rentIn', '👑 Mietkönig');
    award('rentOut', '💸 Größter Zahler');
    award('built', '🏗️ Bauherr');
    award('bought', '🏠 Sammler');
    if (g.limitReached) awards.appendChild(el('span', { class: 'award', text: g.limit && g.limit.mode === 'minutes' ? '⏰ Zeit abgelaufen' : '🏁 Rundenlimit erreicht' }));
    wrap.appendChild(awards);
    const head = el('tr', {}, [el('th', { text: 'Spieler' })].concat(cols.map(([l]) => el('th', { text: l }))).concat([el('th', { text: 'Vermögen' })]));
    const rows = (g.ranking || ids).map((id) => {
      const x = st[id] || { rentIn: 0, rentOut: 0, bought: 0, built: 0 };
      const tds = [el('td', {}, [tokdot(id, true), document.createTextNode(' ' + pname(id))])];
      cols.forEach(([, k]) => tds.push(el('td', { class: best[k] && x[k] === best[k] ? 'best' : '', text: k.startsWith('rent') ? fmtM(x[k]) : String(x[k]) })));
      const gp = g.players[id];
      tds.push(el('td', { class: gp.netWorth === bestNet ? 'best' : '', text: gp.bankrupt ? 'pleite' : fmtM(gp.netWorth) }));
      return el('tr', {}, tds);
    });
    wrap.appendChild(el('table', { class: 'stats-table' }, [head].concat(rows)));
    return wrap;
  }

  let overShown = false;
  function renderOver(s) {
    const g = s.game;
    const modal = $('over-modal');
    if (g.phase !== 'over') { overShown = false; hide(modal); return; }
    if (overShown) return;
    overShown = true;
    playWinSound();
    confetti();
    const body = $('over-body');
    body.innerHTML = '';
    body.appendChild(el('div', { class: 'over-crown', text: '🏆' }));
    body.appendChild(el('h2', { style: 'text-align:center;padding:0', text: g.winner ? `${pname(g.winner)} beherrscht Entenhausen!` : 'Spiel beendet' }));
    const list = el('ul', { class: 'rank-list' });
    (g.ranking || []).forEach((id, i) => {
      list.appendChild(el('li', {}, [el('b', { text: `${i + 1}.` }), tokdot(id), el('span', { text: pname(id) })]));
    });
    body.appendChild(list);
    body.appendChild(statsBlock(g));
    modal.querySelector('.modal-content').classList.add('over-wide');
    if (isHost()) {
      const b = el('button', { class: 'btn primary', text: 'Neue Partie (zurück zur Lobby)' });
      b.addEventListener('click', () => socket.emit('resetGame'));
      body.appendChild(b);
    } else {
      body.appendChild(el('p', { class: 'hint', style: 'text-align:center', text: 'Warte, bis der Host eine neue Partie startet …' }));
    }
    const leave = el('button', { class: 'btn ghost small', style: 'margin:10px auto 0;display:flex', text: 'Verlassen' });
    leave.addEventListener('click', leaveToHome);
    body.appendChild(leave);
    show(modal);
  }

  // ---------------------------------------------------------------------
  // Leben im Spiel: Geld-Animationen, Münzen, Ansagen, Konfetti
  // ---------------------------------------------------------------------

  const dispMoney = {};   // gerade angezeigter (animierter) Betrag
  const realMoney = {};   // tatsächlicher Betrag laut Server
  const pendingDelta = {};
  const moneyAnim = {};
  let flushScheduled = false;
  let turnKeySeen = null;

  function moneyShown(id, real) { return dispMoney[id] !== undefined ? dispMoney[id] : real; }

  function anchorRect(id) {
    const n = id ? document.querySelector(`[data-mid="${id}"]`) : null;
    if (n) { const r = n.getBoundingClientRect(); if (r.width) return r; }
    const b = statusEl ? statusEl.getBoundingClientRect() : $('board').getBoundingClientRect();
    return b;
  }

  function trackMoney(g) {
    let any = false;
    g.order.forEach((id) => {
      const cur = g.players[id].money;
      if (realMoney[id] === undefined) { realMoney[id] = cur; dispMoney[id] = cur; return; }
      if (realMoney[id] !== cur) {
        pendingDelta[id] = (pendingDelta[id] || 0) + (cur - realMoney[id]);
        realMoney[id] = cur;
        any = true;
      }
    });
    if (any && !flushScheduled) { flushScheduled = true; whenIdle(flushMoney); }
  }

  function startMoneyAnim(id, to) {
    cancelAnimationFrame(moneyAnim[id]);
    const from = dispMoney[id];
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / 800);
      dispMoney[id] = Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3)));
      document.querySelectorAll(`[data-mid="${id}"]`).forEach((n) => { n.textContent = fmtM(dispMoney[id]); n.classList.toggle('money-up', to > from && p < 1); n.classList.toggle('money-down', to < from && p < 1); });
      if (p < 1) moneyAnim[id] = requestAnimationFrame(step);
    };
    moneyAnim[id] = requestAnimationFrame(step);
  }

  function floatText(text, rect, cls) {
    const n = el('div', { class: 'float-text ' + cls, text, style: 'position:fixed;pointer-events:none;z-index:500' });
    n.style.left = (rect.left + rect.width / 2) + 'px';
    n.style.top = (rect.top + rect.height / 2) + 'px';
    document.body.appendChild(n);
    setTimeout(() => n.remove(), 1700);
  }

  function flyCoins(from, to, count) {
    for (let i = 0; i < count; i++) {
      const c = el('div', { class: 'coin', text: '🪙', style: 'position:fixed;pointer-events:none;z-index:500' });
      const sx = from.left + from.width / 2 + (Math.random() - 0.5) * 20;
      const sy = from.top + from.height / 2 + (Math.random() - 0.5) * 20;
      const ex = to.left + to.width / 2 + (Math.random() - 0.5) * 20;
      const ey = to.top + to.height / 2 + (Math.random() - 0.5) * 20;
      c.style.left = sx + 'px'; c.style.top = sy + 'px';
      document.body.appendChild(c);
      const anim = c.animate([
        { transform: 'translate(-50%,-50%) scale(0.6)', opacity: 0 },
        { transform: `translate(calc(-50% + ${(ex - sx) * 0.3}px), calc(-50% + ${(ey - sy) * 0.3 - 50}px)) scale(1.2)`, opacity: 1, offset: 0.35 },
        { transform: `translate(calc(-50% + ${ex - sx}px), calc(-50% + ${ey - sy}px)) scale(0.8)`, opacity: 1, offset: 0.9 },
        { transform: `translate(calc(-50% + ${ex - sx}px), calc(-50% + ${ey - sy}px)) scale(0.4)`, opacity: 0 },
      ], { duration: 950, delay: i * 90, easing: 'ease-in-out', fill: 'backwards' });
      anim.onfinish = () => c.remove();
    }
  }

  function flushMoney() {
    flushScheduled = false;
    if (!S || !S.game) return;
    const ids = Object.keys(pendingDelta).filter((id) => pendingDelta[id]);
    const bank = anchorRect(null);
    const neg = ids.filter((id) => pendingDelta[id] < 0);
    const pos = ids.filter((id) => pendingDelta[id] > 0);
    ids.forEach((id) => {
      const d = pendingDelta[id];
      floatText((d > 0 ? '+' : '−') + Math.abs(d) + ' ₮', anchorRect(id), d > 0 ? 'gain' : 'loss');
      if (dispMoney[id] === undefined) dispMoney[id] = realMoney[id] - d;
      startMoneyAnim(id, realMoney[id]);
    });
    if (neg.length === 1 && pos.length === 1 && -pendingDelta[neg[0]] === pendingDelta[pos[0]]) {
      flyCoins(anchorRect(neg[0]), anchorRect(pos[0]), Math.min(8, 3 + Math.floor(pendingDelta[pos[0]] / 100)));
    } else {
      neg.forEach((id) => flyCoins(anchorRect(id), bank, Math.min(8, 3 + Math.floor(-pendingDelta[id] / 100))));
      pos.forEach((id) => flyCoins(bank, anchorRect(id), Math.min(8, 3 + Math.floor(pendingDelta[id] / 100))));
    }
    if (ids.length) { playTone(880, 0.06, 0, 0.12, 'triangle'); playTone(1175, 0.08, 0.07, 0.12, 'triangle'); }
    ids.forEach((id) => { delete pendingDelta[id]; });
  }

  function splash(text, cls, ms) {
    const board = $('board');
    if (!board) return;
    const n = el('div', { class: 'splash ' + (cls || ''), text, style: 'position:absolute;left:50%;top:30%;pointer-events:none;z-index:28' });
    board.appendChild(n);
    setTimeout(() => n.remove(), ms || 1500);
  }

  function turnSplash(g) {
    const key = g.phase === 'over' ? 'over' : `${g.turnCount}:${g.turnId}`;
    if (turnKeySeen === null) { turnKeySeen = key; return; }
    if (key === turnKeySeen) return;
    turnKeySeen = key;
    if (g.phase === 'over') return;
    const id = g.turnId;
    whenIdle(() => {
      if (!S || !S.game || S.game.turnId !== id) return;
      const p = pinfo(id);
      splash(id === myId() ? `${p ? p.emoji : ''} Du bist dran!` : `${p ? p.emoji : ''} ${pname(id)} ist dran`, id === myId() ? 'mine' : '', 1400);
    });
  }

  function confetti() {
    const colors = ['#f4c95d', '#e0342f', '#3ecf8e', '#8fd3f4', '#e0459c', '#f39c34'];
    for (let i = 0; i < 90; i++) {
      const c = el('i', { class: 'confetti', style: 'position:fixed;top:-20px;width:10px;height:16px;pointer-events:none;z-index:600' });
      c.style.left = Math.random() * 100 + 'vw';
      c.style.background = colors[i % colors.length];
      c.style.animationDelay = Math.random() * 1.6 + 's';
      c.style.animationDuration = 2.4 + Math.random() * 2 + 's';
      c.style.setProperty('--dx', (Math.random() * 160 - 80) + 'px');
      document.body.appendChild(c);
      setTimeout(() => c.remove(), 6500);
    }
  }

  // ---------------------------------------------------------------------
  // Kopfzeile: Runde/Restzeit und Zug-Timer
  // ---------------------------------------------------------------------

  function updateHeaderInfo() {
    if (!S || !S.game) return;
    const g = S.game;
    const infoEl = $('game-info');
    let info = '';
    if (g.phase !== 'over') {
      if (g.limit && g.limit.mode === 'rounds') info = `Runde ${Math.min(g.round, g.limit.value)}/${g.limit.value}`;
      else if (g.limit && g.limit.mode === 'minutes') {
        const rem = Math.max(0, g.limit.endsAt - (Date.now() + clockOffset));
        info = `⏰ ${Math.floor(rem / 60000)}:${String(Math.floor(rem / 1000) % 60).padStart(2, '0')} · Runde ${g.round}`;
      } else info = `Runde ${g.round}`;
    }
    if (infoEl.textContent !== info) infoEl.textContent = info;

    const badge = $('timer-badge');
    const bar = $('timer-bar');
    const t = S.timer;
    if (!t || g.phase === 'over') { badge.classList.add('hidden'); bar.classList.add('hidden'); return; }
    const rem = Math.max(0, t.remainingMs - (Date.now() - stateReceivedAt));
    const secs = Math.ceil(rem / 1000);
    const mineT = t.actorId === myId();
    badge.classList.remove('hidden');
    badge.textContent = `⏱ ${mineT ? '' : pname(t.actorId) + ' '}${secs}s`;
    badge.classList.toggle('urgent', secs <= 10);
    badge.classList.toggle('mine', mineT && secs > 10);
    bar.classList.toggle('hidden', !mineT);
    bar.classList.toggle('urgent', secs <= 10);
    bar.firstElementChild.style.width = Math.max(0, Math.min(100, (rem / t.total) * 100)) + '%';
  }
  setInterval(updateHeaderInfo, 400);

  // ---------------------------------------------------------------------
  // Auktion: Panel in der Brettmitte, Hammer bei jedem Gebot
  // ---------------------------------------------------------------------

  let lastBidCount = 0;
  let lastAuctionSeq = null;
  function playHammerSound() { playTone(180, 0.12, 0, 0.25, 'square'); playTone(120, 0.15, 0.06, 0.2, 'square'); }

  function renderAuction(g) {
    const a = g.auction;
    const la = g.lastAuction;
    if (lastAuctionSeq === null) lastAuctionSeq = la ? la.seq : 0;
    else if (la && la.seq !== lastAuctionSeq) {
      lastAuctionSeq = la.seq;
      playHammerSound();
      splash(`🔨 Zuschlag! ${pname(la.winner)} ersteigert ${SQUARES[la.pos].name} für ${fmtM(la.amount)}`, 'hammer', 2200);
    }
    if (g.phase !== 'auction' || !a) { auctionEl.classList.add('hidden'); auctionEl.innerHTML = ''; lastBidCount = 0; return; }
    const bids = a.bids || [];
    const hit = bids.length > lastBidCount && bids.length > 0;
    lastBidCount = bids.length;
    auctionEl.classList.remove('hidden');
    auctionEl.innerHTML = '';
    const price = el('div', { class: 'ap-price' + (hit ? ' hit' : ''), text: a.highBidder ? fmtM(a.highBid) : '–' });
    const bidders = el('div', { class: 'ap-bidders' });
    a.order.forEach((id) => {
      bidders.appendChild(el('span', { class: 'ap-bidder' + (a.passed.includes(id) ? ' passed' : '') + (a.bidderId === id ? ' turn' : '') + (a.highBidder === id ? ' high' : '') }, [tokdot(id, true), document.createTextNode(pname(id) + (a.highBidder === id ? ' 👑' : ''))]));
    });
    const last = bids.slice(-3).reverse();
    auctionEl.appendChild(el('div', { class: 'ap-card' }, [propCard(a.pos, {})]));
    auctionEl.appendChild(el('div', { class: 'ap-main' }, [
      el('div', { class: 'ap-title', text: '🔨 Auktion' }),
      price,
      el('div', { class: 'ap-sub', text: a.highBidder ? `Höchstgebot von ${pname(a.highBidder)} – ${pname(a.bidderId)} ist dran` : `Noch kein Gebot – ${pname(a.bidderId)} ist dran (ab ${fmtM(a.minBid)})` }),
      bidders,
      last.length ? el('div', { class: 'ap-bids' }, last.map((b) => el('span', { text: `${pname(b.id)} bot ${fmtM(b.amount)}` }))) : null,
    ]));
    if (hit) {
      auctionEl.appendChild(el('div', { class: 'ap-hammer', text: '🔨' }));
      playHammerSound();
    }
  }

  // ---------------------------------------------------------------------
  // Ereignisse beim Landen (Miete, Steuer) und Pleite-Szene
  // ---------------------------------------------------------------------

  let eventSeen = null;
  const eventQueue = [];
  let eventRunning = false;

  function showEvent(e) {
    const board = $('board');
    let children;
    if (e.kind === 'rent') {
      children = [propCard(e.pos, { small: true }), el('div', { class: 'ev-text' }, [document.createTextNode(`${pname(e.payer)} zahlt ${fmtM(e.amount)} Miete`), el('small', { text: `an ${pname(e.owner)} für ${SQUARES[e.pos].name}` })])];
    } else {
      children = [el('span', { text: '💸' }), el('div', { class: 'ev-text' }, [document.createTextNode(`${pname(e.payer)} zahlt ${fmtM(e.amount)}`), el('small', { text: SQUARES[e.pos].name })])];
    }
    const n = el('div', { class: 'splash event', style: 'position:absolute;left:50%;top:68%;pointer-events:none;z-index:27' }, children);
    board.appendChild(n);
    setTimeout(() => n.remove(), T(2500));
  }

  async function runEvents() {
    eventRunning = true;
    while (eventQueue.length) {
      await new Promise((r) => whenIdle(r));
      showEvent(eventQueue.shift());
      await sleep(T(2600));
    }
    eventRunning = false;
  }

  function handleEvents(g) {
    const ev = g.events || [];
    const max = ev.length ? ev[ev.length - 1].seq : 0;
    if (eventSeen === null) { eventSeen = max; return; }
    ev.filter((e) => e.seq > eventSeen).forEach((e) => eventQueue.push(e));
    eventSeen = Math.max(eventSeen, max);
    if (!eventRunning && eventQueue.length) runEvents();
  }

  let prevBankrupt = null;
  function handleBust(g) {
    if (prevBankrupt === null) { prevBankrupt = {}; g.order.forEach((id) => { prevBankrupt[id] = g.players[id].bankrupt; }); return; }
    g.order.forEach((id) => {
      if (g.players[id].bankrupt && !prevBankrupt[id]) {
        whenIdle(() => {
          splash(`💥 ${pname(id)} ist pleite!`, 'bust', 2400);
          [330, 262, 196, 131].forEach((f, i) => playTone(f, 0.22, i * 0.18, 0.2, 'sawtooth'));
        });
      }
      prevBankrupt[id] = g.players[id].bankrupt;
    });
  }

  // ---------------------------------------------------------------------
  // Gesamt-Rendering
  // ---------------------------------------------------------------------

  let clockOffset = 0;
  let boardBuilt = false;
  let notifiedTurnKey = null;

  function renderGame(s) {
    const g = s.game;
    if (!boardBuilt) { buildBoard(); boardBuilt = true; }

    $('game-code').textContent = s.code;
    const mine = g.turnId === myId() && g.phase !== 'over';
    const badge = $('turn-badge');
    badge.textContent = g.phase === 'over' ? 'Spiel beendet' : mine ? 'Du bist dran!' : `${pname(g.turnId)} ist am Zug`;
    badge.classList.toggle('mine', mine);

    updateDice(g);
    syncPositions(g);
    updateBoardOwnership(g);
    renderTokens();
    whenIdle(() => { if (S && S.game) updateCard(S.game); });
    const st = statusFor(s);
    statusEl.innerHTML = '';
    statusEl.appendChild(document.createTextNode(st.t));
    if (st.sub) statusEl.appendChild(el('small', { text: st.sub }));
    if (st.hint) statusEl.appendChild(el('small', { class: 'status-hint', text: st.hint }));

    const pk = document.querySelector('.sq-parking');
    if (pk) {
      const on = g.rules && g.rules.freeParking;
      pk.textContent = on ? `Jackpot: ${g.pot} ₮` : 'Kleine Pause';
      pk.classList.toggle('sq-pot', !!on);
    }
    renderAuction(g);
    handleEvents(g);
    handleBust(g);
    trackMoney(g);
    renderPlayersPanel(s);
    renderFeed(s);
    turnSplash(g);
    renderDockMe(s);
    renderDockProps(s);
    renderDockActions(s);
    updateHeaderInfo();
    renderIncomingTrade(s);
    renderOver(s);
    if (propModalPos !== null && !$('prop-modal').classList.contains('hidden')) renderPropModal();
    if (playerModalId && !$('player-modal').classList.contains('hidden')) renderPlayerModal();
    if (!$('log-modal').classList.contains('hidden')) renderLogModal();

    // Eigener Zug: Ton und Vibration (einmal pro Zug)
    const key = `${g.turnCount}:${g.turnId}`;
    if (mine && key !== notifiedTurnKey && g.phase !== 'over') {
      notifiedTurnKey = key;
      playTurnSound();
      vibrate(120);
    }
  }

  function render() {
    if (!S) return;
    if (S.phase === 'lobby') {
      closeAllModals();
      boardBuilt = false;
      lastRollSeq = null; shownCardSeq = null; lastMoveSeq = null; moveQueue.length = 0; boardOwnersInit = false; feedFirst = null; eventSeen = null; eventQueue.length = 0; prevBankrupt = null; lastAuctionSeq = null; lastBidCount = 0; turnKeySeen = null; Object.keys(realMoney).forEach((k) => { delete realMoney[k]; delete dispMoney[k]; }); dockKey = ''; overShown = false; tradeInId = null;
      Object.keys(shownPos).forEach((k) => delete shownPos[k]);
      showScreen('screen-lobby');
      renderLobby(S);
    } else if (S.game) {
      if ($('screen-game').classList.contains('hidden')) showScreen('screen-game');
      renderGame(S);
    }
  }

  // ---------------------------------------------------------------------
  // Socket-Events
  // ---------------------------------------------------------------------

  socket.on('connect', () => {
    const saved = loadSession();
    if (saved && saved.code && saved.token) {
      session = saved;
      socket.emit('joinRoom', { code: saved.code, name: saved.name, token: saved.token }, (res) => {
        if (!res.ok) {
          clearSession();
          S = null;
          showScreen('screen-home');
        } else {
          session.playerId = res.playerId;
          session.token = res.token;
          saveSession();
        }
      });
    }
  });

  socket.on('gameState', (state) => {
    S = state;
    stateReceivedAt = Date.now();
    clockOffset = state.now ? state.now - Date.now() : 0;
    if (!session) return; // Zustand eines fremden Raums ignorieren
    render();
  });

  // "Überspringen" wird nach einer Wartezeit sichtbar - dafür regelmäßig neu prüfen.
  setInterval(() => {
    if (S && S.game && S.wait && isHost()) { dockKey = ''; renderDockActions(S); }
  }, 3000);
})();
