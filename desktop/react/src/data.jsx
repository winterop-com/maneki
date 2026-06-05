// Library data — used to be hardcoded mock content for the Claude
// Designer preview environment. In the wired build it starts empty
// and is populated from the real Subsonic server by `_wiring.jsx`
// after login. The artifact's `App()` reads `window.MK_DATA.ARTISTS`
// (and friends) at each render, so as long as the values are filled
// in before the post-login render, the shell sees real data.
//
// Shape contract (matches what the artifact's `App()` + chrome panes
// expect, plus extra fields the wiring layer attaches):
//   ARTISTS:    [{ id, name, sortName, albumCount, trackCount, color,
//                  bio, cover, albums: [{
//                    id, name, year, trackCount, color, cover,
//                    coverArtUrl, tracksLoaded,
//                    tracks: [{ n, title, time, starred, trackId,
//                               artistId, albumId, suffix }]
//                  }] }]
//     (album.tracks starts empty with tracksLoaded:false; the wiring
//      layer's MK_loadAlbumTracks fills it in when the album is opened)
//   STATIONS:   [{ id, name, streamUrl, icon }]
//   STARRED_TRACKS: [{ key, artistId, artistName, albumId, albumName,
//                      n, title, time, trackId, suffix, starred }]
//     (seeded from getStarred2 so the Starred view works before any
//      album's tracks are lazily loaded)
//   LYRICS_BOADICEA:  [] (placeholder, no lyrics wired yet)
//
// The original mock content from the design-zip lived here; the
// wiring layer (`_wiring.jsx`) replaces these arrays on login.

window.MK_DATA = { ARTISTS: [], STATIONS: [], STARRED_TRACKS: [], LYRICS_BOADICEA: [] };
