// The names in the game. This is the public edition, with made-up names throughout.
// js/names-crew.js, when it is there, is loaded after this file and replaces them for
// the crew version; it is kept out of the published repository (.gitignore).
window.DeepRun = window.DeepRun || {};
(() => {
const W = 0xf2f0ea; // ship white
DeepRun.NAMES = {
  edition: "public",
  rov: "BUBBLE 6000", // the ROV you fly
  institute: "BUBBLELAB", // on the AUV and the developer's shirt, in radio calls
  sub: "PEEKABOO", // the manned submersible with one big window
  auv: "Glimmer", // the AUV that photographs the seafloor
  laptop: "laptop", // what the developer carries
  runner: { shirt: 0x2e8b57, text: "</>", cap: 0x1b1b1b, curls: false, laptop: 0x5a5f66, logo: false },
  // the research fleet, one of them as a wreck: length (m), colours, lettering, home port,
  // icon in the dive report; NORDLICHT has a helicopter deck, MONDSCHEIN big lettering
  fleet: [
    { name: "MONDSCHEIN", len: 116, hull: 0x2b2f4a, house: W, funnel: 0xe8c547, band: 0x2b2f4a, crane: 0xe8c547, big: "RESEARCH", port: "EMDEN", icon: "🌙" },
    { name: "NORDLICHT", len: 118, hull: 0x1f7a5a, house: W, funnel: W, band: 0x1f7a5a, crane: 0xf2b705, port: "BREMERHAVEN", helideck: true, icon: "🌌" },
    { name: "KOMET", len: 98, hull: 0x5b2d6b, house: W, funnel: 0x5b2d6b, band: W, crane: 0xf2b705, port: "HAMBURG", icon: "☄️" },
    { name: "LOTTE SEEFELD", len: 95, hull: 0x2f6f8f, house: W, funnel: W, band: 0x2f6f8f, crane: 0xf2b705, port: "ROSTOCK", icon: "⚓" },
    { name: "VEGA", len: 55, hull: 0x8a3b1f, house: W, funnel: W, band: 0x8a3b1f, crane: 0xf2b705, port: "KIEL", icon: "✨" },
    { name: "HERING", len: 55, hull: 0x5a6a78, house: W, funnel: W, band: 0x5a6a78, crane: 0xf2b705, port: "HELGOLAND", icon: "🐟" },
  ],
};
})();
