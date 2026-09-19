// Regel-Tests für die Engine mit vorgegebenen Würfeln (g.forcedDice).

const E = require('../src/engine.js');
const { assert } = require('./helpers.js');

function makeRoom(n) {
  const players = [];
  for (let i = 0; i < n; i++) players.push({ id: 'p' + i, name: 'P' + i, isBot: false, connected: true });
  const room = { players, settings: { startMoney: 1500 }, logs: [], phase: 'playing' };
  E.initGame(room);
  room.g.order = players.map((p) => p.id); // feste Reihenfolge
  room.g.turnIdx = 0;
  return room;
}

function own(room, id, pos, extra) {
  room.g.props[pos] = Object.assign({ owner: id, houses: 0, mortgaged: false }, extra || {});
}

function roll(room, id, a, b) {
  room.g.forcedDice = [a, b];
  return E.act(room, id, { type: 'roll' });
}

const act = (room, id, a) => E.act(room, id, a);
const expectOk = (res, msg) => assert(res.ok, `${msg}: ${res.error}`);
const expectFail = (res, msg) => assert(!res.ok, `${msg} hätte scheitern müssen`);

// 1. Ziehen, Kaufen, Zug beenden --------------------------------------------
{
  const room = makeRoom(3);
  const g = room.g;
  expectOk(roll(room, 'p0', 1, 2), 'Würfeln');
  assert(g.pos.p0 === 3 && g.phase === 'buy', 'Landet auf Ententeich und darf kaufen');
  expectFail(act(room, 'p1', { type: 'buy' }), 'Fremdes Kaufen');
  expectOk(act(room, 'p0', { type: 'buy' }), 'Kaufen');
  assert(g.money.p0 === 1440 && g.props[3].owner === 'p0', 'Kaufpreis abgezogen');
  assert(g.phase === 'end', 'Nach dem Kauf ist der Zug zu Ende');
  expectOk(act(room, 'p0', { type: 'endTurn' }), 'Zug beenden');
  assert(E.curId(room) === 'p1', 'Nächste Person ist dran');
}

// 2. Miete: doppelt bei vollem Set, Häuser, Bahnhöfe, Werke -------------------
{
  const room = makeRoom(2);
  const g = room.g;
  own(room, 'p1', 1); own(room, 'p1', 3);
  g.pos.p0 = 38; // Panzerknacker-Raubzug; 3 Felder weiter = Feld 1 (über LOS)
  roll(room, 'p0', 1, 2);
  assert(g.pos.p0 === 1, 'Landet auf Bruchbude');
  // 200 Gehalt, dann 4 Miete (2 x 2 wegen vollem Set)
  assert(g.money.p0 === 1500 + 200 - 4, `Gehalt und Doppelmiete (ist ${g.money.p0})`);
  assert(g.money.p1 === 1504, 'Miete gutgeschrieben');
}
{
  const room = makeRoom(2);
  const g = room.g;
  own(room, 'p1', 6, { houses: 2 }); // Gänsemarkt mit 2 Häusern = 90
  g.pos.p0 = 0;
  roll(room, 'p0', 2, 4);
  assert(g.money.p0 === 1500 - 90, 'Miete mit 2 Häusern');
}
{
  const room = makeRoom(2);
  const g = room.g;
  own(room, 'p1', 5); own(room, 'p1', 15); own(room, 'p1', 25);
  g.pos.p0 = 0;
  roll(room, 'p0', 2, 3); // Enten-Express, 3 Bahnhöfe -> 100
  assert(g.money.p0 === 1400, `Bahnhofsmiete für 3 Bahnhöfe (ist ${g.money.p0})`);
}
{
  const room = makeRoom(2);
  const g = room.g;
  own(room, 'p1', 12); own(room, 'p1', 28);
  g.pos.p0 = 8;
  roll(room, 'p0', 2, 2); // 4 -> Feld 12, beide Werke: 10 x 4 = 40 (Pasch, aber Miete zählt)
  assert(g.money.p0 === 1460, `Werke-Miete 10x (ist ${g.money.p0})`);
  assert(g.phase === 'roll', 'Nach Pasch darf man erneut würfeln');
}

// 3. Pasch / Knast --------------------------------------------------------------
{
  const room = makeRoom(2);
  const g = room.g;
  g.decks.community.draw = [1, 2, 3]; // Bankirrtum: +200 (harmlos)
  g.decks.chance.draw = [7, 7, 7];    // Dividende
  g.pos.p0 = 0;
  roll(room, 'p0', 1, 1); // Feld 2: Gemeinschaftskarte
  assert(g.phase === 'roll' && g.doubles === 1, 'Nach dem ersten Pasch erneut würfeln');
  roll(room, 'p0', 2, 2); // Feld 6: Gänsemarkt frei
  assert(g.phase === 'buy', 'Kaufentscheidung nach Pasch');
  act(room, 'p0', { type: 'buy' });
  assert(g.phase === 'roll' && g.doubles === 2, 'Nach Kauf wieder würfeln (zweiter Pasch)');
  roll(room, 'p0', 3, 3);
  assert(g.inJail.p0 && g.pos.p0 === 10, 'Dritter Pasch: ab in den Knast');
  assert(g.phase === 'end', 'Nach Knast-Einweisung endet der Zug');
}
{
  const room = makeRoom(2);
  const g = room.g;
  g.pos.p0 = 27; g.pos.p1 = 0;
  roll(room, 'p0', 1, 2); // Feld 30 -> Gehe in den Knast
  assert(g.inJail.p0 && g.pos.p0 === 10, 'Feld "Gehe in den Knast"');
  assert(g.money.p0 === 1500, 'Kein LOS-Gehalt beim Einweisen');
  act(room, 'p0', { type: 'endTurn' });
  act(room, 'p1', { type: 'roll' }); // egal
}
{
  // Knast: Kaution, Karte, Pasch, drei Fehlversuche
  const room = makeRoom(2);
  const g = room.g;
  g.inJail.p0 = true; g.pos.p0 = 10;
  expectOk(act(room, 'p0', { type: 'payJail' }), 'Kaution');
  assert(!g.inJail.p0 && g.money.p0 === 1450 && g.phase === 'roll', 'Frei nach Zahlung, noch würfeln');

  const r2 = makeRoom(2);
  r2.g.inJail.p0 = true; r2.g.pos.p0 = 10; r2.g.jailCards.p0 = ['chance'];
  expectOk(act(r2, 'p0', { type: 'useJailCard' }), 'Freikarte');
  assert(!r2.g.inJail.p0 && r2.g.jailCards.p0.length === 0, 'Freikarte verbraucht');

  const r3 = makeRoom(2);
  r3.g.inJail.p0 = true; r3.g.pos.p0 = 10;
  roll(r3, 'p0', 3, 3); // Pasch: raus und 6 ziehen
  assert(!r3.g.inJail.p0 && r3.g.pos.p0 === 16, 'Pasch befreit und zieht');
  assert(r3.g.phase === 'buy', 'Kann Glückswiese kaufen');
  act(r3, 'p0', { type: 'buy' });
  assert(r3.g.phase === 'end', 'Kein Extrawurf nach Knast-Pasch');

  const r4 = makeRoom(2);
  const g4 = r4.g;
  g4.inJail.p0 = true; g4.pos.p0 = 10;
  roll(r4, 'p0', 1, 2);
  assert(g4.inJail.p0 && g4.phase === 'end', 'Erster Fehlversuch bleibt im Knast');
  g4.jailTurns.p0 = 2; // dritter Versuch: Kaution wird fällig und die Figur zieht
  g4.phase = 'roll'; g4.next = 'roll';
  roll(r4, 'p0', 1, 2);
  assert(!g4.inJail.p0 && g4.money.p0 === 1450 && g4.pos.p0 === 13, 'Dritter Fehlversuch: 50 zahlen und ziehen');
}

// 4. Auktion ----------------------------------------------------------------------
{
  const room = makeRoom(3);
  const g = room.g;
  roll(room, 'p0', 1, 2); // Ententeich
  expectOk(act(room, 'p0', { type: 'declineBuy' }), 'Nicht kaufen');
  assert(g.phase === 'auction' && g.auction.order[0] === 'p1', 'Auktion beginnt links vom Spieler');
  expectFail(act(room, 'p2', { type: 'bid', amount: 20 }), 'Falscher Bieter');
  expectFail(act(room, 'p1', { type: 'bid', amount: 5 }), 'Unter Mindestgebot');
  expectOk(act(room, 'p1', { type: 'bid', amount: 10 }), 'Gebot 10');
  expectOk(act(room, 'p2', { type: 'bid', amount: 30 }), 'Gebot 30');
  expectOk(act(room, 'p0', { type: 'passBid' }), 'p0 passt');
  expectOk(act(room, 'p1', { type: 'passBid' }), 'p1 passt');
  assert(g.props[3] && g.props[3].owner === 'p2' && g.money.p2 === 1470, 'p2 ersteigert für 30');
  assert(g.phase === 'end', 'Nach der Auktion endet der Zug');
}
{
  const room = makeRoom(2);
  const g = room.g;
  roll(room, 'p0', 1, 2);
  act(room, 'p0', { type: 'declineBuy' });
  act(room, 'p1', { type: 'passBid' });
  act(room, 'p0', { type: 'passBid' });
  assert(!g.props[3], 'Ohne Gebote bleibt das Grundstück frei');
  assert(g.phase === 'end', 'Zug endet');
}

// 5. Bauen ------------------------------------------------------------------------
{
  const room = makeRoom(2);
  const g = room.g;
  own(room, 'p0', 1); own(room, 'p0', 3);
  expectOk(act(room, 'p0', { type: 'build', pos: 1 }), 'Haus 1');
  expectFail(act(room, 'p0', { type: 'build', pos: 1 }), 'Ungleichmäßig bauen');
  expectOk(act(room, 'p0', { type: 'build', pos: 3 }), 'Haus auf anderer Straße');
  for (let i = 0; i < 4; i++) {
    expectOk(act(room, 'p0', { type: 'build', pos: 1 }), 'Weiter bauen');
    expectOk(act(room, 'p0', { type: 'build', pos: 3 }), 'Weiter bauen');
  }
  assert(g.props[1].houses === 5 && g.hotelsLeft === 10, 'Hotel gebaut');
  assert(g.housesLeft === 32, 'Häuser zurück in der Bank');
  expectFail(act(room, 'p0', { type: 'build', pos: 1 }), 'Kein Ausbau über Hotel');
  expectFail(act(room, 'p0', { type: 'mortgage', pos: 1 }), 'Beleihen mit Gebäuden');
  expectOk(act(room, 'p0', { type: 'sell', pos: 3 }), 'Hotel verkaufen');
  assert(g.props[3].houses === 4 && g.housesLeft === 28, 'Hotel wird zu 4 Häusern');
  const before = g.money.p0;
  expectFail(act(room, 'p0', { type: 'sell', pos: 3 }), 'Ungleich verkaufen (Straße 1 hat mehr)');
  expectOk(act(room, 'p0', { type: 'sell', pos: 1 }), 'Verkaufen Hotel 1');
  assert(g.money.p0 === before + 25, 'Halber Baupreis zurück');
}
{
  const room = makeRoom(2);
  own(room, 'p0', 1);
  expectFail(act(room, 'p0', { type: 'build', pos: 1 }), 'Ohne volles Set');
  own(room, 'p0', 3, { mortgaged: true });
  expectFail(act(room, 'p0', { type: 'build', pos: 1 }), 'Mit beliehener Straße im Set');
}

// 6. Hypotheken ---------------------------------------------------------------------
{
  const room = makeRoom(2);
  const g = room.g;
  own(room, 'p0', 39);
  expectOk(act(room, 'p0', { type: 'mortgage', pos: 39 }), 'Beleihen');
  assert(g.money.p0 === 1700, 'Hypothek 200');
  // Miete auf beliehenem Feld entfällt
  g.pos.p1 = 30; g.turnIdx = 1;
  roll(room, 'p1', 3, 6);
  assert(g.money.p1 === 1500 + 0, 'Keine Miete auf beliehenem Feld (nur Gehalt fällt nicht an, da 30 -> 39)');
  const room2 = makeRoom(2);
  own(room2, 'p0', 39, { mortgaged: true });
  expectOk(act(room2, 'p0', { type: 'unmortgage', pos: 39 }), 'Hypothek tilgen');
  assert(room2.g.money.p0 === 1500 - 220, 'Tilgung: 200 + 10% Zinsen');
}

// 7. Handeln --------------------------------------------------------------------------
{
  const room = makeRoom(2);
  const g = room.g;
  own(room, 'p0', 1); own(room, 'p1', 3);
  expectOk(act(room, 'p0', { type: 'proposeTrade', to: 'p1', give: { cash: 100, props: [1] }, get: { props: [3] } }), 'Angebot');
  expectFail(act(room, 'p0', { type: 'proposeTrade', to: 'p1', give: { cash: 1 }, get: {} }), 'Zweites Angebot');
  expectFail(act(room, 'p0', { type: 'acceptTrade' }), 'Absender kann nicht selbst annehmen');
  expectOk(act(room, 'p1', { type: 'acceptTrade' }), 'Annehmen');
  assert(g.props[1].owner === 'p1' && g.props[3].owner === 'p0', 'Grundstücke getauscht');
  assert(g.money.p0 === 1400 && g.money.p1 === 1600, 'Geld getauscht');
  assert(!g.trade, 'Angebot erledigt');

  own(room, 'p0', 6, { houses: 1 }); own(room, 'p0', 8); own(room, 'p0', 9);
  expectFail(act(room, 'p0', { type: 'proposeTrade', to: 'p1', give: { props: [8] }, get: { cash: 10 } }), 'Handel mit Gebäuden in der Farbgruppe');
  expectFail(act(room, 'p0', { type: 'proposeTrade', to: 'p1', give: { cash: 99999 }, get: {} }), 'Mehr Geld als vorhanden');
  expectOk(act(room, 'p0', { type: 'proposeTrade', to: 'p1', give: { cash: 10 }, get: {} }), 'Neues Angebot');
  expectOk(act(room, 'p1', { type: 'cancelTrade' }), 'Ablehnen');
  assert(!g.trade, 'Abgelehnt');
}

// 8. Schulden & Pleite ------------------------------------------------------------------
{
  const room = makeRoom(2);
  const g = room.g;
  own(room, 'p1', 39, { houses: 0 }); own(room, 'p1', 37, { houses: 5 });
  own(room, 'p0', 1); own(room, 'p0', 3);
  g.money.p0 = 100;
  g.pos.p0 = 30;
  roll(room, 'p0', 3, 4); // Feld 37 Talerplatz mit Hotel: 1500 Miete
  assert(g.phase === 'debt' && g.debts.length === 1, 'Schuld entsteht');
  expectFail(act(room, 'p0', { type: 'endTurn' }), 'Zug beenden trotz Schulden');
  expectOk(act(room, 'p0', { type: 'mortgage', pos: 1 }), 'Beleihen hilft nicht genug');
  assert(g.phase === 'debt', 'Immer noch verschuldet');
  expectOk(act(room, 'p0', { type: 'resign' }), 'Aufgeben');
  assert(g.bankrupt.p0 && g.phase === 'over' && g.winner === 'p1', 'Gegner gewinnt');
  assert(g.props[1].owner === 'p1' && g.props[3].owner === 'p1', 'Besitz geht an Gläubiger');
  assert(g.money.p1 >= 1500 + 100, 'Gläubiger erhält das Restgeld');
}
{
  const room = makeRoom(3);
  const g = room.g;
  own(room, 'p1', 37, { houses: 1 });
  own(room, 'p0', 31); own(room, 'p0', 32);
  g.money.p0 = 20;
  g.pos.p0 = 30;
  roll(room, 'p0', 3, 4);
  assert(g.phase === 'debt' && g.debts[0].amount === 175, 'Schuld 175');
  act(room, 'p0', { type: 'mortgage', pos: 31 });
  assert(g.phase === 'debt' || g.phase === 'end', 'Zwischenstand');
  act(room, 'p0', { type: 'mortgage', pos: 32 });
  assert(g.phase === 'end' && g.debts.length === 0, `Schuld beglichen (Phase ${g.phase})`);
  assert(g.money.p1 === 1675, 'Gläubiger bekommt 175');
}
{
  const room = makeRoom(3);
  const g = room.g;
  own(room, 'p0', 1); own(room, 'p0', 3);
  g.money.p0 = 10;
  g.pos.p0 = 1;
  roll(room, 'p0', 1, 2); // Feld 4 Einkommensteuer 200
  assert(g.phase === 'debt', 'Steuerschuld');
  expectOk(act(room, 'p0', { type: 'resign' }), 'Aufgeben');
  assert(g.bankrupt.p0 && g.phase === 'auction', 'Besitz der Bank wird versteigert');
  assert(g.auction.pos === 1, 'Erste Auktion');
  act(room, 'p1', { type: 'bid', amount: 20 });
  act(room, 'p2', { type: 'passBid' });
  assert(g.props[1] && g.props[1].owner === 'p1', 'Ersteigert');
  assert(g.phase === 'auction' && g.auction.pos === 3, 'Zweite Auktion folgt');
  act(room, 'p1', { type: 'passBid' });
  act(room, 'p2', { type: 'passBid' });
  assert(g.phase === 'roll' && E.curId(room) === 'p1', 'Danach ist die nächste Person dran');
}

// 9. Karten -------------------------------------------------------------------------------
{
  const room = makeRoom(3);
  const g = room.g;
  g.decks.chance.draw = [8]; // Freikarte
  g.pos.p0 = 4;
  roll(room, 'p0', 1, 2); // Feld 7 Ereignis
  assert(g.jailCards.p0.length === 1 && g.jailCards.p0[0] === 'chance', 'Freikarte behalten');
  assert(g.phase === 'end', 'Weiter im Ablauf');

  const r2 = makeRoom(3);
  r2.g.decks.chance.draw = [14]; // Vorsitzender: jedem 50 zahlen
  r2.g.pos.p0 = 4;
  roll(r2, 'p0', 1, 2);
  assert(r2.g.money.p0 === 1400 && r2.g.money.p1 === 1550 && r2.g.money.p2 === 1550, 'An alle zahlen');

  const r3 = makeRoom(3);
  r3.g.decks.community.draw = [8]; // Geburtstag: jeder zahlt 10
  r3.g.pos.p0 = 0;
  roll(r3, 'p0', 1, 1); // Feld 2
  assert(r3.g.money.p0 === 1520 && r3.g.money.p1 === 1490, 'Von allen kassieren');

  const r4 = makeRoom(3);
  own(r4, 'p0', 1, { houses: 2 }); own(r4, 'p0', 3, { houses: 5 });
  r4.g.decks.chance.draw = [11]; // Generalreparatur 25/100
  r4.g.pos.p0 = 4;
  roll(r4, 'p0', 1, 2);
  assert(r4.g.money.p0 === 1500 - 50 - 100, 'Reparaturkosten');

  const r5 = makeRoom(3);
  r5.g.decks.chance.draw = [4]; // nächster Bahnhof, doppelte Miete
  own(r5, 'p1', 15);
  r5.g.pos.p0 = 4;
  roll(r5, 'p0', 1, 2); // Feld 7 -> Bahnhof 15
  assert(r5.g.pos.p0 === 15 && r5.g.money.p0 === 1450, 'Doppelte Bahnhofsmiete (2 x 25)');

  const r6 = makeRoom(3);
  r6.g.decks.chance.draw = [1]; // Rücke vor bis Geldspeicher
  r6.g.pos.p0 = 4;
  roll(r6, 'p0', 1, 2);
  assert(r6.g.pos.p0 === 39 && r6.g.phase === 'buy', 'Vorrücken bis Geldspeicher, Kauf möglich');

  const r7 = makeRoom(3);
  r7.g.decks.chance.draw = [9]; // 3 Felder zurück: 36 -> 33 (Gemeinschaftsfeld!)
  r7.g.decks.community.draw = [1]; // Bankirrtum +200
  r7.g.pos.p0 = 33;
  roll(r7, 'p0', 1, 2); // 36 Ereignis -> 33 Gemeinschaft -> +200
  assert(r7.g.pos.p0 === 33 && r7.g.money.p0 === 1700, 'Zurück ins nächste Kartenfeld, Karte wird gezogen');
}

// 10. Sieg -----------------------------------------------------------------------------------
{
  const room = makeRoom(2);
  act(room, 'p0', { type: 'resign' });
  assert(room.g.phase === 'over' && room.g.winner === 'p1' && room.phase === 'gameover', 'Aufgabe beendet 2er-Partie');
}


// 11. Hausregeln ---------------------------------------------------------------------------
function ruleRoom(n, rules) {
  const room = makeRoom(n);
  room.settings.rules = rules;
  return room;
}
{
  // Frei-Parken-Jackpot: Steuer (200 auf Feld 4) landet in der Mitte, Landen auf Feld 20 kassiert.
  const room = ruleRoom(2, { freeParking: true });
  const g = room.g;
  roll(room, 'p0', 1, 3); // Feld 4 Einkommensteuer
  assert(g.money.p0 === 1300 && g.pot === 200, `Steuer im Jackpot (Pot ${g.pot})`);
  act(room, 'p0', { type: 'endTurn' });
  g.pos.p1 = 14;
  roll(room, 'p1', 2, 4); // Feld 20 Frei Parken
  assert(g.pos.p1 === 20 && g.money.p1 === 1700 && g.pot === 0, 'Jackpot kassiert');
  // Ohne Regel: Steuer verschwindet
  const r2 = ruleRoom(2, {});
  roll(r2, 'p0', 1, 3);
  assert(r2.g.pot === 0, 'Ohne Regel kein Jackpot');
}
{
  // Doppeltes Gehalt beim Landen auf LOS
  const room = ruleRoom(2, { doubleGo: true });
  room.g.pos.p0 = 35;
  roll(room, 'p0', 2, 3);
  assert(room.g.pos.p0 === 0 && room.g.money.p0 === 1900, `Doppeltes LOS-Gehalt (${room.g.money.p0})`);
  const r2 = ruleRoom(2, {});
  r2.g.pos.p0 = 35;
  roll(r2, 'p0', 2, 3);
  assert(r2.g.money.p0 === 1700, 'Normales LOS-Gehalt');
}
{
  // Keine Auktion: Grundstück bleibt frei
  const room = ruleRoom(2, { auction: false });
  roll(room, 'p0', 1, 2);
  expectOk(act(room, 'p0', { type: 'declineBuy' }), 'Nicht kaufen');
  assert(!room.g.auction && !room.g.props[3] && room.g.phase === 'end', 'Ohne Auktion bleibt es frei');
}
{
  // Keine Miete im Knast
  const room = ruleRoom(2, { jailRent: false });
  own(room, 'p1', 3);
  room.g.inJail.p1 = true;
  roll(room, 'p0', 1, 2);
  assert(room.g.money.p0 === 1500 && room.g.money.p1 === 1500, 'Im Knast keine Miete');
}
{
  // Ungleichmäßig bauen erlaubt
  const room = ruleRoom(2, { evenBuild: false });
  own(room, 'p0', 1); own(room, 'p0', 3, { houses: 1 });
  expectOk(act(room, 'p0', { type: 'build', pos: 3 }), 'Ungleichmäßig bauen');
  const r2 = ruleRoom(2, {});
  own(r2, 'p0', 1); own(r2, 'p0', 3, { houses: 1 });
  expectFail(act(r2, 'p0', { type: 'build', pos: 3 }), 'Standard: gleichmäßig');
}

console.log('OK: Engine-Regeln (Miete, Knast, Auktion, Bauen, Hypothek, Handel, Pleite, Karten).');
