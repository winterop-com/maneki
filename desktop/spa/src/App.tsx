/**
 * Top-level orchestration. Three states:
 *
 *   1. Capabilities loading -> spinner-style placeholder.
 *   2. Capabilities loaded, auth_required, no token -> LoginScreen.
 *   3. Capabilities loaded, authenticated (or no auth needed) -> AppShell.
 *
 * The auth context lives at the root so AppShell + LoginScreen share the
 * same session state.
 */

import { useEffect, useState } from "react";
import { AppShell } from "./components/AppShell";
import { LoginScreen } from "./components/LoginScreen";
import { AuthProvider, useAuth } from "./state/auth";
import { fetchCapabilities } from "./state/capabilities";
import type { Capabilities } from "./state/capabilities";

export function App(): React.ReactElement {
  return (
    <AuthProvider>
      <AppRoot />
    </AuthProvider>
  );
}

function AppRoot(): React.ReactElement {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { isAuthenticated } = useAuth();

  useEffect(() => {
    void fetchCapabilities()
      .then((data) => setCaps(data))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  if (error !== null) {
    return (
      <main className="status">
        <h1>mediakit</h1>
        <p className="error">cannot reach the server: {error}</p>
      </main>
    );
  }

  if (caps === null) {
    return (
      <main className="status">
        <h1>mediakit</h1>
        <p>loading...</p>
      </main>
    );
  }

  // Login is required whenever the server has at least one authenticated
  // surface for the SPA to consume - audio (Subsonic) or auth-required
  // video. A video-only server with --auth off needs no login.
  const needsLogin = caps.audio || caps.auth_required;
  if (needsLogin && !isAuthenticated) {
    return <LoginScreen capabilities={caps} />;
  }

  return <AppShell capabilities={caps} />;
}
