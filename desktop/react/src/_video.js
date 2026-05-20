// Maneki-native video API client - talks to /video/api/* on the same
// origin as the Subsonic mount. Probes /capabilities to find out whether
// the server has video at all; on non-Maneki Subsonic servers
// (Navidrome, etc.) the probe 404s and the SPA hides the VIDEO section.
//
// Auth: when the server has /auth/login enabled (--auth flag on maneki
// serve), every /video/* request needs an Authorization: Bearer header.
// For v0 we run without --auth so the bearer machinery is stubbed; when
// --auth lands in the SPA flow this module gets the token via window.MK_AUTH.
//
// Lives outside the design artifact (underscored filename) so design-zip
// drops don't touch it.

(function () {
  "use strict";

  // Derive the API root from the session's baseUrl. The login flow
  // stores baseUrl as "<host>/audio" for maneki (Subsonic mounted
  // under /audio) or "<host>" for a 3rd-party Subsonic server.
  // Strip the trailing /audio to get the host root, then add /video/api
  // or /capabilities as needed.
  //
  // Previous version used window.location.origin, which works fine
  // when the SPA is served by `maneki serve --ui` (origin matches
  // the API). In Tauri / Electron the origin is `http://tauri.localhost`
  // or `file://` - wrong for every video / capabilities call, so the
  // VIDEO kind never appeared in the desktop wrappers.
  function apiRoot(session) {
    const base = (session && session.baseUrl) || "";
    return base.replace(/\/audio\/?$/, "");
  }

  function videoApiBase(session) {
    return apiRoot(session) + "/video/api";
  }

  function capabilitiesUrl(session) {
    return apiRoot(session) + "/capabilities";
  }

  async function call(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} on ${url}`);
    }
    return response.json();
  }

  const MK_VIDEO = {
    async capabilities(session) {
      try {
        return await call(capabilitiesUrl(session));
      } catch {
        // No /capabilities endpoint (non-Maneki server, or SPA hosted
        // separately from a maneki serve --ui mount). Treat as
        // audio-only - the user is here because Subsonic auth worked.
        return { audio: true, video: false };
      }
    },

    async list(session) {
      return call(`${videoApiBase(session)}/videos`);
    },

    // Poll target: returns { scanning, phase, total, scanned } where
    // phase is "idle" / "walking" / "probing" / "done". The SPA's
    // VideosPane polls this every ~500ms during cold start so the
    // user sees a real progressbar instead of a bare "loading..." line.
    // Returns null on any fetch error so the caller can fall back to
    // the indeterminate spinner without crashing the poll loop.
    async scanStatus(session) {
      try {
        return await call(`${videoApiBase(session)}/scan_status`);
      } catch {
        return null;
      }
    },

    // Browse a single directory under the library root. `path` is the
    // POSIX-style relative path; empty string browses the root.
    // Returns { rel_path, crumbs, folders, videos } - the SPA's folder
    // navigator drives off this.
    async browse(session, path = "") {
      const url = `${videoApiBase(session)}/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`;
      return call(url);
    },

    // Filename substring search across the whole library. Empty `q`
    // returns []. Server caps results so the SPA doesn't have to.
    async search(session, q) {
      const trimmed = (q || "").trim();
      if (!trimmed) return [];
      const url = `${videoApiBase(session)}/search?q=${encodeURIComponent(trimmed)}`;
      return call(url);
    },

    async subtitles(session, videoId) {
      try {
        return await call(`${videoApiBase(session)}/videos/${encodeURIComponent(videoId)}/subtitles`);
      } catch {
        return [];
      }
    },

    // For passing to <video> / video.js as a source. Returns absolute URL.
    hlsUrl(session, videoId) {
      return `${videoApiBase(session)}/videos/${encodeURIComponent(videoId)}/hls/index.m3u8`;
    },

    streamUrl(session, videoId) {
      return `${videoApiBase(session)}/videos/${encodeURIComponent(videoId)}/stream`;
    },

    subtitleUrl(session, videoId, lang) {
      return `${videoApiBase(session)}/videos/${encodeURIComponent(videoId)}/subtitles/${encodeURIComponent(lang)}`;
    },

    // Build a subtitle URL from the listing's track_id. Handles both
    // sidecar ("sidecar:<lang>") and embedded ("embed:<index>") ids.
    // We rebuild the URL on the SPA side (instead of using `url` from
    // the listing) because the listing is generated INSIDE the video
    // sub-app, which doesn't know its mount prefix (/video). This way
    // we always go through the same `videoApiBase()` everything else
    // uses, so prefix changes only need to update one place.
    subtitleTrackUrl(session, videoId, trackId) {
      const tail = trackId.startsWith("sidecar:")
        ? encodeURIComponent(trackId.slice("sidecar:".length))
        : trackId.replace(":", "-"); // "embed:2" -> "embed-2"
      return `${videoApiBase(session)}/videos/${encodeURIComponent(videoId)}/subtitles/${tail}`;
    },

    posterUrl(session, videoId) {
      return `${videoApiBase(session)}/videos/${encodeURIComponent(videoId)}/poster`;
    },

    thumbnailUrl(session, videoId) {
      return `${videoApiBase(session)}/videos/${encodeURIComponent(videoId)}/thumbnail`;
    },

    // Returns { ready: [video_id, ...] } - the set of ids whose row
    // thumbnail is cached on disk right now. VideosPane polls this
    // every few seconds while a folder is open so it can swap the
    // SVG placeholder for the real frame as each thumbnail finishes
    // generating, without forcing a full page refresh. Returns null
    // on error so the caller doesn't crash its poll loop.
    async thumbnailsReady(session) {
      try {
        return await call(`${videoApiBase(session)}/thumbnails/ready`);
      } catch {
        return null;
      }
    },

    // Fire-and-forget hot-reload trigger. Server returns 200 + the
    // current ScanState snapshot right away (the actual rescan runs
    // out-of-band on the asyncio loop); SPA polls /scan_status to
    // observe progress. No-op if a scan is already running on the
    // server (re-entry guarded by the scan_tracker phase). Returns
    // null on error so the caller can fall back to "we tried" UX.
    async triggerScan(session) {
      try {
        const resp = await fetch(`${videoApiBase(session)}/scan`, { method: "POST" });
        if (!resp.ok) return null;
        return await resp.json();
      } catch {
        return null;
      }
    },

    // Server-side hook: kill any in-flight HLS prefetch / transcode
    // for this video. Called from VideoPlayerPane cleanup so closing
    // the player actually stops the segment pipeline instead of
    // letting ~30s of speculative transcodes drain to disk. Uses
    // `keepalive: true` so the browser still sends the request even
    // when the component is unmounting / the tab is closing. Best-
    // effort: failures are swallowed since there's nothing useful
    // to do on the SPA side if the server's already gone.
    async cancelSession(session, videoId) {
      try {
        await fetch(
          `${videoApiBase(session)}/videos/${encodeURIComponent(videoId)}/session`,
          { method: "DELETE", keepalive: true },
        );
      } catch { /* best-effort */ }
    },
  };

  window.MK_VIDEO = MK_VIDEO;
})();
