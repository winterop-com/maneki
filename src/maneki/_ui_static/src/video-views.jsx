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

// Folder-browser pane: click-in navigator over <root>/videos/. Breadcrumbs
// at the top, folders above files in the current directory. Click a folder
// to dive in; click a video to set selectedVideo and show the player.
//
// Two pieces of state live here:
// - `path`: the current relative path under videos/ (empty string = root).
// - `entries`: the response from /api/browse?path=<path>.
// We refetch every time `path` changes, so backing out via a breadcrumb
// pops back to the previously-fetched parent.
function VideosPane({ session, selectedId, onSelect }) {
  const [path, setPath] = useSt_vv("");
  const [entries, setEntries] = useSt_vv(null);
  const [error, setError] = useSt_vv(null);

  useEff_vv(() => {
    let cancelled = false;
    setError(null);
    window.MK_VIDEO.browse(session, path).then(
      (data) => { if (!cancelled) setEntries(data); },
      (err) => { if (!cancelled) setError(String(err.message || err)); },
    );
    return () => { cancelled = true; };
  }, [session, path]);

  const crumbs = entries?.crumbs || [];
  const folders = entries?.folders || [];
  const videos = entries?.videos || [];
  const empty = entries !== null && folders.length === 0 && videos.length === 0;

  return (
    <div className="mk-pane mk-albums-pane">
      <div className="mk-pane-label mk-video-crumbs">
        <span
          className={"mk-crumb" + (path === "" ? " active" : " mk-crumb-link")}
          onClick={() => path !== "" && setPath("")}
        >
          Videos
        </span>
        {crumbs.map((seg, i) => {
          const segPath = crumbs.slice(0, i + 1).join("/");
          const isLast = i === crumbs.length - 1;
          return (
            <React.Fragment key={segPath}>
              <span className="mk-crumb-sep">/</span>
              <span
                className={"mk-crumb" + (isLast ? " active" : " mk-crumb-link")}
                onClick={() => !isLast && setPath(segPath)}
                title={seg}
              >
                {seg}
              </span>
            </React.Fragment>
          );
        })}
      </div>
      {error !== null && <div className="mk-empty"><div className="mk-empty-title">{error}</div></div>}
      {error === null && entries === null && <div className="mk-empty"><div className="mk-empty-title">loading...</div></div>}
      {empty && (
        <div className="mk-empty">
          <div className="mk-empty-icon">
            <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="2" y="6" width="20" height="12" rx="2"/>
              <path d="M10 9l5 3-5 3z" fill="currentColor"/>
            </svg>
          </div>
          <div className="mk-empty-title">No videos</div>
          <div className="mk-empty-sub">
            {path === ""
              ? <>Add files under &lt;root&gt;/videos/ on the server.</>
              : <>This folder is empty.</>}
          </div>
        </div>
      )}
      {entries !== null && (folders.length > 0 || videos.length > 0) && (
        <div className="mk-album-list">
          {folders.map((f) => (
            <div
              key={`folder:${f.rel_path}`}
              className="mk-album-row mk-folder-row"
              onClick={() => setPath(f.rel_path)}
              title={f.name}
            >
              <div className="mk-album-cover-sm mk-folder-icon">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M3 6.5a1.5 1.5 0 011.5-1.5h4.6a1.5 1.5 0 011.06.44l1.4 1.4a1.5 1.5 0 001.06.44H19.5A1.5 1.5 0 0121 8.78V18.5a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 18.5z"/>
                </svg>
              </div>
              <div className="mk-album-meta">
                <div className="mk-album-name">{f.name}</div>
                <div className="mk-album-sub">
                  <span className="mk-album-count">{f.video_count} {f.video_count === 1 ? "video" : "videos"}</span>
                </div>
              </div>
            </div>
          ))}
          {videos.map((v) => (
            <div
              key={v.id}
              className={"mk-album-row" + (selectedId === v.id ? " active" : "")}
              onClick={() => onSelect(v)}
              title={v.name}
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
                      {v.subtitles.length} subtitle{v.subtitles.length === 1 ? "" : "s"}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
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
      // Save the captions-settings menu choices (size / colour / font /
      // shadow) to localStorage so they persist across videos AND
      // across reloads. Off by default in video.js, which is why users
      // see their size pick "not stick".
      persistTextTrackSettings: true,
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
      html5: {
        vhs: { overrideNative: true },
        // Use video.js's text-track UI rather than the browser's native
        // one - the native UI varies per browser and doesn't surface a
        // visible button in the control bar. With this off, the
        // SubsCapsButton renders the menu (track picker + "subtitles
        // settings" submenu for font/size/color).
        nativeTextTracks: false,
      },
      controlBar: {
        // Explicit so the menu is always wired even if a future
        // video.js default drops it.
        subsCapsButton: true,
      },
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

    // Captions size: video.js's 100% baseline is bigger than feels
    // right. Pre-seeding a smaller default via the textTrackSettings
    // API doesn't actually apply (video.js's cue-render path reads
    // settings late and partial setValues calls don't always land),
    // so we lean on `persistTextTrackSettings: true` above instead:
    // the user picks a size once from the captions-settings menu and
    // it sticks across videos + reloads. Defaults to 100% on first
    // visit.

    // Recovery for MSE buffer lockups. Two failure modes:
    //   1. alt-tab away, return, player stuck (browser throttles MSE
    //      when backgrounded)
    //   2. mid-playback the SourceBuffer update never resolves and the
    //      player just sits on a spinner indefinitely
    // Same fix for both: nudge currentTime by 10ms to force MSE to
    // discard stale state + re-request segments. Triggered by both a
    // visibilitychange event AND a `waiting`-too-long timer so the
    // foreground-stuck case is also covered.
    const nudge = () => {
      try {
        if (!player.paused() && player.readyState() < 3) {
          const t = player.currentTime();
          player.currentTime(t + 0.01);
        }
      } catch { /* player disposed */ }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") nudge();
    };
    document.addEventListener("visibilitychange", onVisibility);

    // Watchdog: if `waiting` persists for >5s and the player wants to
    // play, nudge automatically. cleared every time playback resumes.
    let stallTimer = null;
    const armStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(nudge, 5000);
    };
    const cancelStallTimer = () => {
      if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
    };
    player.on("waiting", armStallTimer);
    player.on("playing", cancelStallTimer);
    player.on("pause", cancelStallTimer);
    player.on("ended", cancelStallTimer);

    return () => {
      cancelStallTimer();
      document.removeEventListener("visibilitychange", onVisibility);
      window.MK_VIDEO_PLAYER = null;
      try { player.dispose(); } catch { /* ignore */ }
      playerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video.id]);

  // Register subtitle tracks with the player. Doing this AFTER the
  // player is initialized (instead of via JSX <track> children) avoids
  // a race where video.js's SubsCapsButton wouldn't see tracks that
  // React appended later. addRemoteTextTrack also lets us update the
  // list when the /subtitles fetch resolves with embedded entries that
  // weren't in the initial listing summary.
  useEff_vv(() => {
    const player = playerRef.current;
    if (!player || subtitles.length === 0) return undefined;
    const added = [];
    for (const sub of subtitles) {
      const src = sub.track_id
        ? window.MK_VIDEO.subtitleTrackUrl(session, video.id, sub.track_id)
        : window.MK_VIDEO.subtitleUrl(session, video.id, sub.lang);
      // kind=captions (not subtitles) so video.js exposes the
      // "captions settings" submenu (font / size / colour).
      const track = player.addRemoteTextTrack(
        {
          kind: "captions",
          src,
          srclang: sub.lang === "und" ? "" : sub.lang,
          label: sub.label || (sub.lang === "und" ? "Subtitles" : sub.lang.toUpperCase()),
          default: !!sub.default,
        },
        false, // manualCleanup=false: video.js drops these on dispose
      );
      added.push(track);
    }
    return () => {
      for (const t of added) {
        try { player.removeRemoteTextTrack(t); } catch { /* ignore */ }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subtitles, video.id]);

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
          {/* Subtitle <track> children are registered programmatically
              via player.addRemoteTextTrack() in the useEffect above so
              video.js's SubsCapsButton reliably sees them. JSX-rendered
              tracks were racy with the player init. */}
        </video>
      </div>
    </div>
  );
}

// Flat-results pane shown in video mode when the topbar search has a
// non-empty query. Calls /video/api/search?q=... and renders rows
// matching VideosPane's video-row markup so the visual jump back to
// the folder browser is seamless. Debounced 200ms so each keystroke
// doesn't fire a new fetch.
function VideoSearchPane({ session, q, selectedId, onSelect }) {
  const [results, setResults] = useSt_vv(null);
  const [error, setError] = useSt_vv(null);
  useEff_vv(() => {
    let cancelled = false;
    setError(null);
    const trimmed = (q || "").trim();
    if (!trimmed) {
      setResults([]);
      return () => {};
    }
    setResults(null);
    const timer = setTimeout(() => {
      window.MK_VIDEO.search(session, trimmed).then(
        (data) => { if (!cancelled) setResults(data); },
        (err) => { if (!cancelled) setError(String(err.message || err)); },
      );
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [session, q]);
  return (
    <div className="mk-pane mk-albums-pane">
      <div className="mk-pane-label mk-video-crumbs">
        <span className="mk-crumb active">Search</span>
        <span className="mk-crumb-sep">/</span>
        <span className="mk-crumb" title={q}>"{q}"</span>
        {Array.isArray(results) && (
          <span className="mk-crumb" style={{ marginLeft: "auto", opacity: 0.6 }}>
            {results.length} {results.length === 1 ? "match" : "matches"}
          </span>
        )}
      </div>
      {error !== null && <div className="mk-empty"><div className="mk-empty-title">{error}</div></div>}
      {error === null && results === null && <div className="mk-empty"><div className="mk-empty-title">searching...</div></div>}
      {Array.isArray(results) && results.length === 0 && (
        <div className="mk-empty">
          <div className="mk-empty-title">No matches</div>
          <div className="mk-empty-sub">Nothing in the library contains "{q}".</div>
        </div>
      )}
      {Array.isArray(results) && results.length > 0 && (
        <div className="mk-album-list">
          {results.map((v) => (
            <div
              key={v.id}
              className={"mk-album-row" + (selectedId === v.id ? " active" : "")}
              onClick={() => onSelect(v)}
              title={v.rel_path || v.name}
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
                  {/* Show rel_path as a dim trailing hint when the file
                      lives in a subfolder. Strip any extension before
                      comparing - hard-coding ".mkv" caused mp4/webm/mov
                      hits to always paint a redundant subtitle. */}
                  {v.rel_path && v.rel_path.replace(/\.[^./]+$/, "") !== v.name && (
                    <span className="mk-album-count" style={{ opacity: 0.6 }}>
                      {v.rel_path}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

Object.assign(window, {
  MK_VideosPane: VideosPane,
  MK_VideoSearchPane: VideoSearchPane,
  MK_VideoPlayerPane: VideoPlayerPane,
});
