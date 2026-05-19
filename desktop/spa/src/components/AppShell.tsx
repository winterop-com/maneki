/**
 * Two-pane layout: Nav on the left, view content on the right.
 *
 * Selecting a section item updates the current view. Routing is in-memory
 * for commit 2; URL-based routing (React Router) lands later if needed.
 */

import { useMemo, useState } from "react";
import type { Capabilities } from "../state/capabilities";
import { useAuth } from "../state/auth";
import { Nav } from "./Nav";
import type { ViewId } from "./Nav";

interface AppShellProps {
  capabilities: Capabilities;
}

function defaultViewFor(capabilities: Capabilities): ViewId | null {
  if (capabilities.video) return "video.overview";
  if (capabilities.audio) return "music.overview";
  return null;
}

export function AppShell({ capabilities }: AppShellProps): React.ReactElement {
  const { session, logout } = useAuth();
  const [view, setView] = useState<ViewId | null>(() => defaultViewFor(capabilities));

  const headerText = useMemo(() => {
    const parts = [`${capabilities.server} v${capabilities.version}`];
    if (session !== null) parts.push(`signed in as ${session.username}`);
    return parts.join("  ·  ");
  }, [capabilities, session]);

  return (
    <div className="shell">
      <aside className="sidebar">
        <h1 className="brand">mediakit</h1>
        <Nav capabilities={capabilities} current={view} onSelect={setView} />
        {session !== null && (
          <button type="button" className="logout" onClick={logout}>
            sign out
          </button>
        )}
      </aside>
      <main className="content">
        <p className="header">{headerText}</p>
        <ViewBody view={view} capabilities={capabilities} />
      </main>
    </div>
  );
}

interface ViewBodyProps {
  view: ViewId | null;
  capabilities: Capabilities;
}

function ViewBody({ view, capabilities }: ViewBodyProps): React.ReactElement {
  if (view === null) {
    return (
      <section className="placeholder">
        <h2>nothing to show</h2>
        <p>This server reports no audio or video. Nothing to browse.</p>
      </section>
    );
  }
  if (view === "video.overview") {
    return (
      <section className="placeholder">
        <h2>Video</h2>
        <p>Video views land in commit 3.</p>
        <p className="endpoint">API: {capabilities.endpoints.video_api ?? "(disabled)"}</p>
      </section>
    );
  }
  return (
    <section className="placeholder">
      <h2>Music</h2>
      <p>Music views land in commit 4 (ported from the old SPA's Subsonic client).</p>
      <p className="endpoint">API: {capabilities.endpoints.audio_subsonic ?? "(disabled)"}</p>
    </section>
  );
}
