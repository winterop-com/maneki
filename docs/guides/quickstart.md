# Quickstart

End-to-end walkthrough — from `uvx maneki` to playing a track on Amperfy from
across the room. Roughly 30 minutes of wall-clock time on a 200-album library;
most of it is the convert pipeline and the cover-pick loop.

The route this guide takes:

1. Set up the Mac (maneki + ffmpeg + Tailscale)
2. Convert a sample library
3. Audit + auto-fix the warnings
4. Pick covers for the flagged albums
5. Start `maneki serve`
6. Set up the iPhone (Tailscale + Amperfy)
7. Connect Amperfy to the server and play a track

If you're new to Tailscale: it's a zero-config VPN that gives every device of
yours a permanent address (`yourname.tail-something.ts.net`) reachable from
anywhere with internet. We use it so the iPhone can reach the Mac whether
you're on the same Wi-Fi or somewhere else.

## 1. Mac setup

### Install maneki

The lowest-friction way is [`uvx`](https://docs.astral.sh/uv/) — it downloads the latest published `maneki` from [PyPI](https://pypi.org/project/maneki/), caches it, and runs it in one step. No install step required:

```bash
uvx maneki --help
```

For daily / persistent use (PATH-installed, no per-run network check):

```bash
uv tool install maneki       # recommended (uv-managed, isolated venv on PATH)
pipx install maneki          # equivalent for pipx users
pip install maneki           # plain pip into current env
```

Either route pulls every Python dep. The rest of this guide uses `uvx maneki ...` for examples — substitute `maneki ...` if you went the persistent-install route.

If you want to hack on Maneki itself, see [Development](development.md) for the `git clone` + `uv sync` flow.

### Install system ffmpeg

`maneki serve` shells out to system `ffmpeg` / `ffprobe` for Subsonic
on-the-fly transcoding, video HLS segments, and subtitle extraction. The
`convert` pipeline uses them too:

```bash
brew install ffmpeg          # macOS
sudo apt install ffmpeg      # Debian / Ubuntu
```

Verify:

```bash
ffmpeg -version | head -1
ffprobe -version | head -1
```

### Install Tailscale on the Mac

Download the Mac client from <https://tailscale.com/download/mac>. Open the
installer, sign in with whichever identity you like (Google / GitHub / email
+ password). After login, the menu-bar Tailscale icon shows your tailnet
hostname — looks like `mlaptop.tail4a4b9a.ts.net`. Note that hostname; the
iPhone will use it later.

```bash
tailscale status                          # confirm the daemon is up
tailscale ip -4                           # your Tailscale IPv4
hostname -f                               # local hostname
```

### Sanity-check maneki

```bash
uvx maneki --help
```

You should see `serve / library / audio / video` listed.

## 2. Convert a library

Drop a few albums into `./input/`. Any layout works — the convert pipeline
handles `Artist/Album/`, `Artist/Album/CD1/CD2/`, scene-tagged dirs, and
flat dumps. For a quickstart run a sample of 5–20 albums is enough.

```bash
uvx maneki audio convert ./input ./output
```

Default output is `output/<Artist>/<YYYY> - <Album>/NN - <Title>.m4a` at
256 kbps AAC. A 200-album library on an SSD takes 5–10 minutes; an
external USB drive or a network mount takes longer. Run with `--verbose`
if you want a per-track log line; `--dry-run` plans without writing.

When it finishes you have a clean library at `./output/`. The rest of the
guide points at that directory.

## 3. Audit + fix

```bash
uvx maneki audio library audit ./output --issues-only
```

Shows a table of every album with at least one warning: missing cover,
missing year, mixed years, scene-residue dirnames, tag/path mismatch,
track gaps. You can ignore most of these for a first run; the deterministic
ones get fixed by:

```bash
uvx maneki audio library fix ./output --dry-run        # preview
uvx maneki audio library fix ./output                  # apply
```

The fixer makes one MusicBrainz HTTP call per flagged album to backfill
missing years, then renames directories to match the canonical
`YYYY - Album` form. A progress bar shows what it's doing — a quiet pass
for clean albums means there's nothing to fix.

For the cover-art warnings, the semi-automated path is:

```bash
uvx maneki audio library cover-pick ./output
```

Per album, this:

1. Prints `Artist — Album (no cover)`.
2. Opens
   `https://covers.musichoarders.xyz/?artist=...&album=...`
   in your browser, pre-filled.
3. Click any cover on that page; musichoarders' UI puts the image URL
   on your clipboard.
4. Paste it back into the terminal. `s` to skip, `q` to quit.
5. maneki downloads, validates with Pillow, resizes to fit
   `--cover-max-edge` (default 1000 px), saves as `cover.jpg`, embeds
   into every track.

Run `library audit --issues-only` again to confirm the warning count
dropped.

## 4. Start the server

```bash
uvx maneki serve ./output
```

By default this:

- binds `127.0.0.1:8765` (LAN + Tailscale)
- starts a filesystem watcher for auto-rescan (drops new albums in →
  visible to clients within seconds)
- advertises itself on mDNS as `_subsonic._tcp.local`
- uses default credentials `admin / admin` with a yellow warning

You'll see a startup banner like:

```
maneki serve — Subsonic API for ~/Music
  bind: 127.0.0.1:8765
  LAN:  http://192.168.1.42:8765
  Tailscale: http://mlaptop.tail4a4b9a.ts.net:8765

scanning library…
   142 artists, 318 albums, 4521 tracks

  mDNS: advertising as maneki-mlaptop._subsonic._tcp.local
  watching ~/Music for changes (auto-rescan on add/remove/rename)
```

Note the **Tailscale** URL — that's what the iPhone will use.

For anything beyond a private LAN, set proper credentials. Scaffold the config
file and edit it:

```bash
maneki config init          # writes ~/.config/maneki/maneki.toml (commented)
$EDITOR ~/.config/maneki/maneki.toml
chmod 600 ~/.config/maneki/maneki.toml
```

Set `[server] username`/`password`, or add one or more `[[users]]` accounts for
multiple people. Restart `maneki serve` — the yellow warning is gone. See the
[Configuration guide](configuration.md) for every section and env var.

(If you're upgrading from a pre-v0.11 install with a `serve.toml`, run
`maneki config migrate` once to move it to the new format.)

Leave the server running. You can also run it as a background process via
launchd / systemd; see [Serve](serve-unified.md) for examples.

## 5. iPhone setup

### Install Tailscale on the iPhone

App Store → "Tailscale" → install. Sign in with the same identity you
used on the Mac. Once connected, the Tailscale app shows the same tailnet
as on the Mac, with `mlaptop` (or whatever your Mac's hostname is) listed
under Devices.

In Tailscale settings, enable **Use Tailscale DNS** so the
`*.tail-...ts.net` hostnames resolve from any Wi-Fi.

Quick check from a browser on the iPhone:

```
http://mlaptop.tail4a4b9a.ts.net:8765/
```

Visit `/capabilities` and you should see a JSON probe response like:

```json
{
  "server": "maneki",
  "version": "0.9.0",
  "audio": true,
  "video": true,
  "youtube": true,
  "radio": true,
  "auth_required": false,
  "endpoints": {
    "audio_subsonic": "/audio/rest",
    "video_api": "/video/api",
    "auth_login": "/auth/login"
  }
}
```

The `audio` / `video` flags reflect what maneki found at the library root; `radio` / `youtube` are the remote sources, which need nothing on disk and are available even on an empty root.

If that loads, the iPhone can reach the server.

### Install Amperfy

App Store → "Amperfy" → install. (Amperfy is the Subsonic client we
recommend for iOS. play:Sub, iSub, Substreamer all work too — Amperfy
is the most feature-complete, including OpenSubsonic extensions and
synced lyrics.)

### Connect Amperfy to maneki serve

Open Amperfy → first-launch screen prompts for a server. Fill in:

- **Server URL**: `http://mlaptop.tail4a4b9a.ts.net:8765` (your Mac's
  Tailscale URL — no trailing slash, no `/rest`).
- **Username**: `admin` (or whatever you put in `maneki.toml`).
- **Password**: `admin` (or whatever you put in `maneki.toml`).

Tap **Login**. Amperfy probes `/rest/ping`, then `/rest/getMusicFolders`
and `/rest/getArtists` to populate the library. On first connect with a
~300-album library this takes 2-5 seconds.

If login fails, the most common causes are:

- Tailscale not connected on the iPhone (check the menu icon).
- Wrong port (`maneki serve` listens on 8765 by default; Navidrome
  uses 4533, AirSonic uses 4040 — match whatever your server prints
  at startup).
- HTTPS expected but not configured. Default `serve` is plain HTTP. If
  Amperfy asks for HTTPS, leave the URL as `http://` and accept the
  insecure-warning toggle in Amperfy's settings — fine over Tailscale,
  which encrypts the underlying connection.

### Play a track

Browse → Artists → pick one → pick an album → tap a track. Amperfy
starts streaming. The first few seconds may be a fraction slower than a
local file (HTTP buffer fill), then steady-state is real-time.

Try the things you'd expect from a Subsonic client:

- **Background play** — start a track, lock the iPhone, the audio keeps
  going.
- **Lock-screen controls** — pause / next / prev work.
- **Seek scrubber** — Amperfy uses the Subsonic `transcodeOffset`
  extension (which maneki advertises) for accurate mid-track resume.
- **Search** — `/rest/search3` matches against artist, album, and track
  titles.

## 6. Optional: browse + play locally on the Mac

`maneki serve --ui` mounts the web SPA at the same origin as the API.
Open `http://127.0.0.1:8765/` in any browser and you get the full
audio + video UI with the same login (admin / admin by default).

Press `?` for the keybindings overlay; the most useful ones are
`Space` (play/pause), `←` / `→` (±5s seek), `↑` / `↓` (volume), `m`
(mute), `f` (fullscreen video), `Cmd+P` (command palette), `Esc`
(close modal / exit fullscreen).

## 7. Day-to-day

Once it's running:

- **Add albums** — drop new dirs into `./output/` (or wherever you
  pointed `serve`). The watcher picks them up within ~5 seconds. New
  album appears in Amperfy's library on next pull-to-refresh.
- **Edit tags** — `maneki audio library retag <album-dir> --year 2020`,
  `--album-artist 'New Name'`, etc. The watcher catches the file mtime
  changes and re-reads only that album.
- **Replace covers** — `maneki audio library cover <album-dir> new.jpg`
  embeds the new cover into every track.
- **Audit periodically** — `maneki audio library audit ./output --issues-only`
  surfaces newly-introduced warnings (a recent rip might have
  unexpected scene tags).
- **Inspect a single track** — `maneki audio inspect path/to/track.m4a`
  pretty-prints its tags, embedded picture, ReplayGain.

## Troubleshooting

### Amperfy says "Server unreachable"

Check, in order:

1. Is `maneki serve` still running? Restart if not.
2. Is Tailscale connected on the iPhone? Open the app and confirm.
3. Can you load the JSON probe URL in Mobile Safari? If yes, the
   transport works — the issue is in Amperfy's auth / URL setup.
4. Did you put the URL in correctly (no trailing slash, no `/rest`)?

### Symfonium / play:Sub / Feishin instead of Amperfy

The Subsonic API is identical — only the client UI changes. URL +
credentials work the same. maneki specifically advertises the
`formPost`, `transcodeOffset`, `multipleGenres`, `songLyrics`
OpenSubsonic extensions; Amperfy and Symfonium are the two clients
that exercise all of them, so they get the most polished UX.

### "Slow" library scan

The first launch of `serve` against a fresh library does a full
filesystem walk + tag read. After that, the SQLite index at
`<output>/.maneki/index.db` is hydrated and only filesystem deltas
are re-scanned. If a launch ever feels mysteriously slow, run:

```bash
uvx maneki audio library index status ./output
```

to inspect the DB and confirm it exists. `--full-rescan` (on `tree` or
any other library subcommand) wipes + rebuilds the cache.

### I want to expose the server to the open internet

Don't, for v1 — the auth is HTTP Basic over plain HTTP. Wrap it in a
reverse proxy (Caddy / nginx) with HTTPS termination, or stick with
the Tailscale-only model where Tailscale's WireGuard tunnel does the
encryption + access control for you.

## Where to read next

- [Architecture](../architecture.md) — how all the pieces fit together,
  including the audio engine subprocess and the SQLite index lifecycle.
- [Library](library.md) — every audit rule, every fix, every index
  management command.
- [Serve](serve-unified.md) — full Subsonic endpoint list, transcoding, mDNS,
  watcher behavior, client compatibility matrix.
- [Video](video.md) — HLS pipeline, subtitle handling, contact-sheet
  posters, folder browser.
