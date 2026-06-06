// Mutable shared singletons that non-React code (the wiring/auth layer, the
// audio controller, the video player) writes and React reads at render time.
// A 1:1 replacement for the former window.MK_DATA / MK_SESSION /
// MK_setConnError / MK_VIDEO_PLAYER globals — same "mutate in place, read on
// the next render" semantics.
//
// React Context is deliberately NOT used here: it would change re-render
// timing and risk the lazy album-track load + starred-seed logic that relies
// on these being plain mutable objects read at render time. (Context migration
// is possible future cleanup.)

export const store = {
  // Library tree. Starts empty; _wiring.jsx fills it from the Subsonic server
  // after login. App() / the chrome panes read store.DATA.ARTISTS (and friends)
  // at each render. Shape: see the old data.jsx contract comment.
  DATA: { ARTISTS: [], STATIONS: [], STARRED_TRACKS: [], LYRICS_BOADICEA: [] },

  // Current Subsonic auth session ({ url, user, token, salt }).
  SESSION: null,

  // React setState bridge so non-React code (wiring, audio errors) can raise
  // the connection-error banner. App() sets this on mount, nulls it on unmount.
  setConnError: null,

  // The mounted video.js player instance, set by the video player pane so the
  // audio<->video playback coordination can pause it when music starts.
  videoPlayer: null,
};
