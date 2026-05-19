// Login view + miscellaneous small components used across the app.

const { useEffect: useEff_v, useState: useSt_v, useRef: useRef_v } = React;

function LoginView({ onConnect, themeMode, busyLabel }) {
  // sameOrigin === true when the SPA is being served by `mediakit serve
  // --ui` on the same origin as the API. Detected via /capabilities; if
  // that responds with our shape, hide the URL field entirely and post
  // to `<origin>/audio` (the Subsonic mount inside the unified server).
  //
  // In the desktop wrappers (Tauri / Electron) the SPA is loaded as
  // file://, so window.location.origin won't talk to a server at all.
  // We fall back to probing http://127.0.0.1:8765/capabilities so a
  // user running `mediakit serve` locally gets the URL field hidden
  // and zero typing required.
  //
  // sameOrigin / localServer === null while probing, then the probe
  // result; either true means "found a local MediaKit, hide URL".
  const [autoDetected, setAutoDetected] = useSt_v(null);  // null | "same-origin" | "localhost" | "none"
  const [detectedBase, setDetectedBase] = useSt_v("");
  // Desktop = Tauri or Electron wrapper. Can't rely on
  // window.location.protocol because Tauri 2 serves the SPA from
  // http://tauri.localhost/ (not file:// or tauri://) so a
  // protocol check would say "browser". Check for the runtime
  // globals instead. index.html sets body.dataset.shell from the
  // same signals, so this stays in sync with the CSS rules.
  const isDesktop = !!window.__TAURI__ || (navigator.userAgent || "").toLowerCase().includes("electron/");
  // Just the base URL - no /audio mount suffix. The wiring layer
  // probes /capabilities on submit and appends /audio itself when
  // it confirms the server is mediakit. For 3rd-party Subsonic
  // servers (Navidrome, Airsonic) the URL stays as-is.
  const [url, setUrl] = useSt_v(isDesktop ? "http://127.0.0.1:8765" : window.location.origin);
  const [user, setUser] = useSt_v("admin");
  const [pw, setPw] = useSt_v("");
  const [busy, setBusy] = useSt_v(false);
  const [err, setErr] = useSt_v("");

  useEff_v(() => {
    let cancelled = false;

    async function probe(origin) {
      try {
        const resp = await fetch(origin + "/capabilities", { cache: "no-store" });
        if (!resp.ok) return null;
        const caps = await resp.json();
        if (caps && caps.server === "mediakit" && caps.endpoints?.audio_subsonic) {
          return { caps, origin };
        }
      } catch (_e) {
        // ignore - probe failed
      }
      return null;
    }

    (async () => {
      // 1. Same-origin probe (works when SPA is served by `mediakit
      //    serve --ui`). Skipped on file:// since same-origin requests
      //    against file:// can't reach any HTTP server.
      let hit = null;
      let kind = "none";
      if (!isDesktop) {
        hit = await probe(window.location.origin);
        if (hit) kind = "same-origin";
      }
      // 2. Localhost fallback - the typical desktop-wrapper case where
      //    the user has `mediakit serve` running on the default port.
      if (!hit) {
        hit = await probe("http://127.0.0.1:8765");
        if (hit) kind = "localhost";
      }
      if (cancelled) return;
      if (hit) {
        // Leave the URL as just the origin - the wiring layer appends
        // /audio at submit time, so the user never sees the mount
        // path. We still store the detected origin so the help text
        // can show what we found.
        setUrl(hit.origin);
        setDetectedBase(hit.origin);
        setAutoDetected(kind);
      } else {
        setAutoDetected("none");
      }
    })();

    return () => { cancelled = true; };
  }, [isDesktop]);

  const submit = (e) => {
    e.preventDefault();
    setErr("");
    if (!url.trim() || !user.trim() || !pw) {
      setErr("Username and password are required.");
      return;
    }
    setBusy(true);
    Promise.resolve()
      .then(() => onConnect({ url, user, pass: pw }))
      .catch((e) => setErr(String(e?.message || e)))
      .finally(() => setBusy(false));
  };

  const localFound = autoDetected === "same-origin" || autoDetected === "localhost";
  return (
    <div className="mk-login-shell">
      <div className="mk-login-brand">
        <div className="mk-login-logo">MediaKit</div>
        <div className="mk-login-tag">desktop · v{document.querySelector('meta[name="mk-version"]')?.content || "?"}</div>
      </div>
      {/* noValidate: our custom check above ("Username and password
          are required") is the source of truth. Tauri's WKWebView
          and Electron's Chromium both occasionally surface obscure
          HTML5 validation errors (e.g. "The string did not match the
          expected pattern") from autofill / password-manager hints
          when no pattern attribute is set; switching off native
          validation removes that whole class of misleading errors. */}
      <form className="mk-login-card" onSubmit={submit} noValidate>
        <div className="mk-login-title">
          {localFound ? "Sign in to MediaKit" : "Connect to a MediaKit server"}
        </div>
        <div className="mk-login-help">
          {autoDetected === "same-origin" && <>Talking to <code className="mono">{detectedBase}</code></>}
          {autoDetected === "localhost" && <>Found a local MediaKit at <code className="mono">{detectedBase}</code></>}
          {autoDetected === "none" && (
            isDesktop
              ? <>No local MediaKit found at <code className="mono">127.0.0.1:8765</code>. Start one with <code>mediakit serve &lt;library&gt;</code>, or point at a remote server below.</>
              : <>Defaults to the same origin as the SPA.</>
          )}
          {autoDetected === null && <>Looking for a local server…</>}
        </div>
        <div className="mk-login-inner">
          {!localFound && (
            <label className="mk-field">
              <span>Server URL</span>
              <input value={url} onChange={(e) => setUrl(e.target.value)} className="mono" />
            </label>
          )}
          <label className="mk-field">
            <span>Username</span>
            <input value={user} onChange={(e) => setUser(e.target.value)} className="mono" />
          </label>
          <label className="mk-field">
            <span>Password</span>
            <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} className="mono" />
          </label>
          {err && <div className="mk-login-error">{err}</div>}
          <button type="submit" className="mk-btn-primary" disabled={busy}>
            {busy ? (busyLabel || "Connecting…") : "Sign in"}
          </button>
        </div>
      </form>
    </div>
  );
}

// Skeleton row shimmer for loading state.
function SkeletonRow({ width = "100%" }) {
  return <div className="mk-skel" style={{ width }} />;
}

// Star toggle.
function StarBtn({ on, onToggle, size = 16 }) {
  return (
    <button
      className={"mk-star" + (on ? " on" : "")}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      aria-label={on ? "Unstar" : "Star"}
      title={on ? "Unstar" : "Star"}
    >
      <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor">
        <path d="M12 21s-7.5-4.5-9.5-9.5C1 7 4.5 4 8 4c2 0 3.5 1 4 2 .5-1 2-2 4-2 3.5 0 7 3 5.5 7.5C19.5 16.5 12 21 12 21z"/>
      </svg>
    </button>
  );
}

// Connection-error banner (rare path; we don't auto-show it, but it lives in
// the design system so it can be triggered from the command palette).
function ConnectionBanner({ message, onRetry, onDismiss }) {
  return (
    <div className="mk-conn-banner">
      <div className="mk-conn-icon">!</div>
      <div className="mk-conn-text">
        <div className="mk-conn-title">Lost connection to server</div>
        <div className="mk-conn-sub">{message}</div>
      </div>
      <button className="mk-conn-btn" onClick={onRetry}>Retry</button>
      <button className="mk-conn-x" onClick={onDismiss}>×</button>
    </div>
  );
}

Object.assign(window, { MK_LoginView: LoginView, MK_SkeletonRow: SkeletonRow, MK_StarBtn: StarBtn, MK_ConnectionBanner: ConnectionBanner });
