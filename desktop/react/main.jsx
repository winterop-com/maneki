// Entry point. Vite compiles the JSX + bundles the module graph; the React
// app mounts here. Importing App transitively pulls in the wiring layer
// (_wiring.jsx) and every controller, so there's nothing to register on
// window — the old MK_* global handshake is gone.
import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";

import "video.js/dist/video-js.css";
import "./maneki.css";
import "./desktop-overrides.css";

import { App } from "./src/app.jsx";

// HashRouter (not BrowserRouter): hash routes (#/library/...) resolve
// identically under HTTP (FastAPI mount), Electron file://, and Tauri's
// custom protocol with zero server-side SPA-fallback config.
createRoot(document.getElementById("root")).render(
  React.createElement(HashRouter, null, React.createElement(App)),
);
