// Spectrum colour themes, extracted from app.jsx so overlays.jsx (the Tweaks
// theme picker) can import them without an app<->overlays import cycle.

export const VIZ_THEMES = {
  maneki: { name: "Maneki", viz: { lo: "#bcd47a", mid: "#e6c065", hi: "#f08aa6" } },
  fire:   { name: "Fire",   viz: { lo: "#ffd24a", mid: "#ff7a1a", hi: "#e02020" } },
  ice:    { name: "Ice",    viz: { lo: "#7fe8ff", mid: "#4aa8f0", hi: "#9a7af0" } },
  aurora: { name: "Aurora", viz: { lo: "#7cffb2", mid: "#3cc6d8", hi: "#c86cf0" } },
  sunset: { name: "Sunset", viz: { lo: "#ffe08a", mid: "#ff9e64", hi: "#ff5a8a" } },
  mono:   { name: "Mono",   viz: { lo: "#6b7280", mid: "#c4c8ce", hi: "#ffffff" } },
};
