// Duration formatting helpers, extracted from app.jsx so files that only need
// fmtDur/parseDur (chrome.jsx, the panes) can import them without pulling in
// App — which would create an app<->chrome import cycle.

export function parseDur(s) {
  if (!s) return 0;
  const [m, sec] = s.split(":").map(Number);
  return m * 60 + sec;
}

export function fmtDur(s) {
  if (!s || !isFinite(s)) return "00:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}
