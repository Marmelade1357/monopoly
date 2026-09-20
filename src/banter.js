// Sprüche der Bots: kurze Kommentare passend zu Charakter und Ereignis.
// Ausgabe: Logzeile plus g.say (der Client zeigt daraus eine Sprechblase).

// Situationen: rentIn (Bot kassiert), rentOut (Bot zahlt viel), buy, monopoly, jail, bust, win, tradeYes, laugh (Bot beobachtet fremde Miete)
const BY_PERSONA = {
  bold: {
    rentIn: ['Danke fürs Vorbeischauen, {n}! Das Wechselgeld behalte ich.', 'Kasse klingelt – {amt} für mich!', 'Miete ist Ehrensache, {n}.'],
    rentOut: ['Autsch! {amt} … das holt sich {n} nicht so schnell zurück.', 'Na gut, {amt}. Ich bin ja großzügig.'],
    buy: ['{sq} gehört jetzt mir – und bald noch mehr!', 'Her mit {sq}, Fortuna liebt die Mutigen.'],
    monopoly: ['Monopol! Ab jetzt wird gebaut, bis der Boden bebt!', 'Alle Felder der Farbe gehören mir. Mahlzeit!'],
    jail: ['Knast? Ich bin in fünf Minuten wieder draußen.', 'Ein kleiner Urlaub schadet nie.'],
    bust: ['Das Glück hat mich verlassen … aber ich komme wieder!', 'Pleite. Schade, es hat Spaß gemacht.'],
    win: ['Und wieder einmal: Gewinner. Wer hätte das gedacht!', 'Entenhausen gehört mir!'],
    tradeYes: ['Abgemacht, {n}!'],
    laugh: ['Haha, {n}, das tut weh!', 'Das war teuer, {n}, oder?'],
  },
  careful: {
    rentIn: ['Danke, {n}. Sparsamkeit zahlt sich aus.', '{amt} – ordentlich verbucht.', 'Ich notiere: Miete erhalten.'],
    rentOut: ['{amt}?! Das steht nicht in meinem Budget …', 'Ich hätte das Feld meiden sollen.'],
    buy: ['Ein solides Investment: {sq}.', 'Sorgfältig geprüft und gekauft: {sq}.'],
    monopoly: ['Das Set ist komplett – jetzt bloß nicht übereilen.', 'Vollständig. Und trotzdem wird nur vorsichtig gebaut.'],
    jail: ['Immerhin bin ich hier sicher.', 'Das habe ich nicht auf dem Zettel gehabt.'],
    bust: ['Das war nicht kalkuliert …', 'Ich hätte mehr sparen sollen.'],
    win: ['Ordentlich geplant, ordentlich gewonnen.', 'Geduld zahlt sich aus.'],
    tradeYes: ['Ein fairer Handel, {n}.'],
    laugh: ['Das hätte ich Ihnen vorher sagen können, {n}.', 'Tja, {n}, Vorsicht ist besser.'],
  },
  trader: {
    rentIn: ['Geschäft ist Geschäft, {n} – {amt}, bitte.', 'Das Geld arbeitet für mich!', 'Danke, {n}. Ich rechne das gegen unser nächstes Geschäft.'],
    rentOut: ['Verluste gehören dazu, {amt} sind nur eine Investition.', 'Hm, {amt}. Da müssen wir nachverhandeln.'],
    buy: ['{sq}: ein guter Tauschartikel.', 'Neu im Portfolio: {sq}!'],
    monopoly: ['Set komplett! Wer will mir jetzt was verkaufen? Niemand? Dachte ich mir.', 'Monopol – der beste Deal des Tages.'],
    jail: ['Sogar hier drin lässt sich verhandeln.', 'Ich zahle Kaution – nein, warte, doch nicht.'],
    bust: ['Alle Geschäfte enden irgendwann …', 'Das Portfolio ist leider aufgelöst.'],
    win: ['Bestes Geschäft: das ganze Spiel!', 'Alles gekauft, alles gehört mir.'],
    tradeYes: ['Deal, {n}! Auf gute Zusammenarbeit.'],
    laugh: ['Miete ist wie Steuern – nur fairer, {n}.', 'Da hätte man vorher verhandeln müssen, {n}.'],
  },
  balanced: {
    rentIn: ['Danke, {n}!', '{amt} – gern genommen.'],
    rentOut: ['Das tut weh: {amt}.', 'Na, das war teuer.'],
    buy: ['{sq} ist meins!', 'Gekauft: {sq}.'],
    monopoly: ['Das ganze Farbset gehört mir!'],
    jail: ['Ab in den Knast …', 'Kurze Pause im Knast.'],
    bust: ['Ich bin raus. Viel Erfolg euch!'],
    win: ['Gewonnen! Gut gespielt allerseits.'],
    tradeYes: ['Einverstanden, {n}.'],
    laugh: ['Autsch, {n}!'],
  },
};

const BY_NAME = {
  Gustav: {
    rentIn: ['Glück muss man haben, {n}! Und ich habe es immer.', 'Das nennt man Glückskind, {n}!'],
    rentOut: ['Ausnahmsweise hat mein Glück Pause.'],
    laugh: ['Gustav lacht über deine Miete, {n}!'],
    buy: ['Wieder ein Volltreffer: {sq}.'],
    win: ['Natürlich gewinne ich. Ich bin Gustav Gans!'],
  },
  Klaas: {
    rentIn: ['Zwei Taler weniger für dich, {amt} mehr für mich – so geht Geiz, {n}.'],
    rentOut: ['{amt}?! Das ist Raub!'],
    buy: ['Für {sq} habe ich gefeilscht – nur im Kopf.'],
  },
  Karlo: {
    rentIn: ['Das nenne ich fairen Tausch, {n}: dein Geld gegen meine Straße.'],
    tradeYes: ['Handschlag, {n} – Karlo hält Wort.'],
  },
  Gundel: {
    rentIn: ['Ein kleiner Zauber, {n}, und schon klingelt die Kasse.'],
    buy: ['{sq} steht jetzt unter meinem Bann.'],
    jail: ['Ein Zauber könnte mich hier rausholen … später.'],
  },
  'Düsentrieb': {
    rentIn: ['Laut meiner Berechnung schuldest du mir {amt}, {n}.'],
    buy: ['{sq}: Baupläne liegen schon in der Schublade.'],
    monopoly: ['Mein neuestes Patent: das Monopol-Set!'],
  },
  Panzerknacker: {
    rentIn: ['Ha! {amt} – und niemand hat einen Tresor knacken müssen.', 'Beute gemacht, {n}!'],
    jail: ['Der Knast? Da kenne ich mich aus – Nummer 176-671.'],
    laugh: ['Hehe, {n}, das war fast schon ein Überfall!'],
  },
};

const COOLDOWN_MS = 3500;
const ALWAYS = new Set(['monopoly', 'bust', 'win']);
const CHANCE = { rentIn: 0.5, rentOut: 0.5, buy: 0.22, monopoly: 1, jail: 0.5, bust: 1, win: 1, tradeYes: 0.7, laugh: 0.3 };

function pick(list) { return list[Math.floor(Math.random() * list.length)]; }
function fill(text, vars) { return text.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m)); }

// room: Raum; botId: wer spricht; kind: Situation; vars: { n, amt, sq }
function say(room, botId, kind, vars) {
  const g = room.g;
  if (!g || !room.settings || room.settings.banter === false) return false;
  const p = (room.players || []).find((x) => x.id === botId);
  if (!p || !p.isBot || g.bankrupt[botId] && kind !== 'bust') return false;
  const now = Date.now();
  if (!ALWAYS.has(kind) && (g.sayAt && now - g.sayAt < COOLDOWN_MS)) return false;
  if (Math.random() > (CHANCE[kind] || 0.3)) return false;
  const persona = BY_PERSONA[p.persona] || BY_PERSONA.balanced;
  const named = BY_NAME[p.name] && BY_NAME[p.name][kind] ? BY_NAME[p.name][kind] : [];
  const pool = (persona[kind] || []).concat(named, named); // Namens-Sprüche doppelt gewichten
  if (!pool.length) return false;
  const text = fill(pick(pool), vars || {});
  g.say = { seq: ((g.say && g.say.seq) || 0) + 1, id: botId, text };
  g.sayAt = now;
  room.logs.push({ text: `💬 ${p.name}: „${text}“`, at: now });
  if (room.logs.length > 300) room.logs.shift();
  return true;
}

// Ein zufälliger Bot (nicht beteiligt) kommentiert ein Ereignis.
function onlooker(room, kind, vars, exclude) {
  const g = room.g;
  const bots = (room.players || []).filter((p) => p.isBot && !g.bankrupt[p.id] && !(exclude || []).includes(p.id));
  if (!bots.length) return false;
  return say(room, pick(bots).id, kind, vars);
}

module.exports = { say, onlooker };
