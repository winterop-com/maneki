// Login view + miscellaneous small components used across the app.

const { useEffect: useEff_v, useState: useSt_v, useRef: useRef_v } = React;

function LoginView({ onConnect, themeMode, busyLabel }) {
  // sameOrigin === true when the SPA is being served by `mediakit serve
  // --ui` on the same origin as the API. Detected via /capabilities; if
  // that responds with our shape, hide the URL field entirely and post
  // to `<origin>/audio` (the Subsonic mount inside the unified server).
  // null while probing, true/false after.
  const [sameOrigin, setSameOrigin] = useSt_v(null);
  const [url, setUrl] = useSt_v(window.location.origin + "/audio");
  const [user, setUser] = useSt_v("admin");
  const [pw, setPw] = useSt_v("");
  const [busy, setBusy] = useSt_v(false);
  const [err, setErr] = useSt_v("");

  useEff_v(() => {
    let cancelled = false;
    fetch(window.location.origin + "/capabilities", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((caps) => {
        if (cancelled) return;
        const looksLikeMK = !!(caps && caps.server === "mediakit" && caps.endpoints?.audio_subsonic);
        setSameOrigin(looksLikeMK);
        if (looksLikeMK) {
          // The Subsonic client (_api.js) appends `/rest/<verb>` itself.
          // /capabilities returns the full mount as "/audio/rest", so
          // strip the trailing "/rest" to leave just the base mount.
          const mount = caps.endpoints.audio_subsonic.replace(/\/rest\/?$/, "");
          setUrl(window.location.origin + mount);
        }
      })
      .catch(() => { if (!cancelled) setSameOrigin(false); });
    return () => { cancelled = true; };
  }, []);

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

  const isSameOrigin = sameOrigin === true;
  return (
    <div className="mk-login-shell">
      <div className="mk-login-brand">
        <div className="mk-login-logo">MediaKit</div>
        <div className="mk-login-tag">desktop · v{document.querySelector('meta[name="mk-version"]')?.content || "?"}</div>
      </div>
      <form className="mk-login-card" onSubmit={submit}>
        <div className="mk-login-title">
          {isSameOrigin ? "Sign in to MediaKit" : "Connect to a MediaKit / Subsonic server"}
        </div>
        <div className="mk-login-help">
          {isSameOrigin
            ? <>Talking to <code className="mono">{window.location.origin}</code></>
            : <>Defaults to the same origin as the SPA. Also works against any spec-compliant Subsonic server (Navidrome, Airsonic, Gonic, etc.).</>
          }
        </div>
        <div className="mk-login-inner">
          {!isSameOrigin && (
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
          <div className="mk-login-foot">
            Default credentials are <code>admin</code> / <code>admin</code> until you set <code>--user</code> / <code>--password</code> on <code>mediakit serve</code>.
          </div>
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
