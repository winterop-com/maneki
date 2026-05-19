// MediaKit-native video API client - talks to /video/api/* on the same
// origin as the Subsonic mount. Probes /capabilities to find out whether
// the server has video at all; on non-MediaKit Subsonic servers
// (Navidrome, etc.) the probe 404s and the SPA hides the VIDEO section.
//
// Auth: when the server has /auth/login enabled (--auth flag on mediakit
// serve), every /video/* request needs an Authorization: Bearer header.
// For v0 we run without --auth so the bearer machinery is stubbed; when
// --auth lands in the SPA flow this module gets the token via window.MK_AUTH.
//
// Lives outside the design artifact (underscored filename) so design-zip
// drops don't touch it.

(function () {
  "use strict";

  // Use the page's origin (window.location.origin) rather than deriving from
  // session.baseUrl. The SPA is always served by mediakit serve --ui from the
  // same origin as the video API, and using window.location.origin sidesteps
  // a CORS gotcha when the user types "localhost" but the page is at
  // "127.0.0.1" (or vice versa) - the browser treats those as separate
  // origins and blocks cross-origin fetches without CORS preflight.
  function videoApiBase() {
    return window.location.origin + "/video/api";
  }

  function capabilitiesUrl() {
    return window.location.origin + "/capabilities";
  }

  async function call(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} on ${url}`);
    }
    return response.json();
  }

  const MK_VIDEO = {
    async capabilities(_session) {
      try {
        return await call(capabilitiesUrl());
      } catch {
        // No /capabilities endpoint (non-MediaKit server, or SPA hosted
        // separately from a mediakit serve --ui mount). Treat as
        // audio-only - the user is here because Subsonic auth worked.
        return { audio: true, video: false };
      }
    },

    async list(_session) {
      return call(`${videoApiBase()}/videos`);
    },

    // Browse a single directory under <root>/videos/. `path` is the
    // POSIX-style relative path; empty string browses the videos root.
    // Returns { rel_path, crumbs, folders, videos } - the SPA's folder
    // navigator drives off this.
    async browse(_session, path = "") {
      const url = `${videoApiBase()}/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`;
      return call(url);
    },

    async subtitles(_session, videoId) {
      try {
        return await call(`${videoApiBase()}/videos/${encodeURIComponent(videoId)}/subtitles`);
      } catch {
        return [];
      }
    },

    // For passing to <video> / video.js as a source. Returns absolute URL.
    hlsUrl(_session, videoId) {
      return `${videoApiBase()}/videos/${encodeURIComponent(videoId)}/hls/index.m3u8`;
    },

    streamUrl(_session, videoId) {
      return `${videoApiBase()}/videos/${encodeURIComponent(videoId)}/stream`;
    },

    subtitleUrl(_session, videoId, lang) {
      return `${videoApiBase()}/videos/${encodeURIComponent(videoId)}/subtitles/${encodeURIComponent(lang)}`;
    },

    posterUrl(_session, videoId) {
      return `${videoApiBase()}/videos/${encodeURIComponent(videoId)}/poster`;
    },

    thumbnailUrl(_session, videoId) {
      return `${videoApiBase()}/videos/${encodeURIComponent(videoId)}/thumbnail`;
    },
  };

  window.MK_VIDEO = MK_VIDEO;
})();
