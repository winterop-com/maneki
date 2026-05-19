import { useEffect, useState } from "react";

interface Capabilities {
  server: string;
  version: string;
  audio: boolean;
  video: boolean;
  auth_required: boolean;
  endpoints: Record<string, string | null>;
}

/**
 * Commit 1 placeholder. Fetches /capabilities to prove the SPA can talk to the
 * server, then renders identity + presence flags. Real nav, login, and views
 * land in the next commits.
 */
export function App(): React.ReactElement {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/capabilities")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: Capabilities) => setCaps(data))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  return (
    <main className="app">
      <h1>mediakit</h1>
      {error !== null && <p className="error">cannot reach /capabilities: {error}</p>}
      {caps !== null && (
        <dl>
          <dt>server</dt>
          <dd>
            {caps.server} v{caps.version}
          </dd>
          <dt>audio</dt>
          <dd>{caps.audio ? "yes" : "no"}</dd>
          <dt>video</dt>
          <dd>{caps.video ? "yes" : "no"}</dd>
          <dt>auth required</dt>
          <dd>{caps.auth_required ? "yes" : "no"}</dd>
        </dl>
      )}
      {error === null && caps === null && <p>loading...</p>}
      <p className="footer">
        SPA scaffold (commit 1). Nav / login / video player land in subsequent commits.
      </p>
    </main>
  );
}
