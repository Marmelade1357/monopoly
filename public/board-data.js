// Spielbrett-Daten für "Monopoly – Entenhausen".
// UMD-Modul: wird vom Server (require) UND vom Browser (<script>) genutzt,
// damit Namen, Preise und Mieten nur an einer Stelle gepflegt werden.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BOARD = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const GROUPS = {
    brown:     { name: 'Braun',      color: '#8b5a2b', houseCost: 50 },
    lightblue: { name: 'Hellblau',   color: '#8fd3f4', houseCost: 50 },
    pink:      { name: 'Pink',       color: '#e0459c', houseCost: 100 },
    orange:    { name: 'Orange',     color: '#f39c34', houseCost: 100 },
    red:       { name: 'Rot',        color: '#e0342f', houseCost: 150 },
    yellow:    { name: 'Gelb',       color: '#f5d90a', houseCost: 150 },
    green:     { name: 'Grün',       color: '#1fa855', houseCost: 200 },
    darkblue:  { name: 'Dunkelblau', color: '#1e4fb5', houseCost: 200 },
    station:   { name: 'Bahnhöfe',   color: '#333333', houseCost: 0 },
    utility:   { name: 'Werke',      color: '#888888', houseCost: 0 },
  };

  const P = (pos, name, group, price, rent) => ({ pos, type: 'property', name, group, price, rent });
  const ST = (pos, name) => ({ pos, type: 'station', name, group: 'station', price: 200, rent: [25, 50, 100, 200] });
  const UT = (pos, name, icon) => ({ pos, type: 'utility', name, group: 'utility', price: 150, icon });

  const SQUARES = [
    { pos: 0, type: 'go', name: 'LOS' },
    P(1, 'Bruchbude', 'brown', 60, [2, 10, 30, 90, 160, 250]),
    { pos: 2, type: 'community', name: 'Tick, Trick & Track' },
    P(3, 'Ententeich', 'brown', 60, [4, 20, 60, 180, 320, 450]),
    { pos: 4, type: 'tax', name: 'Einkommensteuer', amount: 200 },
    ST(5, 'Enten-Express'),
    P(6, 'Gänsemarkt', 'lightblue', 100, [6, 30, 90, 270, 400, 550]),
    { pos: 7, type: 'chance', name: 'Gundels Zauberei' },
    P(8, 'Federstraße', 'lightblue', 100, [6, 30, 90, 270, 400, 550]),
    P(9, 'Kükenweg', 'lightblue', 120, [8, 40, 100, 300, 450, 600]),
    { pos: 10, type: 'jail', name: 'Panzerknacker-Knast' },
    P(11, 'Fieselschweif-Lager', 'pink', 140, [10, 50, 150, 450, 625, 750]),
    UT(12, 'Düsentriebs Kraftwerk', '💡'),
    P(13, 'Erfinderallee', 'pink', 140, [10, 50, 150, 450, 625, 750]),
    P(14, 'Schnatterstraße', 'pink', 160, [12, 60, 180, 500, 700, 900]),
    ST(15, 'Gänse-Bahn'),
    P(16, 'Gustavs Glückswiese', 'orange', 180, [14, 70, 200, 550, 750, 950]),
    { pos: 17, type: 'community', name: 'Tick, Trick & Track' },
    P(18, 'Karlos Schrottplatz', 'orange', 180, [14, 70, 200, 550, 750, 950]),
    P(19, 'Klevers Kai', 'orange', 200, [16, 80, 220, 600, 800, 1000]),
    { pos: 20, type: 'parking', name: 'Frei Parken' },
    P(21, 'Rathausplatz', 'red', 220, [18, 90, 250, 700, 875, 1050]),
    { pos: 22, type: 'chance', name: 'Gundels Zauberei' },
    P(23, 'Bürgermeisterallee', 'red', 220, [18, 90, 250, 700, 875, 1050]),
    P(24, 'Entenmarkt', 'red', 240, [20, 100, 300, 750, 925, 1100]),
    ST(25, 'Schwanen-Linie'),
    P(26, 'Quackstraße', 'yellow', 260, [22, 110, 330, 800, 975, 1150]),
    P(27, 'Kaufhaus-Passage', 'yellow', 260, [22, 110, 330, 800, 975, 1150]),
    UT(28, 'Wasserturm', '🚰'),
    P(29, 'Erpelring', 'yellow', 280, [24, 120, 360, 850, 1025, 1200]),
    { pos: 30, type: 'gotojail', name: 'Gehe in den Knast' },
    P(31, 'Bankenviertel', 'green', 300, [26, 130, 390, 900, 1100, 1275]),
    P(32, 'Goldgräberstraße', 'green', 300, [26, 130, 390, 900, 1100, 1275]),
    { pos: 33, type: 'community', name: 'Tick, Trick & Track' },
    P(34, 'Klondike-Boulevard', 'green', 320, [28, 150, 450, 1000, 1200, 1400]),
    ST(35, 'Erpel-Bahn'),
    { pos: 36, type: 'chance', name: 'Gundels Zauberei' },
    P(37, 'Talerplatz', 'darkblue', 350, [35, 175, 500, 1100, 1300, 1500]),
    { pos: 38, type: 'tax', name: 'Panzerknacker-Raubzug', amount: 100 },
    P(39, 'Geldspeicher', 'darkblue', 400, [50, 200, 600, 1400, 1700, 2000]),
  ];

  const GROUP_POSITIONS = {};
  SQUARES.forEach((s) => {
    if (s.group) (GROUP_POSITIONS[s.group] = GROUP_POSITIONS[s.group] || []).push(s.pos);
  });

  return { GROUPS, SQUARES, GROUP_POSITIONS, CURRENCY: '₮' };
});
