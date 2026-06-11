// Maneki main app — three-pane browse, now-playing, transport, overlays.

import React from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { MK_API } from "./_api.js";
import { MK_AUDIO } from "./_audio.js";
import { MK_DESKTOP } from "./_desktop.js";
import { MK_VIDEO } from "./_video.js";
import { TopBar, MainArea, KindRail, FullscreenViz, TweaksControls } from "./chrome.jsx";
import { fmtDur, parseDur } from "./format.js";
import { CommandPalette, LyricsOverlay, SearchDropdown, ShortcutsOverlay } from "./overlays.jsx";
import { store } from "./store.js";
import { VIZ_THEMES } from "./themes.js";
import { useTweaks } from "./tweaks-panel.jsx";
import { ConnectionBanner } from "./views.jsx";
import { WiredLoginView, loadAlbumTracks, resume } from "./_wiring.jsx";

const { useState: uS, useEffect: uE, useMemo: uM, useRef: uR, useCallback: uC } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "layout": "topband",
  "preset": "tokyo",
  "lcd": false,
  "lcdColor": "green",
  "theme": "dark",
  "accent": "tokyo",
  "viz": "bars",
  "vizTheme": "accent",
  "density": "comfortable",
  "fontScale": 1,
  "showSpectrum": true,
  "vizDelay": 0,
  "fullbleedCover": false
}/*EDITMODE-END*/;

// Layout variants:
//   topband   — current Maneki: Now Playing as top hero band (with Spectrum)
//   bottombar — slim bottom transport bar + expandable mini-player
//   rightrail — Spotify-ish dedicated right column for Now Playing

// Accent palettes. Each defines: accent (chrome links/active), highlight
// (now-playing track titles), viz [lo,mid,hi] gradient stops.
const PALETTES = {
  tokyo: {
    name: "Tokyo Night",
    accent: "#7aa2f7",
    highlight: "#ff9e64",
    viz: { lo: "#bcd47a", mid: "#e6c065", hi: "#f08aa6" },
  },
  cool: {
    name: "Cool — cyan & violet",
    accent: "#6cc4d8",
    highlight: "#bb88e0",
    viz: { lo: "#6cc4d8", mid: "#8a9cf0", hi: "#bb88e0" },
  },
  warm: {
    name: "Warm — coral & rose",
    accent: "#f0a070",
    highlight: "#ff7a8a",
    viz: { lo: "#f8d878", mid: "#f0a070", hi: "#e07090" },
  },
  mono: {
    name: "Mono + lime accent",
    accent: "#c4ff5e",
    highlight: "#c4ff5e",
    viz: { lo: "#9aa0a8", mid: "#c4c8ce", hi: "#c4ff5e" },
  },
};

// Dedicated spectrum colour themes, independent of the chrome accent.
// Selected via the command palette ("Spectrum colors: …") and stored in
// the `vizTheme` tweak; the special value "accent" (the default) follows
// the active accent palette's viz gradient. Each gradient runs lo (bar
// base) -> mid -> hi (bar tip); see vGrad in visualizer.jsx.
// VIZ_THEMES moved to themes.js (imported above).

function App() {
  const { ARTISTS, STATIONS, LYRICS_BOADICEA } = store.DATA;
  const [t, setT] = useTweaks(TWEAK_DEFAULTS);
  const tweak = (k, v) => setT(typeof k === "object" ? k : { [k]: v });

  // Session state
  const [authed, setAuthed] = uS(false);
  const [user, setUser] = uS("admin");
  // WIRING: lazy-initialise so the splash shows on first render if a
  // saved session exists. Without this we'd flash the login form for
  // 3-4 seconds while MK_RESUME does the library load on every launch.
  const [resuming, setResuming] = uS(() => !!MK_API?.loadSession?.());

  // Browse selection
  const [section, setSection] = uS("library"); // "library" | "stations" | "starred" | "videos"
  const [artistId, setArtistId] = uS(null);
  const [albumId, setAlbumId] = uS(null);

  // Video — `hasVideo` is null until the capability probe completes (then
  // `true` for Maneki servers with /video/api/* or `false` for everything
  // else, including non-Maneki Subsonic servers like Navidrome). The
  // sidebar's VIDEO section is hidden when hasVideo !== true.
  // Vertical-tabs mode: the whole SPA is either in "audio" or "video"
  // mode at a time (matching the user's "play music OR watch a movie"
  // intent). hasAudio/hasVideo control which tabs are shown.
  const [hasAudio, setHasAudio] = uS(true);
  const [hasVideo, setHasVideo] = uS(false);
  // YouTube is a top-level source alongside audio/video. Available on any
  // maneki server (remote, needs nothing on disk), so it's independent of
  // whether local video files exist.
  const [hasYoutube, setHasYoutube] = uS(false);
  const [kind, setKind] = uS("audio");
  const [selectedVideo, setSelectedVideo] = uS(null);
  // Switch top-level kind, dropping any open player so a local selection
  // doesn't bleed into the YouTube view (or vice-versa).
  const switchKind = React.useCallback((k) => { setKind(k); setSelectedVideo(null); }, []);
  // Player-only fullscreen mode. CSS pins .mk-video-player-pane to
  // the viewport and hides everything else when this is true. We
  // drive it ourselves instead of trying to use the HTML5
  // Fullscreen API because that API is unreliable in WKWebView
  // (Tauri) and the user wants ONLY the video element to fill the
  // screen, not the whole window (window-level fullscreen leaves
  // the topbar / video list visible at their grid sizes).
  const [playerFs, setPlayerFs] = uS(false);
  const togglePlayerFs = React.useCallback(() => setPlayerFs((v) => !v), []);
  // Theater mode: like YouTube's `t` shortcut. Hides the videos list +
  // splitter so the player pane spans the entire video area. Lighter
  // than playerFs (the topbar / mode rail stay visible); CSS drives the
  // layout via the body[data-video-theater] attribute.
  const [theater, setTheater] = uS(false);
  React.useEffect(() => {
    document.body.dataset.videoTheater = theater ? "true" : "false";
    return () => { document.body.dataset.videoTheater = "false"; };
  }, [theater]);
  React.useEffect(() => {
    if (!selectedVideo && theater) setTheater(false);
  }, [selectedVideo, theater]);
  // Toggle a body data attribute so the CSS rule can target the
  // outermost element; React owns the state but CSS owns the layout.
  // Also drive native OS window fullscreen via MK_DESKTOP when
  // running inside a desktop wrapper. The CSS pin makes the player
  // pane fill the window; the OS fullscreen makes the WINDOW fill
  // the screen (separate Space on macOS, menu bar + dock hidden).
  // Combined: video covers the entire physical display with no
  // chrome of any kind. In a plain browser tab MK_DESKTOP.kind is
  // null and the OS call no-ops, so the CSS pin is the whole story.
  React.useEffect(() => {
    document.body.dataset.playerFullscreen = playerFs ? "true" : "false";
    if (MK_DESKTOP?.kind) MK_DESKTOP.setFullscreen(playerFs);
    return () => { document.body.dataset.playerFullscreen = "false"; };
  }, [playerFs]);
  // When the selection clears (Close button), exit fullscreen too -
  // there's nothing to be fullscreen on.
  React.useEffect(() => {
    if (!selectedVideo && playerFs) setPlayerFs(false);
  }, [selectedVideo, playerFs]);
  // Re-probe whenever `authed` flips (fresh login: previous effect
  // run found no session and bailed). The previous `[]` dep ran once
  // at mount only, so users who logged in on a clean install saw
  // hasVideo=false forever (rail hidden, video tab unreachable) until
  // they refreshed the page.
  React.useEffect(() => {
    if (!authed) return;
    const session = MK_API?.loadSession?.();
    if (!session || typeof MK_VIDEO?.capabilities !== "function") return;
    let cancelled = false;
    MK_VIDEO.capabilities(session).then((caps) => {
      if (cancelled) return;
      setHasVideo(caps?.video === true);
      setHasYoutube(caps?.youtube === true);
      if (caps && typeof caps.audio === "boolean") setHasAudio(caps.audio);
    });
    return () => { cancelled = true; };
  }, [authed]);
  // Auto-switch away from the (empty) audio tab when there's no audio:
  // prefer local video, else YouTube. Only acts while still on the default
  // `audio` kind, so it never overrides an explicit switch OR a restored
  // deep-link (e.g. refreshing on #/youtube with a video-only library).
  React.useEffect(() => {
    if (hasAudio || kind !== "audio") return;
    if (hasVideo) setKind("video");
    else if (hasYoutube) setKind("youtube");
  }, [hasAudio, hasVideo, hasYoutube, kind]);
  const session = MK_API?.loadSession?.() || null;

  // ---- Deep-linking: keep the nav selection and the URL hash in sync. ----
  // The UI is unchanged; this just mirrors section/kind/artist/album/video
  // into the hash (#/library/artist/:id/album/:id, #/video/v/:id, …) so any
  // view is addressable, refresh restores it, and back/forward work. The
  // `lastPathRef` guard breaks the two-way feedback loop (a path we just
  // pushed must not be re-applied as if the user navigated).
  const navigate = useNavigate();
  const location = useLocation();
  const lastPathRef = uR("");
  // Set once the URL has been parsed into state on first load. Until then the
  // State->URL effect must NOT push: it's declared first, so on mount it would
  // run with the default (audio/library) state and clobber a deep-linked URL
  // like /video/youtube before URL->State restores it (refresh -> /library bug).
  const routeRestoredRef = uR(false);
  const navPath = () => {
    if (kind === "youtube") {
      return selectedVideo ? `/youtube/v/${encodeURIComponent(selectedVideo.id)}` : "/youtube";
    }
    if (kind === "video") {
      return selectedVideo ? `/video/v/${encodeURIComponent(selectedVideo.id)}` : "/video";
    }
    if (section === "stations") return "/stations";
    if (section === "starred") return "/starred";
    if (artistId && albumId) return `/library/artist/${artistId}/album/${albumId}`;
    if (artistId) return `/library/artist/${artistId}`;
    return "/library";
  };
  // State -> URL.
  uE(() => {
    if (!authed || !routeRestoredRef.current) return;
    const p = navPath();
    if (p !== location.pathname && p !== lastPathRef.current) {
      lastPathRef.current = p;
      navigate(p);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed, kind, section, artistId, albumId, selectedVideo]);
  // URL -> State (first load, back/forward, pasted link).
  uE(() => {
    if (!authed) return;
    const path = location.pathname;
    // Mark the initial restore done so State->URL may start pushing. Set even
    // when we early-return below (the URL already matches state).
    routeRestoredRef.current = true;
    if (path === lastPathRef.current) return; // we just pushed this
    lastPathRef.current = path;
    const seg = path.split("/").filter(Boolean);
    if (seg[0] === "video") {
      setKind("video");
      if (seg[1] === "v" && seg[2]) {
        // Deep-link into a local player: resolve the full entry by id (ids can
        // contain spaces/brackets, so they're percent-encoded in the path).
        MK_VIDEO?.getVideo?.(session, decodeURIComponent(seg[2]))
          .then((v) => setSelectedVideo(v))
          .catch(() => setSelectedVideo(null));
      } else {
        setSelectedVideo(null);
      }
    } else if (seg[0] === "youtube") {
      setKind("youtube");
      if (seg[1] === "v" && seg[2]) {
        // Deep-link into a YouTube player: resolve via the YouTube API and
        // tag the object so the player picks the YouTube HLS source.
        MK_VIDEO?.ytVideo?.(session, decodeURIComponent(seg[2]))
          .then((v) => setSelectedVideo({ id: v.id, name: v.title, duration_s: v.duration_s, source: "youtube" }))
          .catch(() => setSelectedVideo(null));
      } else {
        setSelectedVideo(null);
      }
    } else if (seg[0] === "stations") {
      setKind("audio"); setSection("stations");
    } else if (seg[0] === "starred") {
      setKind("audio"); setSection("starred");
    } else {
      setKind("audio"); setSection("library");
      setArtistId(seg[1] === "artist" ? seg[2] || null : null);
      setAlbumId(seg[3] === "album" ? seg[4] || null : null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed, location.pathname]);

  // Star state (per-track keyed "artistId/albumId/trackN"). Seeded from
  // MK_DATA.STARRED_TRACKS (getStarred2) rather than scanning loaded
  // tracks — albums load their tracks lazily now, so the per-album
  // scan would miss every star until each album was opened.
  const [starred, setStarred] = uS(() => {
    const s = new Set();
    (store.DATA.STARRED_TRACKS || []).forEach((t) => s.add(t.key));
    return s;
  });
  // The useState initializer above runs at App mount — which is BEFORE
  // the library (and thus STARRED_TRACKS) has loaded, on both the login
  // and resume paths. Re-seed once `authed` flips true, which only
  // happens after loadLibrary has populated MK_DATA. Merge rather than
  // replace so any star toggled in the gap survives.
  uE(() => {
    if (!authed) return;
    const seed = store.DATA.STARRED_TRACKS || [];
    if (!seed.length) return;
    setStarred((prev) => {
      const next = new Set(prev);
      seed.forEach((t) => next.add(t.key));
      return next;
    });
  }, [authed]);
  const isStarred = (key) => starred.has(key);
  const toggleStar = (key) => {
    setStarred((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
    // WIRING: forward to /rest/star or /rest/unstar so the server
    // sees the change too. `key` is "artistId/albumId/trackN" — we
    // resolve back to the real song id via the cached library tree.
    if (!MK_API || !store.SESSION) return;
    const [aId, alId, trN] = key.split("/");
    const a = store.DATA.ARTISTS.find((x) => x.id === aId);
    const al = a?.albums.find((x) => x.id === alId);
    let tr = al?.tracks.find((x) => String(x.n) === trN);
    // When the album's tracks aren't loaded (e.g. unstarring straight
    // from the Starred view), resolve the song id from the getStarred2
    // seed instead, which carries the trackId directly.
    if (!tr?.trackId) tr = (store.DATA.STARRED_TRACKS || []).find((s) => s.key === key);
    if (!tr?.trackId) return;
    const wasStarred = starred.has(key);
    const fn = wasStarred ? MK_API.unstar : MK_API.star;
    fn(store.SESSION, { id: tr.trackId }).catch((err) => {
      console.warn("[wiring] star/unstar failed:", err);
      // Roll back the optimistic local toggle so the heart matches
      // what the server actually thinks.
      setStarred((prev) => {
        const next = new Set(prev);
        if (wasStarred) next.add(key); else next.delete(key);
        return next;
      });
      store.setConnError?.({
        message: `Couldn't update star on the server: ${err?.message || err}`,
        retry: () => toggleStar(key),
      });
    });
  };

  // Playback state
  const [playing, setPlaying] = uS(false);
  const [muted, setMuted] = uS(false);
  const [vol, setVol] = uS(0.85);
  const [pos, setPos] = uS(34);    // seconds
  const [dur, setDur] = uS(212);   // seconds
  const [now, setNow] = uS(null);  // { artistId, albumId, trackN, trackId, station? }
  const [radioTitle, setRadioTitle] = uS(""); // ICY StreamTitle of the current station
  const [shuffle, setShuffle] = uS(false);
  const [repeat, setRepeat] = uS("off"); // off | album | track
  // One stats toggle drives both overlays — the audio one (Now Playing)
  // and the video one (player) — from a single button in the topbar.
  const [showStats, setShowStats] = uS(false);

  // Overlays
  const [showShortcuts, setShowShortcuts] = uS(false);
  const [showPalette, setShowPalette] = uS(false);
  const [showLyrics, setShowLyrics] = uS(false);
  const [fullscreenViz, setFullscreenViz] = uS(false);
  const [showConn, setShowConn] = uS(false);
  // WIRING: `connError` is a richer connection-error state populated
  // by the wiring layer when a fetch fails or audio can't play.
  // Shape: { message, retry? }. When set, the ConnectionBanner shows
  // the message and (if present) wires Retry to the retry callback.
  const [connError, setConnError] = uS(null);

  // Search
  const [q, setQ] = uS("");
  const [searchOpen, setSearchOpen] = uS(false);
  const searchInputRef = uR(null);

  // Loading state (one-shot — flips after a moment so list goes from skeleton to data).
  const [loaded, setLoaded] = uS(false);
  uE(() => {
    if (!authed) { setLoaded(false); return; }
    const t = setTimeout(() => setLoaded(true), 750);
    return () => clearTimeout(t);
  }, [authed]);

  // Album tracks load lazily (see _wiring.jsx MK_loadAlbumTracks): the
  // login-time library load only fetches album shells, so an album's
  // `tracks` array is empty until it's opened or played. The wiring
  // layer fills the array in place; bumping this counter forces the
  // memoised views that read `.tracks` to recompute once it lands.
  const [albumTracksTick, setAlbumTracksTick] = uS(0);

  // === WIRING (added on top of the designer artifact) ===
  // The original artifact ran a `setInterval` to fake a playback clock
  // because the design preview had no audio. Now `_audio.js` owns a
  // real `<audio>` element and `_api.js` builds Subsonic stream URLs.
  // These effects bridge React state <-> that audio element. Keep this
  // block together so the next design-zip drop is easy to forward-port.

  // handleNext is declared below; ref it so the audio-ended listener,
  // bound once, doesn't capture a stale first-render closure.
  const handleNextRef = uR(null);

  // Load the right URL whenever `now` changes (track click, prev/next,
  // station click, search-result pick all funnel through here). Also
  // call play() right after load — when the user clicks a second track
  // while the first is playing, setPlaying(true) is a no-op (value
  // unchanged) and the separate [playing] effect doesn't re-fire. Without
  // an explicit play() here the new track loads but stays paused.
  uE(() => {
    if (!now || !MK_AUDIO) return;
    let loaded = false;
    if (now.stationId) {
      const st = store.DATA.STATIONS.find((s) => s.id === now.stationId);
      if (st?.streamUrl) { MK_AUDIO.load(st.streamUrl); loaded = true; }
    } else if (store.SESSION && now.trackId) {
      // Stream straight from now.trackId — every setNow already carries
      // it, so we don't need the album's tracks loaded to start playback
      // (matters when playing from search / the Starred view).
      MK_AUDIO.load(MK_API.streamUrl(store.SESSION, now.trackId));
      loaded = true;
    }
    if (loaded) MK_AUDIO.play();
  }, [now]);

  // Forward play/pause state to the audio element.
  uE(() => {
    if (!MK_AUDIO) return;
    if (playing) MK_AUDIO.play();
    else MK_AUDIO.pause();
  }, [playing]);

  // Forward volume / muted to the audio element.
  uE(() => { MK_AUDIO?.setVolume(vol); }, [vol]);
  uE(() => { MK_AUDIO?.setMuted(muted); }, [muted]);

  // Forward the manual spectrum-delay offset. Added on top of the
  // auto-detected output latency (see _audio.js); covers stacks that
  // under-report outputLatency, where the spectrum still leads the sound.
  uE(() => { MK_AUDIO?.setVizDelay?.(t.vizDelay || 0); }, [t.vizDelay]);

  // Real audio time/duration/end -> React state. timeupdate from <audio>
  // fires ~4 Hz on Chromium / WebKit; pushing every tick re-renders the
  // entire App at 4 Hz, which on Tauri/WKWebView competes with the
  // visualizer canvas paint for the main thread and shows up as
  // sluggish mouse handling. Coalesce to once per second by quantising
  // to integer seconds — every consumer of `pos` (LCDTime, fmtDur,
  // scrub-bar slider) renders at second resolution anyway.
  uE(() => {
    if (!MK_AUDIO) return;
    const offT = MK_AUDIO.onTimeUpdate((t) => {
      setPos((prev) => Math.floor(t) === Math.floor(prev) ? prev : Math.floor(t));
    });
    const offD = MK_AUDIO.onDurationChange((d) => { if (d > 0) setDur(d); });
    const offE = MK_AUDIO.onEnded(() => handleNextRef.current?.());
    // Treat the <audio> element as the source of truth for `playing`, so a
    // pause triggered from outside the transport button (e.g. a video
    // starting) keeps the UI honest. And when music actually starts, stop
    // any mounted video player — the two must never play at once.
    const offPl = MK_AUDIO.onPlay(() => {
      setPlaying(true);
      try { store.videoPlayer?.pause?.(); } catch { /* player disposed */ }
    });
    const offPa = MK_AUDIO.onPause(() => setPlaying(false));
    return () => { offT(); offD(); offE(); offPl(); offPa(); };
  }, []);

  // Theme toggle on root.
  uE(() => {
    document.documentElement.dataset.theme = t.theme || "dark";
    document.documentElement.dataset.density = t.density || "comfortable";
    document.documentElement.dataset.layout = t.layout || "topband";
    document.documentElement.dataset.preset = t.preset || "tokyo";
    document.documentElement.dataset.lcd = t.lcd ? "on" : "off";
    document.documentElement.dataset.lcdColor = t.lcdColor || "green";
    document.documentElement.style.setProperty("--mk-font-scale", String(t.fontScale || 1));
    const p = PALETTES[t.accent] || PALETTES.tokyo;
    document.documentElement.style.setProperty("--mk-accent", p.accent);
    document.documentElement.style.setProperty("--mk-highlight", p.highlight);
  }, [t.theme, t.density, t.layout, t.fontScale, t.accent, t.preset, t.lcd, t.lcdColor]);

  // Derived data
  const artist = uM(() => ARTISTS.find((a) => a.id === artistId) || null, [artistId]);
  const album = uM(() => artist?.albums.find((al) => al.id === albumId) || null, [artist, albumId]);
  const nowArtist = uM(() => now?.artistId ? ARTISTS.find((a) => a.id === now.artistId) : null, [now]);
  const nowAlbum = uM(() => nowArtist?.albums.find((al) => al.id === now?.albumId) || null, [nowArtist, now]);
  const nowTrack = uM(() => nowAlbum?.tracks.find((t2) => t2.trackId === now?.trackId) || null, [nowAlbum, now, albumTracksTick]);
  const nowStation = uM(() => now?.stationId ? STATIONS.find((s) => s.id === now.stationId) : null, [now]);

  // Lazily load tracks for the album in view AND the now-playing album.
  // The login load only fetched album shells; this fills their `tracks`
  // arrays the moment they're needed — opening an album (tracks pane) or
  // starting one playing (next/prev + auto-advance need the full list).
  // MK_loadAlbumTracks mutates the album object in place; the tick bump
  // re-renders the views that read `.tracks`.
  uE(() => {
    if (!authed) return;
    if (typeof loadAlbumTracks !== "function") return;
    const sess = MK_API?.loadSession?.();
    if (!sess) return;
    const targets = [];
    if (artist && album && !album.tracksLoaded) targets.push([artist.id, album.id]);
    if (now && !now.stationId && now.artistId && now.albumId) {
      const na = ARTISTS.find((x) => x.id === now.artistId);
      const nal = na?.albums.find((x) => x.id === now.albumId);
      if (nal && !nal.tracksLoaded) targets.push([now.artistId, now.albumId]);
    }
    if (!targets.length) return;
    let cancelled = false;
    Promise.all(targets.map(([aid, alid]) => loadAlbumTracks(sess, aid, alid)))
      .then(() => { if (!cancelled) setAlbumTracksTick((n) => n + 1); })
      .catch((err) => console.warn("[app] lazy album-track load failed:", err));
    return () => { cancelled = true; };
  }, [authed, artist, album, now]);

  // Poll the server for the current station's ICY StreamTitle (the live
  // song / programme). The radioStream proxy parses it off the upstream
  // as the audio flows through, and radioMeta hands back the latest one.
  // Reset on every station change so a stale title never bleeds across,
  // fetch once immediately, then refresh on an interval while a station
  // is selected. Failures are swallowed — metadata is best-effort and a
  // missing title just falls back to the "Radio" label.
  uE(() => {
    setRadioTitle("");
    const metaUrl = nowStation?.metaUrl;
    if (!metaUrl || !MK_API || !store.SESSION) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const title = await MK_API.radioMeta(store.SESSION, metaUrl);
        if (!cancelled) setRadioTitle(title || "");
      } catch (_e) { /* best-effort */ }
    };
    poll();
    const id = setInterval(poll, 10000);
    return () => { cancelled = true; clearInterval(id); };
  }, [nowStation]);

  // Starred-tracks roll-up. Two sources, deduped by key: tracks from
  // albums whose songs have been lazily loaded (authoritative — reflects
  // any in-session star toggles), plus the getStarred2 seed for albums
  // not yet opened. Filtered by the live `starred` set so unstarring
  // during the session removes the row immediately.
  const starredTracks = uM(() => {
    const out = [];
    const seen = new Set();
    ARTISTS.forEach((a) => a.albums.forEach((al) => al.tracks.forEach((tr) => {
      const key = `${a.id}/${al.id}/${tr.n}`;
      if (starred.has(key)) { out.push({ artistId: a.id, artistName: a.name, albumId: al.id, albumName: al.name, ...tr, key }); seen.add(key); }
    })));
    (store.DATA.STARRED_TRACKS || []).forEach((t) => {
      if (starred.has(t.key) && !seen.has(t.key)) out.push(t);
    });
    return out;
  }, [starred, albumTracksTick]);

  // Search results — server-side via Subsonic search3. Local matching
  // used to scan every loaded track, but tracks now load lazily per
  // album, so a client-side scan would only find songs in albums the
  // user happened to have opened. search3 hits the server's FTS index
  // (sub-millisecond on big libraries) for full-library track titles.
  // Debounced so each keystroke doesn't fire a request.
  const [results, setResults] = uS({ artists: [], albums: [], tracks: [] });
  uE(() => {
    const ql = q.trim();
    if (!ql) { setResults({ artists: [], albums: [], tracks: [] }); return; }
    const sess = MK_API?.loadSession?.();
    if (!sess || typeof MK_API.search3 !== "function") {
      setResults({ artists: [], albums: [], tracks: [] });
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const r = await MK_API.search3(sess, ql, { artistCount: 20, albumCount: 20, songCount: 40 });
        if (cancelled) return;
        const artists = (r.artist || []).map((a) => ({ id: a.id, name: a.name }));
        const albums = (r.album || []).map((al) => ({
          id: al.id,
          name: al.name,
          year: al.year || "",
          artistId: al.artistId || "",
          artistName: al.artist || "",
        }));
        const tracks = (r.song || []).map((s) => ({
          n: s.track ?? 0,
          title: s.title || "",
          trackId: s.id,
          artistId: s.artistId || "",
          artistName: s.artist || "",
          albumId: s.albumId || "",
          albumName: s.album || "",
        }));
        setResults({ artists, albums, tracks });
      } catch (err) {
        if (!cancelled) {
          console.warn("[app] search3 failed:", err);
          setResults({ artists: [], albums: [], tracks: [] });
        }
      }
    }, 180);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [q]);

  // Actions
  const playTrack = (artistId, albumId, trackN, trackId) => {
    const a = ARTISTS.find((x) => x.id === artistId);
    const al = a?.albums.find((x) => x.id === albumId);
    // Prefer trackId: trackN is not unique on compilations (per-disc
    // numbering), so a trackN lookup can resolve to the wrong song when
    // the same number appears twice. Fall back to trackN for callers
    // that don't pass an id.
    const tr = (trackId && al?.tracks.find((x) => x.trackId === trackId))
      || al?.tracks.find((x) => x.n === trackN);
    // The album's tracks may not be loaded yet (playing straight from
    // search or the Starred view). Fall back to the caller-supplied ids;
    // the lazy-load effect pulls in the now-playing album's tracks right
    // after, which fills in next/prev. Duration self-corrects once the
    // <audio> element reports it (onDurationChange).
    const id = tr?.trackId ?? trackId;
    if (!id) return;
    setNow({ artistId, albumId, trackN: tr?.n ?? trackN ?? 0, trackId: id });
    setPos(0);
    setDur(tr ? parseDur(tr.time) : 0);
    setPlaying(true);
  };
  const playStation = (stationId) => {
    setNow({ stationId });
    setPos(0);
    setDur(0); // live stream
    setPlaying(true);
  };
  const handlePlayPause = () => { if (now) setPlaying((p) => !p); };
  const handleNext = () => {
    if (now?.stationId) return;
    // No-op until the now-playing album's tracks have loaded (the lazy
    // effect fetches them as soon as a track starts, so this only guards
    // the brief race right after pressing play from search / Starred).
    if (!nowAlbum || !nowAlbum.tracks.length) return;
    const idx = nowAlbum.tracks.findIndex((tr) => tr.trackId === now.trackId);
    const next = nowAlbum.tracks[(idx + 1) % nowAlbum.tracks.length];
    setNow({ ...now, trackN: next.n, trackId: next.trackId });
    setPos(0); setDur(parseDur(next.time));
  };
  const handlePrev = () => {
    if (now?.stationId) return;
    if (!nowAlbum || !nowAlbum.tracks.length) return;
    const idx = nowAlbum.tracks.findIndex((tr) => tr.trackId === now.trackId);
    const prev = nowAlbum.tracks[(idx - 1 + nowAlbum.tracks.length) % nowAlbum.tracks.length];
    setNow({ ...now, trackN: prev.n, trackId: prev.trackId });
    setPos(0); setDur(parseDur(prev.time));
  };

  // WIRING: keep the ref the audio-ended listener uses in sync with
  // the latest handleNext closure (which captures the current `now`).
  handleNextRef.current = handleNext;

  // WIRING: expose the connection-error setter so non-React code
  // (wiring layer, audio controller, fetch wrappers) can pop the
  // banner when a network call fails. The setter is wiped on unmount
  // so stale references don't fire into a dead React tree.
  uE(() => {
    store.setConnError = setConnError;
    return () => { store.setConnError = null; };
  }, []);

  // WIRING: on first mount, see if there's a saved session and skip
  // the login form entirely if one is found. While the resume runs we
  // render a splash (see the early-return below); without it the login
  // form would briefly flash on every launch.
  uE(() => {
    if (authed || !resume) { setResuming(false); return; }
    if (!MK_API?.loadSession?.()) { setResuming(false); return; }
    let cancelled = false;
    resume()
      .then((session) => {
        if (cancelled) return;
        if (session) {
          setAuthed(true);
          setUser(session.user);
        }
      })
      .finally(() => { if (!cancelled) setResuming(false); });
    return () => { cancelled = true; };
  }, []);

  // Keyboard shortcuts
  uE(() => {
    if (!authed) return;
    const onKey = (e) => {
      const target = e.target;
      const isInput = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");
      const meta = e.metaKey || e.ctrlKey;
      if (meta && (e.key === "p" || e.key === "P") && !e.shiftKey) {
        e.preventDefault(); setShowPalette((v) => !v); return;
      }
      // Let the browser/OS keep every other modified chord (Cmd/Ctrl/Alt
      // + key: find, reload, address bar, etc). Our single-key shortcuts
      // below are bare-key only, so a held modifier must fall through --
      // otherwise e.g. Cmd+F would trigger the "f" fullscreen-viz toggle
      // instead of the browser's find. Cmd+P (palette) is handled above.
      if (meta || e.altKey) return;
      if (isInput) return;
      // In video mode the focal player is the video.js instance, not the
      // audio chrome. Route every audio-aware key (transport + arrows +
      // mute) to the video player and `return` so the audio switch below
      // can't fire and clobber state. Help/palette shortcuts (?, Cmd+P)
      // are global, handled above this block.
      if (kind !== "audio" && selectedVideo && store.videoPlayer) {
        const p = store.videoPlayer;
        switch (e.key) {
          case "f":
            e.preventDefault();
            // No-op until the user has actually started playback. With
            // the poster still showing (player.hasStarted() === false)
            // and no <video> currentSrc loaded, calling
            // requestFullscreen on the player root falls through to the
            // poster <img>, which Chrome handles as "open image in new
            // tab" — exactly the broken behaviour the user reported.
            // Same gate applies to the command-palette entry below.
            if (typeof p.hasStarted === "function" && !p.hasStarted()) return;
            // Browser: use the HTML5 Fullscreen API on the player so the
            // browser chrome (URL bar, tab strip) actually disappears
            // and the video covers the physical screen — what YouTube
            // does, what the user expects. video.js wraps the call so
            // we go through `requestFullscreen()` on the player root
            // and get the controls overlay for free.
            //
            // Tauri / Electron: WKWebView's HTML5 Fullscreen API is
            // flaky, so fall back to the CSS-pin (`playerFs`) path
            // which is also what the desktop wrappers' native window
            // fullscreen hook into. Detection mirrors _video.js's
            // `isDesktop` check.
            {
              const isDesktopWebview =
                !!window.__TAURI__
                || (navigator.userAgent || "").toLowerCase().includes("electron/");
              if (isDesktopWebview) {
                togglePlayerFs();
              } else if (p.isFullscreen()) {
                p.exitFullscreen();
              } else {
                p.requestFullscreen();
              }
            }
            return;
          case " ":
            e.preventDefault();
            if (p.paused()) p.play(); else p.pause();
            return;
          case "Escape":
            // Priority: close any open modal first, then exit
            // player-only fullscreen, then any HTML5 fullscreen
            // that might still be active.
            if (showShortcuts) { setShowShortcuts(false); return; }
            if (showPalette) { setShowPalette(false); return; }
            if (showLyrics) { setShowLyrics(false); return; }
            if (playerFs) { setPlayerFs(false); return; }
            if (p.isFullscreen()) p.exitFullscreen();
            return;
          case "ArrowLeft":
            e.preventDefault();
            p.currentTime(Math.max(0, p.currentTime() - 5));
            return;
          case "ArrowRight":
            e.preventDefault();
            p.currentTime(Math.min(p.duration() || Infinity, p.currentTime() + 5));
            return;
          case "ArrowUp":
            e.preventDefault();
            p.volume(Math.min(1, p.volume() + 0.05));
            if (p.muted()) p.muted(false);
            return;
          case "ArrowDown":
            e.preventDefault();
            p.volume(Math.max(0, p.volume() - 0.05));
            return;
          case "m":
            p.muted(!p.muted());
            return;
          case "t":
            e.preventDefault();
            setTheater((v) => !v);
            return;
          case "?":
            // Handle here so the audio switch below can't also run and
            // unexpectedly affect playback state. setShowShortcuts is
            // the only side effect we want.
            setShowShortcuts((v) => !v);
            return;
          // Audio-only transport / nav keys are no-ops in video mode -
          // swallow them so they can't reach the audio shortcuts below.
          case "n": case "p": case "s": case "r": case "l": case "/":
            return;
          default:
            // Fall through so help/palette and other globals still work.
            break;
        }
      }
      // In video mode without a selected video, swallow audio-only
      // shortcuts so they can't (eg) activate the audio FFT visualiser
      // overlay or trigger transport on a player that doesn't exist.
      // The cross-mode keys (?, Esc, Cmd+P) are handled above.
      const isMediaModeNoPlayer = kind !== "audio";
      if (isMediaModeNoPlayer && ["f", "l", "/", "s", "r", "n", " ", "m", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
        return;
      }
      switch (e.key) {
        case " ": e.preventDefault(); handlePlayPause(); break;
        case "n": handleNext(); break;
        case "p": handlePrev(); break;
        case "m": setMuted((m) => !m); break;
        case "f": setFullscreenViz((v) => !v); break;
        case "l": setShowLyrics((v) => !v); break;
        case "?": setShowShortcuts((v) => !v); break;
        case "/": e.preventDefault(); searchInputRef.current?.focus(); setSearchOpen(true); break;
        case "Escape":
          if (fullscreenViz) setFullscreenViz(false);
          else if (showShortcuts) setShowShortcuts(false);
          else if (showPalette) setShowPalette(false);
          else if (showLyrics) setShowLyrics(false);
          else if (searchOpen) { setSearchOpen(false); setQ(""); }
          break;
        case "ArrowLeft": setPos((p) => { const np = Math.max(0, p - 5); MK_AUDIO?.seek?.(np); return np; }); break;
        case "ArrowRight": setPos((p) => { const np = Math.min(dur, p + 5); MK_AUDIO?.seek?.(np); return np; }); break;
        case "ArrowUp": setVol((v) => Math.min(1, v + 0.05)); setMuted(false); e.preventDefault(); break;
        case "ArrowDown": setVol((v) => Math.max(0, v - 0.05)); e.preventDefault(); break;
        case "s": setShuffle((s) => !s); break;
        case "r": setRepeat((r) => r === "off" ? "album" : r === "album" ? "track" : "off"); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [authed, now, dur, fullscreenViz, showShortcuts, showPalette, showLyrics, searchOpen, kind, selectedVideo, playerFs, theater]);

  // Sign out
  const signOut = () => {
    setAuthed(false);
    setNow(null);
    setPlaying(false);
    setArtistId(null); setAlbumId(null);
    // WIRING: also clear the persisted Subsonic session so the next
    // launch doesn't auto-resume into the same account. Without this,
    // MK_RESUME() rehydrates from localStorage and bypasses the login
    // form — contradicting the "Clear session and sign out" tooltip.
    MK_API?.clearSession?.();
    store.SESSION = null;
    if (store.DATA) {
      store.DATA.ARTISTS = [];
      store.DATA.STATIONS = [];
      store.DATA.STARRED_TRACKS = [];
    }
    MK_AUDIO?.pause?.();
  };

  // Palette command runner. In video mode, commands route to the
  // video.js player (when one is mounted) instead of the audio chrome.
  // Cross-mode commands (Show shortcuts, Sign out) work either way.
  const runCmd = (c) => {
    const p = store.videoPlayer;
    // Spectrum colour themes carry their key on the command itself.
    if (c.vizTheme) { tweak("vizTheme", c.vizTheme); return; }
    // Cross-mode commands (work without a player loaded).
    if (c.label === "Show keyboard shortcuts") { setShowShortcuts(true); return; }
    if (c.label === "Sign out") { signOut(); return; }
    if (c.label === "Switch to audio" && hasAudio) { switchKind("audio"); return; }
    if (c.label === "Switch to video" && hasVideo) { switchKind("video"); return; }
    if (c.label === "Switch to YouTube" && hasYoutube) { switchKind("youtube"); return; }
    if (kind !== "audio") {
      // All other commands in video / YouTube mode are no-ops without a
      // player. Falling through to the audio branch (eg activating the FFT
      // visualiser overlay) makes the app look broken.
      if (!p) return;
      if (c.label === "Play / pause") { if (p.paused()) p.play(); else p.pause(); return; }
      if (c.label === "Seek backward 5s") { p.currentTime(Math.max(0, p.currentTime() - 5)); return; }
      if (c.label === "Seek forward 5s") { p.currentTime(Math.min(p.duration() || Infinity, p.currentTime() + 5)); return; }
      if (c.label === "Volume up") { p.volume(Math.min(1, p.volume() + 0.1)); if (p.muted()) p.muted(false); return; }
      if (c.label === "Volume down") { p.volume(Math.max(0, p.volume() - 0.1)); return; }
      if (c.label === "Toggle mute") { p.muted(!p.muted()); return; }
      if (c.label === "Toggle theater mode") { setTheater((v) => !v); return; }
      if (c.label === "Toggle fullscreen") {
        // No-op until the user has actually started playback — see the
        // `f` shortcut handler above for why (poster <img> hijacks
        // requestFullscreen and Chrome treats it as "open in new tab").
        if (typeof p.hasStarted === "function" && !p.hasStarted()) return;
        // Same browser vs desktop split as the `f` shortcut: HTML5
        // Fullscreen API in the browser (covers the physical screen),
        // CSS-pin fallback in WKWebView / Electron.
        const isDesktopWebview =
          !!window.__TAURI__
          || (navigator.userAgent || "").toLowerCase().includes("electron/");
        if (isDesktopWebview) togglePlayerFs();
        else if (p.isFullscreen()) p.exitFullscreen();
        else p.requestFullscreen();
        return;
      }
      return;
    }
    if (c.label === "Play / pause") handlePlayPause();
    else if (c.label === "Next track") handleNext();
    else if (c.label === "Previous track") handlePrev();
    else if (c.label === "Volume up") setVol((v) => Math.min(1, v + 0.1));
    else if (c.label === "Volume down") setVol((v) => Math.max(0, v - 0.1));
    else if (c.label === "Toggle lyrics") setShowLyrics((v) => !v);
    else if (c.label === "Toggle visualizer") setFullscreenViz((v) => !v);
    else if (c.label === "Focus search") { searchInputRef.current?.focus(); setSearchOpen(true); }
    else if (c.label === "Show keyboard shortcuts") setShowShortcuts(true);
    else if (c.label === "Toggle shuffle") setShuffle((s) => !s);
    else if (c.label.startsWith("Cycle repeat")) setRepeat((r) => r === "off" ? "album" : r === "album" ? "track" : "off");
    else if (c.label === "Star current track" && now && !now.stationId) toggleStar(`${now.artistId}/${now.albumId}/${now.trackN}`);
    else if (c.label === "Go to Starred") { setSection("starred"); setArtistId(null); setAlbumId(null); }
    else if (c.label === "Go to Stations") { setSection("stations"); setArtistId(null); setAlbumId(null); }
    else if (c.label === "Sign out") signOut();
  };

  // Search-result pick
  const pickSearchResult = (r) => {
    if (r.kind === "artist") { setSection("library"); setArtistId(r.id); setAlbumId(null); }
    else if (r.kind === "album") { setSection("library"); setArtistId(r.artistId); setAlbumId(r.id); }
    else if (r.kind === "track") { setSection("library"); setArtistId(r.artistId); setAlbumId(r.albumId); playTrack(r.artistId, r.albumId, r.n, r.trackId); }
    setSearchOpen(false); setQ("");
  };

  if (!authed) {
    // WIRING: if a saved session is being restored, render a splash
    // instead of flashing the login form. The label below is the only
    // user-visible signal that something's happening, so keep it
    // short and recognisable.
    if (resuming) {
      return (
        <div className="mk-resume-shell">
          <div className="mk-resume-card">
            <div className="mk-resume-brand">Maneki</div>
            <div className="mk-resume-spinner" aria-hidden="true" />
            <div className="mk-resume-label">Loading library…</div>
          </div>
        </div>
      );
    }
    return (
      <>
        <WiredLoginView themeMode={t.theme} onConnect={({ url, user }) => { setAuthed(true); setUser(user); }} />
        <TweaksControls tweak={tweak} t={t} />
      </>
    );
  }

  const basePalette = PALETTES[t.accent] || PALETTES.tokyo;
  // A dedicated spectrum theme (vizTheme) overrides the accent's viz
  // gradient; the default "accent" follows the accent palette as before.
  const vizColors = (t.vizTheme && t.vizTheme !== "accent" && VIZ_THEMES[t.vizTheme])
    ? VIZ_THEMES[t.vizTheme].viz
    : basePalette.viz;
  const palette = { ...basePalette, viz: vizColors };

  return (
    <div className="mk-root" data-kind={kind}>
      <KindRail kind={kind} setKind={switchKind} hasAudio={hasAudio} hasVideo={hasVideo} hasYoutube={hasYoutube}/>
      <div className="mk-shell" data-layout={t.layout}>
      <TopBar
        user={user}
        q={q} setQ={(v) => { setQ(v); setSearchOpen(true); }}
        onFocusSearch={() => setSearchOpen(true)}
        onSignOut={signOut}
        searchInputRef={searchInputRef}
        showStats={showStats} onToggleStats={() => setShowStats((s) => !s)}
      />

      {showConn && (
        <ConnectionBanner
          message="GET /rest/getArtists timed out after 8s. Will retry automatically."
          onRetry={() => setShowConn(false)}
          onDismiss={() => setShowConn(false)}
        />
      )}

      {connError && (
        <ConnectionBanner
          message={connError.message}
          onRetry={() => {
            const r = connError.retry;
            setConnError(null);
            if (typeof r === "function") r();
          }}
          onDismiss={() => setConnError(null)}
        />
      )}

      <MainArea
        t={t} tweak={tweak}
        section={section} setSection={(s) => { setSection(s); setArtistId(null); setAlbumId(null); }}
        loaded={loaded}
        ARTISTS={ARTISTS}
        STATIONS={STATIONS}
        artist={artist} artistId={artistId} setArtistId={(id) => { setArtistId(id); setAlbumId(null); }}
        album={album} albumId={albumId} setAlbumId={setAlbumId}
        playTrack={playTrack}
        playStation={playStation}
        now={now} nowTrack={nowTrack} nowStation={nowStation} radioTitle={radioTitle}
        starredTracks={starredTracks}
        isStarred={isStarred} toggleStar={toggleStar}
        playing={playing} setPlaying={setPlaying}
        muted={muted} setMuted={setMuted}
        vol={vol} setVol={setVol}
        pos={pos} setPos={setPos} dur={dur}
        handlePlayPause={handlePlayPause} handleNext={handleNext} handlePrev={handlePrev}
        nowArtist={nowArtist} nowAlbum={nowAlbum}
        palette={palette}
        fullscreenViz={fullscreenViz} setFullscreenViz={setFullscreenViz}
        shuffle={shuffle} repeat={repeat}
        setShowLyrics={setShowLyrics}
        hasAudio={hasAudio} hasVideo={hasVideo} kind={kind} setKind={switchKind} session={session}
        selectedVideo={selectedVideo} setSelectedVideo={setSelectedVideo}
        q={q}
        showStats={showStats} onCloseStats={() => setShowStats(false)}
      />

      <SearchDropdown
        q={searchOpen && kind === "audio" ? q : ""}
        results={results}
        anchorEl={searchInputRef.current}
        onPick={pickSearchResult}
        onClose={() => setSearchOpen(false)}
      />
      <ShortcutsOverlay open={showShortcuts} onClose={() => setShowShortcuts(false)} kind={kind} />
      <CommandPalette open={showPalette} onClose={() => setShowPalette(false)} onRun={runCmd} kind={kind} hasAudio={hasAudio} hasVideo={hasVideo} hasYoutube={hasYoutube} />
      <LyricsOverlay
        open={showLyrics && !!nowTrack}
        onClose={() => setShowLyrics(false)}
        title={nowTrack?.title || ""}
        artist={nowArtist?.name || ""}
        lines={LYRICS_BOADICEA}
      />
      {fullscreenViz && (
        <FullscreenViz
          onClose={() => setFullscreenViz(false)}
          vizStyle={t.viz} tweak={tweak}
          running={playing}
          palette={palette}
          nowTrack={nowTrack} nowArtist={nowArtist} nowAlbum={nowAlbum}
          nowStation={nowStation} radioTitle={radioTitle}
          pos={pos} dur={dur}
          playing={playing} onPlayPause={handlePlayPause} onPrev={handlePrev} onNext={handleNext}
        />
      )}

      <TweaksControls tweak={tweak} t={t} setShowConn={setShowConn} />
      </div>
    </div>
  );
}

// fmtDur / parseDur moved to format.js (imported above).

export { App, PALETTES };
