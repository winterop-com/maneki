# Mobile

Maneki's `serve` command exposes the [Subsonic API], so any
Subsonic-compatible mobile app can stream from your library — there's no
Maneki mobile app to install.

This guide walks through the four clients that work well in 2026.

## TL;DR

1. Run `maneki serve` somewhere your phone can reach (Tailscale, LAN, or
   a public URL behind a reverse proxy).
2. Install one of the apps below.
3. Point it at **`http(s)://<host>:8765/audio`**, with the username +
   password from `~/.config/maneki/maneki.toml` (or
   `MANEKI_SERVER__USERNAME` / `MANEKI_SERVER__PASSWORD`).
4. Stream.

!!! warning "The `/audio` is not optional"

    `maneki serve` mounts Subsonic under `/audio`, beside the video API
    and the books API, so the address a client wants is
    `http://<host>:8765/audio` and the client appends its own `/rest/...`.
    Leave it off and every call 404s, which most apps report as
    "server unreachable" rather than as a wrong address.

## Prerequisites

The server itself is covered in [the serve guide](serve-unified.md). For mobile
the things to double-check are:

- **Reachable from the phone.** Localhost won't work; the phone needs to
  resolve the host. The easiest answer is [Tailscale] (the phone joins
  the same tailnet as the server, then connects to
  `http://<machine-name>:8765`). LAN works too if the phone is on
  the same Wi-Fi.
- **Username + password set.** The default `admin` / `admin` will
  authenticate, but every client persists credentials, so use the same
  pair you set in `maneki.toml`.
- **HTTPS if leaving the LAN.** Subsonic auth is salted-token, but the
  audio stream is plaintext bytes. Put the server behind a Caddy /
  Tailscale Funnel / nginx terminator before exposing it on the public
  internet.

## iOS

### play:Sub

Polished, free, supported. Best general-purpose client.

1. Install [play:Sub](https://apps.apple.com/app/play-sub/id955329386)
   from the App Store.
2. Settings → Servers → Add Server.
3. Fill in:
   - **Server Address**: `http://<host>:8765/audio` (the app adds `/rest`)
   - **Username**: from `maneki.toml`
   - **Password**: from `maneki.toml`
4. Save. play:Sub does the salted-token handshake; if the credentials
   are right, "Test Connection" succeeds.
5. Browse → tap album → play.

### Amperfy

Free, open source, scrobble-aware. Good if you also use Last.fm, and the
one to reach for when you want music on the phone with no server in
reach.

1. Install [Amperfy](https://apps.apple.com/app/amperfy/id1530145105).
2. Settings → Server → Add Server. Same fields as above.
3. Amperfy defaults to JSON (`f=json`); Maneki serves both — no
   tweak needed.

## Taking music offline

Every client that downloads asks Maneki for the whole file over
`/audio/rest/download`, which answers with the bytes on disk, a
`Content-Length`, and `Accept-Ranges: bytes` — so an interrupted download
resumes instead of starting again. Nothing is transcoded on that path:
what lands on the phone is the file from the library.

- **Amperfy**: swipe an album or playlist → Download, or Settings →
  Library → Download all. Downloaded items play with the server
  unreachable.
- **play:Sub**: tap the cloud icon on an album, or Settings → Offline
  Mode to browse only what is already on the device.
- **Symfonium**: long-press → Download; "Sync" keeps a pinned set
  current.
- **DSub**: menu → Pin, which keeps the file across cache eviction
  (Download alone does not).

Streaming on mobile data is a separate setting in every one of these
apps: they ask Maneki to transcode with `maxBitRate`, and Maneki does the
ffmpeg work on the server. 128k mp3 is about a third of the bytes of a
typical m4a here.

## Audiobooks on the phone

Books are a **second music folder** called Audiobooks, not a section of
the music library, so every client shows them as their own shelf: pick
the folder in the client's library or folder picker and browse authors
the way you browse artists.

Where you stopped is a Subsonic bookmark, which means it is shared: a
book left at 1:40:00 in Amperfy opens at 1:40:00 in the Maneki web
client, and the other way round. Clients that support bookmarks
(play:Sub, Symfonium, DSub) resume on their own; Amperfy plays from the
start unless you scrub.

## Android

### Symfonium

Paid (~5 EUR), best-in-class UI.

1. Install [Symfonium](https://play.google.com/store/apps/details?id=app.symfonik.music_player)
   from Play.
2. Settings → Sources → Add → Subsonic.
3. URL: `http://<host>:8765/audio`, plus user + password.
4. Save → Sync. Syncing pulls a metadata index; subsequent browsing is
   offline-aware.

### DSub

Free, open source, the Subsonic veteran. Older UI but rock-solid.

1. Install [DSub](https://f-droid.org/en/packages/github.daneren2005.dsub/)
   from F-Droid (the Play version is years out of date).
2. Settings → Servers → Server 1 → enable + fill in the same fields.

### Tempo

Free, open source, works on phone + Android Auto.

1. Install [Tempo](https://github.com/CappielloAntonio/tempo) from
   F-Droid or GitHub.
2. Login screen takes the same URL + credentials.

## Troubleshooting

### "Could not connect"

- Confirm the server is reachable from the phone:
  `curl "http://<host>:8765/audio/rest/ping?u=<user>&p=<password>&v=1.16.1&c=curl"` from a
  laptop on the same network.
- Include `/audio` in the URL field and nothing more — the apps append
  `/rest` themselves.

### "Invalid credentials"

- The Subsonic spec uses salted-token auth (`md5(password + salt)`),
  not plain password. All four apps handle this transparently — but if
  you've set `MANEKI_SERVER__PASSWORD` to a long random token,
  occasional clients hash incorrectly. A short alphanumeric password
  works around this.

### "No music shows up"

- The server only sees what's under the path you launched it with:
  `maneki serve /path/to/Music`. Verify
  `curl 'http://<host>:8765/audio/rest/getArtists?u=...&p=...&f=json'` returns
  a non-empty list.
- If `getArtists` returns content but the app's empty, force-rescan
  inside the app (most have a "Sync" or "Refresh server" action).

### Cover art looks low-res

- Subsonic apps fetch cover art via `/audio/rest/getCoverArt?id=...&size=N`.
  Maneki serves the original embedded artwork; if your library has
  small embeds, the upscale is what the app sees. Embed at 1000×1000
  via [convert](convert.md) for crisp art.

## Resuming a long track

`createBookmark`, `getBookmarks` and `deleteBookmark` are implemented, so a client that saves a position on pause (Symfonium, Amperfy and play:Sub all do) offers to resume a long recording where you stopped. Bookmarks are per account, at `<root>/.maneki/users/<name>/bookmarks.db`, and a bookmark whose track has since left the library is dropped from the list rather than shown as a blank row.

Cross-device queue sync (`savePlayQueue` / `getPlayQueue`) is still a no-op.

Audiobooks are served in their own `Audiobooks` music folder, with a position kept per book rather than per track. A bookmark on a book file writes that position, so a phone and the web app resume at the same place. See [`maneki books import`](books.md#in-subsonic-clients).

## What Maneki doesn't do (yet)

- **No native iOS / Android app of its own.** The Subsonic ecosystem
  is solid; we'd rather you use a polished third-party client than ship
  a 1.0 Maneki app that's worse than play:Sub or Symfonium.
- **No CarPlay / Android Auto direct.** Tempo (Android) supports
  Android Auto. CarPlay routing on iOS depends on the client; play:Sub
  works.
- **No background download / offline cache support in Maneki itself.**
  Each client handles caching independently — most cache by default.

[Subsonic API]: https://www.subsonic.org/pages/api.jsp
[Tailscale]: https://tailscale.com
