// Wiring layer — bridges the Claude Designer artifact to the real
// Subsonic API. Lives outside the artifact (underscored filename) so
// the next design-zip drop only replaces `data.jsx`, `app.jsx`,
// `chrome.jsx`, etc., and not the wiring code below.
//
// What this file does:
//
//   1. Wraps `MK_LoginView` so submitting the form calls
//      `MK_API.login()` instead of just setting authed=true. On
//      success we save the session, fetch the library, populate
//      `MK_DATA`, and only then call the original `onConnect` to flip
//      the App into the shell view.
//
//   2. Replaces `MK_makeCover()` with a server-cover-art version when
//      the input string is a real Subsonic cover-art id (the legacy
//      procedural one stays for placeholder cases — empty/null ids).
//
//   3. Hooks `MK_AUDIO` events into App's pos / dur state by
//      polling the artifact's state setters indirectly: the artifact
//      already calls `MK_AUDIO.play/pause/seek/...` from the patched
//      action handlers in `app.jsx`. The pos-and-duration push-back
//      lives there too; see the comments in `app.jsx`.

import React from "react";
import { MK_API } from "./_api.js";
import { MK_AUDIO } from "./_audio.js";
import { LoginView } from "./views.jsx";
import { makeCover } from "./covers.jsx";
import { store } from "./store.js";

// ---------------------------------------------------------------
// 0. Helpers
// ---------------------------------------------------------------

  // Decide whether the user's base URL is maneki (Subsonic mounted
  // under /audio) or a 3rd-party Subsonic server (REST at the root).
  // Probes <url>/capabilities once and returns { base, hasAudio }:
  //   - maneki with audio  -> { base: <url>/audio, hasAudio: true }
  //   - maneki video-only  -> { base: <url>,       hasAudio: false }
  //   - 3rd-party / error   -> { base: <url>,       hasAudio: true }
  // Fails-open (treats the URL as a plain Subsonic root with audio) on
  // any network error so the rest of the login flow can surface a
  // useful auth/connection error instead of a probe error. The
  // hasAudio flag tells login() whether to validate the credential via
  // the Subsonic `ping` (audio present) or the native /auth/login
  // endpoint (video-only library, where /audio/rest/* isn't mounted).
async function resolveSubsonicBase(url) {
  // If the user already typed a path that ends with the maneki
  // mount (`/audio` or `/audio/`), trust them and don't double-append.
  if (/\/audio\/?$/.test(url)) return { base: url.replace(/\/+$/, ""), hasAudio: true };
  try {
    const resp = await fetch(url + "/capabilities", { cache: "no-store" });
    if (resp.ok) {
      const caps = await resp.json();
      if (caps && caps.server === "maneki") {
        if (caps.endpoints?.audio_subsonic) {
          return { base: url + "/audio", hasAudio: true };
        }
        // maneki server with no audio mount (video-only library).
        return { base: url, hasAudio: false };
      }
    }
  } catch (_e) {
    // ignore - 3rd-party server or network error
  }
  return { base: url, hasAudio: true };
}

// ---------------------------------------------------------------
// 1. Wrap LoginView so onConnect runs a real auth + data load.
// ---------------------------------------------------------------
const OriginalLoginView = LoginView;

function WiredLoginView(props) {
  const [busyLabel, setBusyLabel] = React.useState(null);
  async function handleConnect({ url, user, pass }) {
      // Authenticate against the real server, then preload the library
      // tree. Re-throw on failure so views.jsx's submit() catch sets
      // the LoginView's `err` state, which renders the .mk-login-error
      // message. Without re-throw the form silently looks like nothing
      // happened on connection-refused / wrong-credentials.
      try {
        // maneki mounts the Subsonic API at <base>/audio/rest/* (so
        // the unified server can host /video/* alongside). 3rd-party
        // Subsonic servers (Navidrome, Airsonic) put it at /rest/*
        // directly. Probe /capabilities to figure out which we're
        // talking to, then append /audio to the user's URL when it's
        // maneki. The user only ever types the base URL.
        const trimmed = url.replace(/\/+$/, "");
        const { base: baseUrl, hasAudio } = await resolveSubsonicBase(trimmed);
        setBusyLabel("Connecting…");
        const session = await MK_API.login({
          baseUrl,
          user,
          password: pass,
          hasAudio,
        });
        setBusyLabel("Loading library…");
        await loadLibrary(session);
        // Tell the artifact's App() to flip into the shell view.
        props.onConnect({ url: session.baseUrl, user: session.user, pass });
      } catch (err) {
        console.error("[wiring] login failed:", err);
        // Map raw fetch/network errors to something a human can act on.
        // Each browser emits a different message for "couldn't connect":
        //   Chromium: "Failed to fetch", "TypeError: NetworkError"
        //   WebKit (Safari / Tauri on macOS): "Load failed"
        //   Firefox: "NetworkError when attempting to fetch"
        // Plus DNS / TLS / timeout variants. Treat anything that smells
        // like a network-layer failure as connection-refused.
        const raw = String(err?.message || err);
        const networkSignals = /Failed to fetch|NetworkError|ERR_CONNECTION_REFUSED|Load failed|Could not connect|ENOTFOUND|timed? out/i;
        let friendly = raw;
        if (networkSignals.test(raw) || err instanceof TypeError) {
          friendly = `Couldn't reach the server at ${url}. Is it running and reachable from this device?`;
        } else if (/Subsonic 40/i.test(raw)) {
          friendly = "Wrong username or password.";
        } else if (/HTTP 401/i.test(raw)) {
          friendly = "Server rejected the credentials (HTTP 401).";
        } else if (/HTTP 5\d\d/i.test(raw)) {
          friendly = `Server error (${raw}). Check the serve logs.`;
        }
        // Reset the busy label so the next attempt starts cleanly.
        setBusyLabel(null);
        throw new Error(friendly);
      }
    }
    return React.createElement(OriginalLoginView, {
      ...props,
      onConnect: handleConnect,
      busyLabel,
    });
}

export { WiredLoginView };

// ---------------------------------------------------------------
// 2. Cover-art override — return real <img>-friendly URLs when the
//    album object has `coverArtUrl` set; fall back to the artifact's
//    procedural generator otherwise.
// ---------------------------------------------------------------
const OriginalMakeCover = makeCover;
export function wiredMakeCover(kind, baseColor) {
  // The artifact passes `al.cover` as the first arg. After the
  // adapter ran, that field IS the asset URL (string) for any album
  // that has cover art on the server. If it's still a procedural
  // tag (e.g. "enya", "blue") we fall through to the original.
  if (typeof kind === "string" && /^https?:\/\//.test(kind)) {
    return kind;
  }
  return OriginalMakeCover ? OriginalMakeCover(kind, baseColor) : "";
}

// ---------------------------------------------------------------
// 3. Library loader — populate store.DATA from the API.
// ---------------------------------------------------------------
  //
  // The artifact's chrome reads `window.MK_DATA.ARTISTS` (and friends)
  // at every render. To support partial loads we mutate the same
  // MK_DATA in place — first with `getArtists` (a flat artist list,
  // arrives in ~1 round-trip), then with `getArtist` for each artist's
  // album SHELLS (name / year / cover / track count — everything the
  // album grid needs). A consumer who renders early sees an artist list
  // with empty `albums` arrays; once the per-artist details land the
  // arrays fill in. Same approach for stations (a single round-trip).
  //
  // What we deliberately DON'T do here: fetch per-album track listings
  // (`getAlbum`). Those are loaded lazily by `MK_loadAlbumTracks` when
  // the user actually opens an album. Eagerly fetching every album's
  // songs on login meant one HTTP request per album — hundreds of them,
  // all queued behind the browser's ~6-connection-per-origin HTTP/1.1
  // cap — which is what made the initial load crawl. The album grid
  // never needed the songs; only the tracks pane does.
  //
  // Stars: `getStarred2` (one request, phase 1) gives us the full set of
  // starred songs up front, so the Starred view and the per-row heart
  // state work without every album's tracks being in memory.
  //
  // Concurrency: we kick all `getArtist` calls in parallel (Promise.all)
  // rather than serialising them. The maneki serve bump-tested its
  // thread pool to 256 for exactly this; other Subsonic servers handle
  // it fine too. For libraries with hundreds of artists this turns a
  // multi-second waterfall into a single round-trip + the slowest
  // per-artist call.
  async function loadLibrary(session) {
    const api = MK_API;

    // Skip the Subsonic phase entirely on a video-only library — the
    // server doesn't mount /audio/* there, so getArtists would 404 and
    // trigger the "Lost connection" banner. We probe /capabilities
    // first (always exists) to decide. Non-maneki Subsonic servers
    // don't have /capabilities, so a fetch failure means "treat as an
    // audio server and let getArtists run as before".
    let hasAudio = true;
    try {
      const capsResp = await fetch(new URL("/capabilities", session.baseUrl).toString(), {
        cache: "no-store",
      });
      if (capsResp.ok) {
        const caps = await capsResp.json();
        if (caps && typeof caps.audio === "boolean") hasAudio = caps.audio;
      }
    } catch (_e) {
      // ignore - falls through to the audio path
    }
    if (!hasAudio) {
      store.DATA = { ARTISTS: [], STATIONS: [], LYRICS_BOADICEA: [] };
      store.SESSION = session;
      return;
    }

    // Phase 1: roots — flat artist list + radio stations + starred
    // songs, all in parallel. getArtists is the auth-checking call; let
    // it surface errors so MK_RESUME / handleConnect can classify (auth
    // vs. transient). getInternetRadioStations and getStarred2 are
    // allowed to soft-fail (some servers don't expose radio; a missing
    // star list is not fatal — it just means nothing shows as starred).
    const [artists, radio, starredData] = await Promise.all([
      api.getArtists(session),
      api.getInternetRadioStations(session).catch(() => []),
      api.getStarred2(session).catch((err) => {
        console.warn("[wiring] getStarred2 failed:", err);
        return { song: [] };
      }),
    ]);

    // Pre-populate ARTISTS with placeholder shells (empty albums) so a
    // consumer that renders right now sees the sidebar populated.
    const seed = artists.map((a) => ({
      id: a.id,
      name: a.name,
      sortName: a.name,
      albumCount: a.albumCount || 0,
      trackCount: 0,
      bio: "",
      color: "#444",
      cover: api.coverArtUrl(session, a.coverArt || a.id, 200),
      albums: [],
    }));
    seed.sort((x, y) => x.name.localeCompare(y.name));

    // Play through maneki's same-origin radio proxy rather than the raw
    // upstream URL: the player's crossOrigin="anonymous" (needed for the
    // visualiser) makes the browser enforce CORS on the audio source and
    // every redirect hop, which most Icecast stations / their CDN
    // redirects fail. The proxy follows upstream server-side and adds the
    // server's CORS headers. See MK_API.radioStreamUrl.
    const stations = (radio || []).map((s) => ({
      id: s.id,
      name: s.name,
      streamUrl: api.radioStreamUrl(session, s.streamUrl),
      // Raw upstream URL kept alongside the proxied stream URL so the
      // now-playing poller can ask the server for this station's latest
      // ICY title (radioMeta is keyed by the upstream URL, not the proxy).
      metaUrl: s.streamUrl,
      homepageUrl: s.homepageUrl || "",
      icon: "(((",
    }));

    // Starred songs (from getStarred2). Each entry is a self-contained
    // row for the Starred view — it carries its own trackId and display
    // fields, so the view works even for albums whose tracks haven't
    // been lazily loaded yet. The key matches the "artistId/albumId/
    // trackNo" scheme used everywhere else (maneki's song payload derives
    // artistId from the album's artist dir, so it lines up with the tree).
    const starredSongs = (starredData && starredData.song) || [];
    const STARRED_TRACKS = starredSongs.map((s) => {
      const n = s.track ?? 0;
      const artistId = s.artistId || "";
      const albumId = s.albumId || "";
      return {
        key: `${artistId}/${albumId}/${n}`,
        artistId,
        artistName: s.artist || "",
        albumId,
        albumName: s.album || "",
        n,
        title: s.title || "",
        time: formatDuration(s.duration),
        trackId: s.id,
        suffix: s.suffix || "",
        starred: true,
      };
    });

    store.DATA = {
      ARTISTS: seed,
      STATIONS: stations,
      STARRED_TRACKS,
      LYRICS_BOADICEA: [],
    };
    store.SESSION = session;

    // Phase 2: album SHELLS via bulk getAlbumList2 pagination instead of a
    // getArtist-per-artist storm. One page (size 500) returns albums across
    // ALL artists, each carrying artistId, so a ~70-artist library loads in a
    // couple of round-trips rather than ~70 individual calls. Albums drop into
    // their artist's slot in place (alphabetical order, contiguous per artist)
    // so an in-flight render picks them up. Tracks still load lazily on album
    // open via MK_loadAlbumTracks; each shell carries `tracks: []` until then.
    let firstError = null;
    const slots = new Map(seed.map((s) => [s.id, s]));
    const PAGE = 500; // getAlbumList2's max `size`
    try {
      for (let offset = 0; ; offset += PAGE) {
        const page = await api.getAlbumList2(session, {
          type: "alphabeticalByName",
          size: PAGE,
          offset,
        });
        for (const al of page) {
          const slot = slots.get(al.artistId);
          if (!slot) continue; // album whose artist isn't in the index
          slot.albums.push({
            id: al.id,
            name: al.name,
            year: al.year || "",
            trackCount: al.songCount || 0,
            color: "#444",
            cover: api.coverArtUrl(session, al.coverArt || al.id, 200),
            coverArtUrl: api.coverArtUrl(session, al.coverArt || al.id, 600),
            tracks: [],
            tracksLoaded: false,
          });
        }
        if (page.length < PAGE) break; // short page == last page
      }
      // Roll up each artist's track count from its now-loaded albums.
      for (const slot of seed) {
        slot.trackCount = slot.albums.reduce((n, al) => n + (al.trackCount || 0), 0);
      }
    } catch (err) {
      console.warn("[wiring] getAlbumList2 bulk load failed:", err);
      firstError = err;
    }

    // Surface a banner if the bulk load failed, so the user knows the library
    // is incomplete rather than wondering why artists have no albums. Bulk =
    // far fewer calls than the old per-artist storm, so fewer failure points.
    if (firstError) {
      store.setConnError?.({
        message: "Library partially loaded — album fetch failed. Server may be flaky.",
        retry: () => loadLibrary(session),
      });
    }
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return "00:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  // Lazy per-album track loader. Called by the App when an album is
  // opened (or starts playing) and its tracks aren't in memory yet.
  // Fetches `getAlbum` once, fills the album shell's `tracks` array in
  // place, and flips `tracksLoaded`. Idempotent and concurrency-safe:
  // a second call while the first is in flight returns the same promise
  // (stored on the album as `_tracksPromise`) instead of re-fetching.
  // Returns the album object (with tracks populated) or null if the
  // artist/album can't be found.
  async function loadAlbumTracks(session, artistId, albumId) {
    const data = store.DATA;
    if (!data || !MK_API) return null;
    const artist = (data.ARTISTS || []).find((a) => a.id === artistId);
    const album = artist?.albums.find((al) => al.id === albumId);
    if (!album) return null;
    if (album.tracksLoaded) return album;
    if (album._tracksPromise) return album._tracksPromise;
    const p = (async () => {
      const full = await MK_API.getAlbum(session, albumId);
      album.tracks = (full.song || []).map((s) => ({
        n: s.track ?? 0,
        title: s.title || "",
        time: formatDuration(s.duration),
        starred: !!s.starred,
        trackId: s.id,
        artistId,
        albumId,
        artist: s.artist || artist.name,
        suffix: s.suffix || "",
      }));
      album.tracksLoaded = true;
      return album;
    })();
    album._tracksPromise = p;
    try {
      return await p;
    } catch (err) {
      // Leave tracksLoaded false so a later open retries.
      console.warn("[wiring] getAlbum failed for", albumId, err);
      throw err;
    } finally {
      delete album._tracksPromise;
    }
  }
  export { loadAlbumTracks };

  // ---------------------------------------------------------------
  // 4. Auto-resume — if we have a stored session, populate store.DATA
  //    before App() first mounts and skip the login form.
  // ---------------------------------------------------------------
  //
  // Only clear the persisted session on AUTH failures (Subsonic 40,
  // HTTP 401). A transient network error or a one-off bad-album
  // response shouldn't kick the user back to the login screen and
  // wipe their stored credentials — they'd lose the ability to retry
  // once their wifi comes back, even though the credentials are still
  // valid. We re-throw non-auth errors to the caller so the UI can
  // decide whether to show a banner or retry.
  function isAuthError(err) {
    const msg = String(err?.message || err);
    return /Subsonic 40\b/i.test(msg) || /HTTP 401/i.test(msg);
  }

  // Hard ceiling on how long MK_RESUME can block before the splash
  // gives up and falls through to the shell anyway. The splash overlay
  // covers the whole window, so a hang here = a fully-black UI the
  // user can't escape. Real network + library load (~52 artists, 250
  // tracks) on a LAN takes under 2 seconds; a 12-second cap is well
  // beyond that but still under the user's "what is happening?"
  // threshold. The library populates in the background after that.
  const RESUME_SOFT_TIMEOUT_MS = 12000;

  export async function resume() {
    const session = MK_API.loadSession();
    if (!session) return null;
    try {
      await Promise.race([
        loadLibrary(session),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("resume timeout")), RESUME_SOFT_TIMEOUT_MS)
        ),
      ]);
      return session;
    } catch (err) {
      if (isAuthError(err)) {
        console.warn("[wiring] resume: auth failed, clearing session:", err);
        MK_API.clearSession();
        return null;
      }
      console.warn("[wiring] resume: transient failure or timeout, keeping session:", err);
      // Surface a banner so the user knows why the sidebar is empty,
      // with a Retry that re-runs the load against the same session.
      store.setConnError?.({
        message: `Couldn't reach ${session.baseUrl}. Server may be offline.`,
        retry: () => {
          loadLibrary(session).catch((e) => {
            store.setConnError?.({
              message: `Still can't reach ${session.baseUrl}. ${e?.message || ""}`.trim(),
              retry: () => store.setConnError?.(null),
            });
          });
        },
      });
      // Keep the session and the (possibly partial) data so the shell
      // can render with what we have.
      return session;
    }
  }

  // Audio errors → banner. The audio element fires `error` on stream
  // failure, e.g. when the server is unreachable mid-track or a radio
  // station drops its connection.
  if (MK_AUDIO?.onError) {
    MK_AUDIO.onError(() => {
      store.setConnError?.({
        message: "Stream failed. The server may have gone offline.",
        retry: () => MK_AUDIO?.play?.(),
      });
    });
  }
