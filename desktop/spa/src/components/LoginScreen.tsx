/**
 * Single login form fills both the audio (Subsonic mount, salt-token) and
 * the video (MediaKit bearer, when --auth is on) auth surfaces.
 *
 * The form itself is MediaKit-branded - "Subsonic" is an implementation
 * detail of the audio mount, not a user-facing concept.
 */

import { useState } from "react";
import { useAuth } from "../state/auth";
import type { Capabilities } from "../state/capabilities";

interface LoginScreenProps {
  capabilities: Capabilities;
}

function helpFor(caps: Capabilities): string {
  if (caps.audio && caps.video) {
    return "Sign in to browse and play your music and video libraries.";
  }
  if (caps.audio) return "Sign in to browse and play your music library.";
  if (caps.video) return "Sign in to browse and play your video library.";
  return "Sign in to continue.";
}

export function LoginScreen({ capabilities }: LoginScreenProps): React.ReactElement {
  const { login } = useAuth();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(capabilities, username, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mk-login-shell">
      <div className="mk-login-brand">
        <div className="mk-login-logo">MediaKit</div>
        <div className="mk-login-tag">
          web · v{capabilities.version}
        </div>
      </div>
      <form className="mk-login-card" onSubmit={(e) => void onSubmit(e)}>
        <div className="mk-login-title">Sign in</div>
        <div className="mk-login-help">{helpFor(capabilities)}</div>
        <div className="mk-login-inner">
          <label className="mk-field">
            <span>Username</span>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              autoComplete="username"
              required
            />
          </label>
          <label className="mk-field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          {error !== null && <div className="mk-login-error">{error}</div>}
          <button type="submit" className="mk-btn-primary" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
          <div className="mk-login-foot">
            Credentials are derived locally; the plaintext password never leaves this
            page. Use HTTPS in production.
          </div>
        </div>
      </form>
    </main>
  );
}
