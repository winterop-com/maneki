/**
 * Login form shown when the server reports auth_required=true and no token
 * is stored. POSTs to /auth/login; on success, AuthProvider stores the token
 * and the rest of the app renders.
 */

import { useState } from "react";
import { useAuth } from "../state/auth";

export function LoginScreen(): React.ReactElement {
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
      await login(username, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <h1>mediakit</h1>
      <p className="subtitle">sign in to continue</p>
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
