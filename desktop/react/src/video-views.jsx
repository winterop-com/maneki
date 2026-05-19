// VIDEO section views - VideosPane (list) + VideoPlayerPane (player).
//
// Styled with the mk-* tokens already in mediakit.css so the look matches
// the rest of the SPA (Tokyo-Night palette, monospace meta, blue accent).
//
// Playback uses video.js v10 loaded via CDN (index.html). On mount it
// constructs a player against an HLS source from the server's /video/api/
// endpoint. Subtitles are surfaced via <track> elements; the player's
// native chrome shows the language picker.
//
// Globals consumed:
//   window.MK_VIDEO   - video API client (_video.js)
//   window.videojs    - video.js v10 (CDN script in index.html)

const { useEffect: useEff_vv, useState: useSt_vv, useRef: useRef_vv } = React;

function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined || !isFinite(seconds)) return "--:--";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtSize(bytes) {
  if (!isFinite(bytes)) return "?";
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${(bytes / 1e6).toFixed(0)} MB`;
}

// Group videos by their top-level subdirectory under <root>/videos/.
// Files directly in `videos/` go into the "" bucket (rendered as "Videos");
// `videos/movies/bat.mp4` goes into "movies", and so on. Anything below
// the first directory keeps its full sub-path visible in the row's
// secondary line so duplicate stems across folders are disambiguated.
function groupVideosByFolder(videos) {
  const groups = new Map();
  for (const v of videos) {
    const rel = v.rel_path || v.name;
    const slash = rel.indexOf("/");
    const key = slash === -1 ? "" : rel.slice(0, slash);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }
  // Root bucket first, then alphabetical for the rest - keeps the list
  // stable when folders are added.
  return [...groups.entries()].sort((a, b) => {
    if (a[0] === "") return -1;
    if (b[0] === "") return 1;
    return a[0].localeCompare(b[0]);
  });
}

// Primary video pane: list of every video the server knows about,
// grouped by top-level subfolder under <root>/videos/. Click a row to
// set the selected video; the parent renders the player. In video mode
// the SPA has no sidebar - the list IS the primary view.
function VideosPane({ session, selectedId, onSelect }) {
  const [videos, setVideos] = useSt_vv(null);
  const [error, setError] = useSt_vv(null);

  useEff_vv(() => {
    let cancelled = false;
    window.MK_VIDEO.list(session).then(
      (data) => { if (!cancelled) setVideos(data); },
      (err) => { if (!cancelled) setError(String(err.message || err)); },
    );
    return () => { cancelled = true; };
  }, [session]);

  const groups = videos === null ? null : groupVideosByFolder(videos);

  return (
    <div className="mk-pane mk-albums-pane">
      {error !== null && <div className="mk-empty"><div className="mk-empty-title">{error}</div></div>}
      {error === null && videos === null && <div className="mk-empty"><div className="mk-empty-title">loading...</div></div>}
      {videos !== null && videos.length === 0 && (
        <div className="mk-empty">
          <div className="mk-empty-icon">
            <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="2" y="6" width="20" height="12" rx="2"/>
              <path d="M10 9l5 3-5 3z" fill="currentColor"/>
            </svg>
          </div>
          <div className="mk-empty-title">No videos</div>
          <div className="mk-empty-sub">Add files under &lt;root&gt;/videos/ on the server.</div>
        </div>
      )}
      {groups !== null && groups.length > 0 && groups.map(([folder, items]) => (
        <div key={folder || "__root__"} className="mk-pane-section mk-video-group">
          <div className="mk-pane-label mk-video-group-label">
            {folder === "" ? "Videos" : folder}
            <span className="mk-count"> ({items.length})</span>
          </div>
          <div className="mk-album-list">
            {items.map((v) => {
              // Sub-path beneath the first folder, e.g. "season-1/ep03.mkv".
              // Hidden when there is no nesting (rel_path === filename).
              const rel = v.rel_path || v.name;
              const subPath = folder === "" ? null : rel.slice(folder.length + 1);
              const showSubPath = subPath && subPath !== `${v.name}${rel.slice(rel.lastIndexOf("."))}`;
              return (
                <div
                  key={v.id}
                  className={"mk-album-row" + (selectedId === v.id ? " active" : "")}
                  onClick={() => onSelect(v)}
                >
                  <img
                    className="mk-album-cover-sm"
                    src={window.MK_VIDEO.thumbnailUrl(session, v.id)}
                    alt=""
                    loading="lazy"
                    style={{ objectFit: "cover", background: "var(--bg-elev2)" }}
                  />
                  <div className="mk-album-meta">
                    <div className="mk-album-name">{v.name}</div>
                    <div className="mk-album-sub">
                      <span className="mono">{fmtDuration(v.duration_s)}</span>
                      <span className="mk-album-count">{fmtSize(v.size_bytes)}</span>
                      {v.subtitles && v.subtitles.length > 0 && (
                        <span className="mk-album-count" style={{ color: "var(--accent)" }}>
                          {v.subtitles.length} sub{v.subtitles.length === 1 ? "" : "s"}
                        </span>
                      )}
                    </div>
                    {showSubPath && (
                      <div className="mk-album-sub mono" style={{ color: "var(--text-dim)", fontSize: 11, marginTop: 2 }}>
                        {subPath}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// Right pane (or main pane when no audio is playing): video.js v10 player
// wired to the selected video's HLS source + <track> subtitles.
function VideoPlayerPane({ session, video, onClose }) {
  const videoRef = useRef_vv(null);
  const playerRef = useRef_vv(null);
  const [subtitles, setSubtitles] = useSt_vv(video.subtitles || []);

  // Fetch subtitles list (the listing's `subtitles` field is summary;
  // the endpoint may have more detail by the time we get here). Note: we
  // intentionally exclude `session` from the deps below - it's a fresh
  // object reference on every App re-render (loadSession() parses
  // localStorage each call), which would dispose + reinit the player
  // every time the parent re-renders for unrelated state changes (e.g.
  // opening the shortcuts overlay).
  useEff_vv(() => {
    let cancelled = false;
    window.MK_VIDEO.subtitles(session, video.id).then((data) => {
      if (!cancelled && Array.isArray(data)) setSubtitles(data);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video.id]);

  // Build / tear down the video.js player when the selected video changes.
  // Deps: video.id only. See note above re: excluding `session`.
  useEff_vv(() => {
    const el = videoRef.current;
    if (el === null || typeof window.videojs !== "function") return undefined;
    const player = window.videojs(el, {
      controls: true,
      autoplay: false,
      preload: "auto",
      fluid: true,
      // Contact-sheet poster: shows the video at a glance while paused
      // (and during seek buffer stalls) instead of a blank canvas.
      // Generated server-side; first request transcodes ~9 frames, then
      // cached on disk under <root>/.mediakit/posters/.
      poster: window.MK_VIDEO.posterUrl(session, video.id),
      // Tell the browser to hide ALL its own chrome (URL bar, tab strip)
      // when entering fullscreen. The default 'auto' lets Chrome keep
      // the URL bar visible on macOS, which looks like the player isn't
      // really fullscreen even though it is.
      fullscreen: { options: { navigationUI: "hide" } },
      html5: { vhs: { overrideNative: true } },
    });
    player.src({
      src: window.MK_VIDEO.hlsUrl(session, video.id),
      type: "application/x-mpegURL",
    });
    playerRef.current = player;
    // Expose to app-level shortcut handler so the `f` key can toggle
    // fullscreen on the actual video player instead of the audio
    // visualizer overlay. Cleared in the cleanup below.
    window.MK_VIDEO_PLAYER = player;
    return () => {
      window.MK_VIDEO_PLAYER = null;
      try { player.dispose(); } catch { /* ignore */ }
      playerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video.id]);

  return (
    <div className="mk-pane mk-tracks-pane" style={{ padding: 14 }}>
      <div className="mk-pane-label" style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <span>{video.name}</span>
        <button className="mk-signout" onClick={onClose} style={{ fontSize: 11 }}>Close</button>
      </div>
      <div data-vjs-player style={{ marginTop: 10 }}>
        <video
          ref={videoRef}
          className="video-js vjs-big-play-centered vjs-fluid"
          playsInline
          crossOrigin="anonymous"
        >
          {subtitles.map((sub) => (
            <track
              key={sub.lang}
              kind="subtitles"
              srcLang={sub.lang === "und" ? undefined : sub.lang}
              label={sub.lang === "und" ? "Subtitles" : sub.lang.toUpperCase()}
              src={window.MK_VIDEO.subtitleUrl(session, video.id, sub.lang)}
              default={sub.lang === "en" || (subtitles.length === 1 && sub.lang === "und")}
            />
          ))}
        </video>
      </div>
    </div>
  );
}

Object.assign(window, { MK_VideosPane: VideosPane, MK_VideoPlayerPane: VideoPlayerPane });
