/**
 * Single login form fills both the Subsonic salt-token (for /audio/rest/*)
 * and the MediaKit bearer (for /video/* when --auth is on). User enters
 * password once; the auth context handles both derivations.
 */

import { useState } from "react";
import { useAuth } from "../state/auth";
import type { Capabilities } from "../state/capabilities";

interface LoginScreenProps {
  capabilities: Capabilities;
}

function helpFor(capabilities: Capabilities): string {
  const sides: string[] = [];
  if (capabilities.audio) sides.push("audio (Subsonic)");
  if (capabilities.auth_required) sides.push("video (MediaKit bearer)");
  if (sides.length === 0) return "the server has nothing to authenticate against";
  return `signs you into ${sides.join(" + ")}`;
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
    <main className="login">
      <h1>mediakit</h1>
      <p className="subtitle">{helpFor(capabilities)}</p>
      <form onSubmit={(e) => void onSubmit(e)}>
        <label>
          username
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            autoComplete="username"
            required
          />
        </label>
        <label>
          password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error !== null && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? "signing in..." : "sign in"}
        </button>
      </form>
    </main>
  );
}
