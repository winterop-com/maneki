/**
 * Top-level shell: mk-topbar (brand + signed-in user + sign out) over a
 * 2-pane mk-body (sidebar nav + content). Uses the legacy MediaKit design
 * system classes (mk-shell / mk-topbar / mk-pane / ...) lifted from the
 * old SPA, so the visual identity is consistent.
 */

import { useState } from "react";
import type { Capabilities } from "../state/capabilities";
import { useAuth } from "../state/auth";
import type { Video } from "../state/videos";
import { AudioBrowse } from "./audio/AudioBrowse";
import { Nav } from "./Nav";
import type { ViewId } from "./Nav";
import { VideoList } from "./video/VideoList";
import { VideoPlayer } from "./video/VideoPlayer";

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
  const [playing, setPlaying] = useState<Video | null>(null);

  const handleSelect = (next: ViewId): void => {
    setPlaying(null);
    setView(next);
  };

  return (
    <div className="mk-shell">
      <div className="mk-topbar">
        <div className="mk-topbar-left" />
        <div className="mk-topbar-center">
          <span className="mk-brand">mediakit</span>
          <span className="mk-version">v{capabilities.version}</span>
        </div>
        <div className="mk-topbar-right">
          {session !== null && <span className="mk-user">{session.username}</span>}
          {session !== null && (
            <button type="button" className="mk-signout" onClick={logout}>
              Sign out
            </button>
          )}
        </div>
      </div>
      <div className="mk-body mk-spa-body">
        <Nav capabilities={capabilities} current={view} onSelect={handleSelect} />
        <main className="mk-pane mk-pane-wide mk-content">
          {playing !== null ? (
            <VideoPlayer video={playing} onClose={() => setPlaying(null)} />
          ) : (
            <ViewBody view={view} onPlayVideo={setPlaying} />
          )}
        </main>
      </div>
    </div>
  );
}

interface ViewBodyProps {
  view: ViewId | null;
  onPlayVideo: (video: Video) => void;
}

function ViewBody({ view, onPlayVideo }: ViewBodyProps): React.ReactElement {
  if (view === null) {
    return (
      <div className="mk-empty">
        <div className="mk-empty-title">Nothing to show</div>
        <div className="mk-empty-sub">This server reports no audio or video.</div>
      </div>
    );
  }
  if (view === "video.overview") {
    return <VideoList onSelect={onPlayVideo} />;
  }
  // music.overview - audio browse stack (artists -> albums -> tracks).
  return (
    <AudioBrowse
      onPlayTrack={(track) => {
        // commit 4c will replace this with real transport-bar wiring
        // eslint-disable-next-line no-console
        console.warn(`audio playback wiring lands in commit 4c (track: ${track.title})`);
      }}
    />
  );
}
