import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
// legacy-design.css is the full MediaKit design system lifted from the
// old SPA (~1k lines: Tokyo-Night palette, panes, nav items, transport,
// album rows, lyrics, fullscreen visualizer, theme presets, ...). New
// SPA components adopt the same class vocabulary so the visual identity
// is consistent across the audio port. main.css holds only what is
// genuinely new (login layout adjustments, video views, etc.).
import "./legacy-design.css";
import "./main.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("missing #root element");
}
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
