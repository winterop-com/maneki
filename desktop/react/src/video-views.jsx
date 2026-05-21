// VIDEO section views - VideosPane (list) + VideoPlayerPane (player).
//
// Styled with the mk-* tokens already in maneki.css so the look matches
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

// Map (width, height) -> short label (1080p, 4K, ...). The cutoffs are
// keyed on height because that's the conventional axis; ultra-wide
// 1920x800 still reads as 1080p in player-strip UI. Falls back to the
// exact pixel form when the source is below 480p or non-standard.
function fmtResolution(w, h) {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  if (h >= 2160) return "4K";
  if (h >= 1440) return "1440p";
  if (h >= 1080) return "1080p";
  if (h >= 720) return "720p";
  if (h >= 480) return "480p";
  return `${w}x${h}`;
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
// Inline data-URI placeholder for the <img onError> fallback. Belt-and-
// braces in case the server's 202 placeholder never reaches the element
// (HTTP error, mid-flight abort, etc.). Same look as the server-side
// SVG so swapping in/out is invisible.
const THUMB_FALLBACK_SVG =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180" preserveAspectRatio="xMidYMid meet">' +
      '<rect width="320" height="180" fill="#1c2030"/>' +
      '<g transform="translate(160 90)">' +
      '<circle r="26" fill="#2a3045"/>' +
      '<polygon points="-7,-11 11,0 -7,11" fill="#5a6280"/>' +
      "</g></svg>",
  );

function VideosPane({ session, selectedId, onSelect }) {
  const [path, setPath] = useSt_vv("");
  const [entries, setEntries] = useSt_vv(null);
  const [error, setError] = useSt_vv(null);
  // Bumped by the Rescan button to re-trigger the /browse fetch + the
  // scan-status poll loop after the user manually kicks /api/scan.
  // The server's rescan runs out-of-band so we can't await it directly;
  // re-rendering with `entries=null` puts us back into the progressbar
  // state and the existing effects pick up the running scan.
  const [refreshNonce, setRefreshNonce] = useSt_vv(0);
  // Live scan progress (`{ scanning, phase, total, scanned }`) for the
  // root-level cold start. Polled only while entries are still null
  // AND the server reports scanning=true; once the prewarm finishes
  // (or once /api/browse returns) we stop polling and let the listing
  // take over.
  const [scan, setScan] = useSt_vv(null);
  // Per-video-id refresh counter. Bumped when /thumbnails/ready newly
  // reports an id as cached so the row's <img> src changes (appending
  // ?v=<token>) and the browser refetches the now-warm thumbnail. Maps
  // id -> int; missing entries render the bare URL (cache hit) or the
  // server placeholder (cache miss).
  const [thumbToken, setThumbToken] = useSt_vv({});

  useEff_vv(() => {
    let cancelled = false;
    setError(null);
    window.MK_VIDEO.browse(session, path).then(
      (data) => { if (!cancelled) setEntries(data); },
      (err) => { if (!cancelled) setError(String(err.message || err)); },
    );
    return () => { cancelled = true; };
  }, [session, path, refreshNonce]);

  // Scan-progress poll. Runs only while the library is still loading
  // at the root (path === "" and entries === null). The server's
  // background prewarm walks + ffprobes every file; we render its
  // count / total so the user sees real progress instead of a
  // spinner. 500ms cadence is fast enough to feel live without
  // hammering the server (each tick is one stat-only endpoint hit).
  useEff_vv(() => {
    if (path !== "" || entries !== null || !window.MK_VIDEO.scanStatus) return;
    let cancelled = false;
    let timer = null;
    const poll = async () => {
      const status = await window.MK_VIDEO.scanStatus(session);
      if (cancelled) return;
      setScan(status);
      // Stop polling once the prewarm reports done. The /api/browse
      // effect above will pick up the now-warm cache on its next tick.
      if (status && !status.scanning && status.phase === "done") return;
      timer = setTimeout(poll, 500);
    };
    poll();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [session, path, entries]);

  const crumbs = entries?.crumbs || [];
  const folders = entries?.folders || [];
  const videos = entries?.videos || [];
  const empty = entries !== null && folders.length === 0 && videos.length === 0;

  // Poll /thumbnails/ready while there are videos in the current folder
  // whose thumbnails haven't been bumped yet. When an id newly appears
  // in the ready set we increment its token; the <img> below renders
  // `<url>?v=<token>` so the browser refetches and the placeholder
  // swaps for the real frame. Stops polling once every visible video
  // is bumped (or when the pane unmounts / path changes).
  useEff_vv(() => {
    if (!window.MK_VIDEO.thumbnailsReady || videos.length === 0) return undefined;
    let cancelled = false;
    let timer = null;
    const tick = async () => {
      if (cancelled) return;
      const data = await window.MK_VIDEO.thumbnailsReady(session);
      if (cancelled) return;
      if (data && Array.isArray(data.ready)) {
        const readySet = new Set(data.ready);
        const visibleIds = videos.map((v) => v.id);
        setThumbToken((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const id of visibleIds) {
            if (readySet.has(id) && !next[id]) {
              next[id] = 1;
              changed = true;
            }
          }
          return changed ? next : prev;
        });
        // Stop once every visible row has been bumped at least once.
        const allBumped = visibleIds.every((id) => readySet.has(id));
        if (allBumped) return;
      }
      timer = setTimeout(tick, 4000);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, path, videos.length]);

  const onRescan = async () => {
    if (!window.MK_VIDEO.triggerScan) return;
    // Clear entries so the loading state + scan-status poll resume;
    // the /browse fetch above will re-run on the bumped nonce when
    // the user (or the natural completion) returns them here.
    setEntries(null);
    setRefreshNonce((n) => n + 1);
    await window.MK_VIDEO.triggerScan(session);
  };

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
        <button
          type="button"
          className="mk-rescan-btn"
          onClick={onRescan}
          title="Rescan library (re-walks the root, picks up new / removed files)"
          aria-label="Rescan library"
        >
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 11-3-6.7L21 8"/>
            <path d="M21 3v5h-5"/>
          </svg>
        </button>
      </div>
      {error !== null && <div className="mk-empty"><div className="mk-empty-title">{error}</div></div>}
      {error === null && entries === null && (
        <div className="mk-empty">
          <div className="mk-empty-title">
            {scan && scan.phase === "probing"
              ? "Scanning library"
              : scan && scan.phase === "walking"
              ? "Discovering files"
              : "Loading library"}
          </div>
          <div className="mk-scan-progress">
            <div
              className="mk-scan-progress-bar"
              style={{
                // `--mk-progress` drives the width of the filled portion
                // (matches the audio scrubber pattern in maneki.css).
                // Indeterminate during the walking phase: total is 0
                // until the file list is known, so we show a pulsing
                // empty bar in that case.
                "--mk-progress":
                  scan && scan.total > 0
                    ? `${Math.min(100, Math.round((scan.scanned / scan.total) * 100))}%`
                    : "0%",
              }}
            />
          </div>
          <div className="mk-empty-sub mono">
            {scan && scan.total > 0
              ? `${scan.scanned} / ${scan.total} videos`
              : scan && scan.walked > 0
              ? `${scan.walked} files found...`
              : "discovering files..."}
          </div>
        </div>
      )}
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
                src={
                  window.MK_VIDEO.thumbnailUrl(session, v.id)
                  + (thumbToken[v.id] ? `?v=${thumbToken[v.id]}` : "")
                }
                alt=""
                loading="lazy"
                onError={(e) => {
                  if (e.currentTarget.src !== THUMB_FALLBACK_SVG) {
                    e.currentTarget.src = THUMB_FALLBACK_SVG;
                  }
                }}
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
  // Latest player error message (or null when playing cleanly).
  // Surfaced as a banner overlay so the user gets actionable feedback
  // instead of an opaque black canvas when HLS fails (server 503,
  // ffmpeg gone, recovery cooldown engaged, etc.).
  const [playerError, setPlayerError] = useSt_vv(null);
  // {w, h} once the player decodes the first frame. Pulled from
  // video.js (`videoWidth/videoHeight`) on `loadedmetadata` so we don't
  // need a server-side ffprobe just for this — HLS doesn't downscale,
  // so the player-reported dims match the source file.
  const [resolution, setResolution] = useSt_vv(null);

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
    // Drop stale resolution before the new player decodes metadata so
    // the meta strip doesn't briefly show the previous video's value.
    setResolution(null);
    // Seed a smaller-than-default caption size BEFORE video.js init
    // reads localStorage. video.js's 100% baseline scales by player
    // height; at 1080p+ fullscreen it eats a third of the screen.
    // 0.50 (the menu's smallest preset) is still big in fullscreen,
    // so go with the raw menu minimum AND apply it explicitly after
    // init for good measure. Seed only writes when no user value
    // exists, so anything picked from the menu afterwards wins.
    try {
      if (!window.localStorage.getItem("vjs-text-track-settings")) {
        window.localStorage.setItem(
          "vjs-text-track-settings",
          JSON.stringify({ fontPercent: "0.50" }),
        );
      }
    } catch (_e) {
      // ignore - private browsing / no quota
    }
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
      // cached on disk under <root>/.maneki/posters/.
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

    // Captions size: also call setValues explicitly so video.js's
    // initial cue render uses our smaller default even before it
    // reads localStorage. The seed above covers persistence across
    // reloads; this covers the current player's first frame.
    try {
      const settings = typeof player.textTrackSettings === "function"
        ? player.textTrackSettings()
        : player.textTrackSettings;
      settings?.setValues?.({ fontPercent: "0.50" });
      settings?.updateDisplay?.();
    } catch (_e) {
      // older video.js builds may not expose this; safe to skip.
    }

    // Rapid-scrub recovery. Fast-forwarding (right-arrow held / many
    // quick presses) requests segments faster than ffmpeg produces
    // them; video.js then blacklists the only playlist with "Playback
    // cannot continue. No available working or supported playlists."
    // and the player gets stuck in error state. For a single-playlist
    // VOD there is no other playlist to fall back to, so blacklisting
    // serves no purpose — we clear the error and re-load the same
    // source at the seek position the player was trying to reach.
    //
    // Guard against re-entry: each player.src() reload can itself
    // fire an error during init (HLS manifest fetch, first segment
    // 404 if the player picks an uncached position) which would
    // trigger the handler again → infinite reload loop. Allow at
    // most one recovery per 8s window per video. If we're still in
    // error after that, the user can hit Close + reopen.
    let lastRecoveryAt = 0;
    const RECOVERY_COOLDOWN_MS = 8000;
    const recoverFromBlacklist = () => {
      try {
        const err = player.error();
        if (!err) return;
        const msg = String(err.message || "");
        if (!/playlists?|MEDIA_ERR_NETWORK|exhausted/i.test(msg)) return;
        const now = Date.now();
        if (now - lastRecoveryAt < RECOVERY_COOLDOWN_MS) {
          // Already attempted recently - leave the error visible so
          // the user knows the player needs a manual reset.
          return;
        }
        lastRecoveryAt = now;
        const lastTime = player.currentTime();
        player.error(null);
        player.src({
          src: window.MK_VIDEO.hlsUrl(session, video.id),
          type: "application/x-mpegURL",
        });
        player.one("loadedmetadata", () => {
          try {
            if (Number.isFinite(lastTime) && lastTime > 0) {
              player.currentTime(lastTime);
            }
            player.play().catch(() => {});
          } catch (_e) { /* dead player */ }
        });
      } catch (_e) { /* dead player */ }
    };
    player.on("error", recoverFromBlacklist);

    // Surface error to the UI. Runs alongside the auto-recovery path:
    // recoverFromBlacklist only kicks in for a specific class of HLS
    // playlist failures and is cooldown-gated, so for everything else
    // (or when cooldown is engaged), the user previously saw a black
    // canvas with no signal. Now they get a banner with the error
    // message and a retry button.
    const captureError = () => {
      try {
        const err = player.error();
        if (!err) return;
        setPlayerError(String(err.message || "Playback error").trim());
      } catch (_e) { /* dead player */ }
    };
    player.on("error", captureError);
    // Clear the banner once playback actually starts again (whether
    // from auto-recovery or a user-triggered retry).
    const clearError = () => setPlayerError(null);
    player.on("playing", clearError);
    player.on("loadeddata", clearError);

    // Capture source resolution for the meta strip. Re-fires on every
    // src() swap (recovery, manual retry) so the displayed value
    // tracks whatever's actually decoding.
    const captureResolution = () => {
      try {
        const w = player.videoWidth();
        const h = player.videoHeight();
        if (w > 0 && h > 0) setResolution({ w, h });
      } catch (_e) { /* dead player */ }
    };
    player.on("loadedmetadata", captureResolution);

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
      // Tell the server to drop any in-flight HLS prefetch tasks for
      // this video. Without this, neighbour-segment transcodes queued
      // behind the last segment request keep eating CPU long after
      // the player visibly closes. `keepalive: true` (inside the API
      // method) ensures the request survives this synchronous cleanup
      // even if the tab is closing.
      try { window.MK_VIDEO.cancelSession(session, video.id); } catch { /* ignore */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video.id]);

  // Register subtitle tracks with the player.
  //
  // History note: a .mkv with 40+ embedded subtitle tracks would,
  // with naive "register every track on mount", cause the browser to
  // fire one /subtitles/embed-N fetch per track. Each fetch triggered
  // a server-side ffmpeg extraction (~0.5-2s each), and the HTTP/1.1
  // 6-connection-per-origin limit serialised them into ~10 seconds
  // of head-of-line blocking against the HLS segment requests the
  // player actually needs.
  //
  // Fix: register only the highest-priority tracks - the server's
  // chosen default + any English / English-SDH variant. That's what
  // the user almost certainly wants enabled on playback. The non-
  // priority tracks (Polish, Vietnamese, ...) are intentionally NOT
  // registered; we trade captions-menu completeness for a clean HLS
  // critical path. A future "more languages" picker can re-register
  // any of the dropped tracks on demand.
  useEff_vv(() => {
    const player = playerRef.current;
    if (!player || subtitles.length === 0) return undefined;

    const isEnglish = (s) => {
      const l = (s.lang || "").toLowerCase();
      return l === "en" || l === "eng";
    };
    const looksSdh = (s) => /\b(sdh|cc|hoh|hearing|closed)\b/i.test(s.label || "");
    const priority = (s) => {
      if (s.default) return 0;
      if (isEnglish(s) && looksSdh(s)) return 1;
      if (isEnglish(s)) return 2;
      return 99;
    };
    const ordered = [...subtitles].sort((a, b) => priority(a) - priority(b));
    // Always register at least the top of the sorted list so the
    // captions menu has something even if no English is available.
    const eager = ordered.filter((s) => priority(s) < 99);
    if (eager.length === 0) eager.push(ordered[0]);

    const added = [];
    for (const sub of eager) {
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

  // When the player mounts before the poster has been generated,
  // /poster returns the 202 SVG placeholder and video.js paints a
  // blank canvas with just the play button. Without a refresh
  // trigger the player keeps showing the placeholder forever even
  // after the real PNG lands on disk. Poll /thumbnails/ready (it
  // also reports posters_ready) and re-set `player.poster()` with
  // a cache-busting query string as soon as our id appears.
  useEff_vv(() => {
    if (!window.MK_VIDEO.thumbnailsReady) return undefined;
    let cancelled = false;
    let timer = null;
    let done = false;
    const tick = async () => {
      if (cancelled || done) return;
      try {
        const data = await window.MK_VIDEO.thumbnailsReady(session);
        if (cancelled) return;
        const ready = data && Array.isArray(data.posters_ready) ? data.posters_ready : [];
        if (ready.includes(video.id)) {
          const player = playerRef.current;
          if (player) {
            try {
              const url = window.MK_VIDEO.posterUrl(session, video.id) + "?v=" + Date.now();
              player.poster(url);
            } catch (_e) { /* dead player */ }
          }
          done = true;
          return;
        }
      } catch (_e) { /* swallow transient network errors */ }
      timer = setTimeout(tick, 4000);
    };
    timer = setTimeout(tick, 1500);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video.id]);

  const subCount = subtitles.length;
  const resolutionLabel = resolution ? fmtResolution(resolution.w, resolution.h) : null;
  const metaBits = [
    Number.isFinite(video.duration_s) ? fmtDuration(video.duration_s) : null,
    resolutionLabel,
    Number.isFinite(video.size_bytes) ? fmtSize(video.size_bytes) : null,
    subCount > 0 ? `${subCount} subtitle${subCount === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  const onRetryPlayback = () => {
    const player = playerRef.current;
    if (!player) return;
    try {
      const lastTime = player.currentTime() || 0;
      player.error(null);
      player.src({
        src: window.MK_VIDEO.hlsUrl(session, video.id),
        type: "application/x-mpegURL",
      });
      player.one("loadedmetadata", () => {
        try {
          if (Number.isFinite(lastTime) && lastTime > 0) player.currentTime(lastTime);
          player.play().catch(() => {});
        } catch (_e) { /* dead player */ }
      });
      setPlayerError(null);
    } catch (_e) { /* dead player */ }
  };

  return (
    <div className="mk-pane mk-video-player-pane">
      <div className="mk-video-player-header">
        <div className="mk-video-player-titles">
          <div className="mk-video-player-name">{video.name}</div>
          {metaBits.length > 0 && (
            <div className="mk-video-player-meta">{metaBits.join(" · ")}</div>
          )}
        </div>
        <button className="mk-signout" onClick={onClose} style={{ fontSize: 11 }}>Close</button>
      </div>
      <div className="mk-video-stage">
        {playerError && (
          <div className="mk-player-error" role="alert">
            <div className="mk-player-error-msg">
              <strong>Playback error</strong>
              <span>{playerError}</span>
            </div>
            <button type="button" className="mk-player-error-retry" onClick={onRetryPlayback}>
              Retry
            </button>
          </div>
        )}
        <div className="mk-video-frame">
          {/* video.js v10 latches onto the [data-vjs-player] element and
              rewrites its className on init, which is why we don't put
              mk-video-frame on it directly - we'd lose the class the
              moment the player initialises. */}
          <div data-vjs-player>
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
                onError={(e) => {
                  if (e.currentTarget.src !== THUMB_FALLBACK_SVG) {
                    e.currentTarget.src = THUMB_FALLBACK_SVG;
                  }
                }}
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
