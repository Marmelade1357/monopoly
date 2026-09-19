// Ereignis- und Gemeinschaftskarten im Entenhausen-Look.
// Aktionstypen: collect, pay, collectEach, payEach, advance, nearestStation,
// nearestUtility, back, jail, jailFree, repairs.

const chance = [
  { text: 'Gundel Gaukeley zaubert dich direkt auf LOS. Ziehe 200 Taler ein.', a: { t: 'advance', pos: 0 } },
  { text: 'Rücke vor bis zum Geldspeicher.', a: { t: 'advance', pos: 39 } },
  { text: 'Rücke vor zu Gustavs Glückswiese. Kommst du an LOS vorbei, ziehe 200 Taler ein.', a: { t: 'advance', pos: 16 } },
  { text: 'Rücke vor zum Fieselschweif-Lager. Kommst du an LOS vorbei, ziehe 200 Taler ein.', a: { t: 'advance', pos: 11 } },
  { text: 'Rücke vor zum nächsten Bahnhof. Hat er einen Besitzer, zahle die doppelte Miete.', a: { t: 'nearestStation' } },
  { text: 'Rücke vor zum nächsten Bahnhof. Hat er einen Besitzer, zahle die doppelte Miete.', a: { t: 'nearestStation' } },
  { text: 'Rücke vor zum nächsten Werk. Hat es einen Besitzer, würfle und zahle das 10-fache der Augenzahl.', a: { t: 'nearestUtility' } },
  { text: 'Onkel Dagobert zahlt dir eine Dividende von 50 Taler.', a: { t: 'collect', n: 50 } },
  { text: 'Du kommst aus dem Knast frei. Behalte diese Karte, bis du sie brauchst.', a: { t: 'jailFree' } },
  { text: 'Gehe 3 Felder zurück.', a: { t: 'back', n: 3 } },
  { text: 'Die Panzerknacker haben dich erwischt! Gehe direkt in den Knast, ohne über LOS zu ziehen.', a: { t: 'jail' } },
  { text: 'Generalreparatur an deinen Häusern: 25 Taler pro Haus, 100 Taler pro Hotel.', a: { t: 'repairs', house: 25, hotel: 100 } },
  { text: 'Strafzettel von Wachtmeister Quack: zahle 15 Taler.', a: { t: 'pay', n: 15 } },
  { text: 'Ausflug mit dem Enten-Express: rücke vor bis zum Enten-Express. Kommst du an LOS vorbei, ziehe 200 Taler ein.', a: { t: 'advance', pos: 5 } },
  { text: 'Du wirst zum Vorsitzenden der Fieselschweife gewählt: zahle jedem Mitspieler 50 Taler.', a: { t: 'payEach', n: 50 } },
  { text: 'Dein Baudarlehen wird fällig: ziehe 150 Taler ein.', a: { t: 'collect', n: 150 } },
];

const community = [
  { text: 'Rücke vor bis LOS. Ziehe 200 Taler ein.', a: { t: 'advance', pos: 0 } },
  { text: 'Bankirrtum zu deinen Gunsten: ziehe 200 Taler ein.', a: { t: 'collect', n: 200 } },
  { text: 'Schnabelkorrektur beim Zahnarzt: zahle 50 Taler.', a: { t: 'pay', n: 50 } },
  { text: 'Du verkaufst Aktien der Duck-Werke: ziehe 50 Taler ein.', a: { t: 'collect', n: 50 } },
  { text: 'Du kommst aus dem Knast frei. Behalte diese Karte, bis du sie brauchst.', a: { t: 'jailFree' } },
  { text: 'Gehe direkt in den Knast! Ziehe nicht über LOS und kassiere nichts.', a: { t: 'jail' } },
  { text: 'Urlaubsgeld: ziehe 100 Taler ein.', a: { t: 'collect', n: 100 } },
  { text: 'Steuerrückerstattung: ziehe 20 Taler ein.', a: { t: 'collect', n: 20 } },
  { text: 'Du hast Geburtstag: jeder Mitspieler schenkt dir 10 Taler.', a: { t: 'collectEach', n: 10 } },
  { text: 'Deine Lebensversicherung wird fällig: ziehe 100 Taler ein.', a: { t: 'collect', n: 100 } },
  { text: 'Krankenhausgebühren: zahle 100 Taler.', a: { t: 'pay', n: 100 } },
  { text: 'Ausflugskasse für Tick, Trick und Track: zahle 50 Taler.', a: { t: 'pay', n: 50 } },
  { text: 'Beratungshonorar: ziehe 25 Taler ein.', a: { t: 'collect', n: 25 } },
  { text: 'Straßenreparatur: zahle 40 Taler pro Haus und 115 Taler pro Hotel.', a: { t: 'repairs', house: 40, hotel: 115 } },
  { text: 'Du gewinnst den Schönheitswettbewerb im Ententeich: ziehe 10 Taler ein.', a: { t: 'collect', n: 10 } },
  { text: 'Erbschaft von Oma Duck: ziehe 100 Taler ein.', a: { t: 'collect', n: 100 } },
];

module.exports = {
  chance,
  community,
  LABEL: { chance: 'Ereigniskarte', community: 'Gemeinschaftskarte' },
};
