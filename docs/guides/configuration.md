# Configuration

maneki reads all of its settings from **one file**: `~/.config/maneki/maneki.toml`.
Everything — library roots, user accounts, server credentials, ffmpeg/encoder
overrides, logging — lives there, and every value can also be set with a
`MANEKI_*` environment variable.

## Where the file lives

```
~/.config/maneki/maneki.toml
```

- Honours **`$XDG_CONFIG_HOME`** — if set, the file is `$XDG_CONFIG_HOME/maneki/maneki.toml`.
- **`MANEKI_CONFIG`** overrides the location entirely — point it at any `.toml`
  (handy for running several instances, or keeping config beside a library).
- `maneki config path` prints the resolved path on your system.

The file may contain **plaintext passwords** (see [Users](#users)), so keep it
private: `chmod 600 ~/.config/maneki/maneki.toml`.

## Commands

```bash
maneki config init        # write a starter file with every section as commented examples
maneki config show        # print the resolved config (secrets masked)
maneki config path        # print the file path
maneki config migrate     # move a pre-0.11 serve.toml into maneki.toml (one-off)
```

`maneki config init` is the fastest way to start — it scaffolds a fully
commented template you uncomment and edit. Add `--force` to overwrite.

## Precedence

Highest wins:

```
CLI flag  >  MANEKI_* env var  >  maneki.toml  >  built-in default
```

So `maneki serve /some/lib` overrides `[libraries]`, `MANEKI_HWENC=none`
overrides `[media] hwenc`, and so on.

## Sections

### `[libraries]`

The roots maneki scans (recursively, audio + video). Overridden by a `serve`
positional or `MANEKI_LIBRARY`.

```toml
[libraries]
locations = ["~/Music", "/Volumes/NAS/media"]
```

### Users

One `[[users]]` block per person. Each account is a separate login.

```toml
[[users]]
name = "alice"
password = "change-me"
admin = true            # may manage other users

[[users]]
name = "bob"
password = "change-me"
```

- **Passwords are plaintext, by necessity.** Subsonic clients authenticate with
  a salted token — `md5(password + salt)` — which the server must recompute, and
  the native video login compares the cleartext. Neither can work against a
  hash. Protect the file with permissions (`chmod 600`), not hashing.
- `admin = true` marks an account that may manage users (and see all users via
  `getUsers`); non-admins see only themselves.
- Each account authenticates with its own password and gets its own
  **starred favourites**, **playlists**, and **listening history** (recently /
  most played, play counts), under `<root>/.maneki/users/<name>/`. `getNowPlaying`
  shows who's listening across all accounts. On first multi-user start, an
  existing global `stars.toml` is migrated into the first admin account so
  nobody loses their favourites.

If you define **no** `[[users]]`, maneki falls back to the single `[server]`
account below — so existing single-user installs are unchanged.

Manage accounts without hand-editing the file:

```bash
maneki config user add alice --admin     # prompts for a password
maneki config user add bob
maneki config user list
maneki config user passwd bob
maneki config user rm bob
```

These edit only the `[[users]]` blocks — the rest of `maneki.toml` (comments,
other sections) is left untouched. The first `add` seeds `[[users]]` from your
existing `[server]` account so it keeps working.

### `[server]` — single-user fallback

Used **only when no `[[users]]` are defined**. Defaults to `admin`/`admin` with a
startup warning, so set it (or add `[[users]]`) before exposing the server.

```toml
[server]
username = "admin"
password = "admin"
```

Optional play-event forwarding (e.g. Home Assistant) nests under it:

```toml
[server.scrobble.webhook]
url = "https://example.invalid/hook"
[server.scrobble.mqtt]
broker = "mqtt://homeassistant:1883"
```

### `[acoustid]`

API key for `maneki audio convert --enrich` fingerprinting (free at
[acoustid.org](https://acoustid.org/api-key)).

```toml
[acoustid]
api_key = "..."
```

### `[media]`

ffmpeg/ffprobe binaries, the H.264 hardware encoder, and YouTube playback.
Useful to point maneki at a fuller ffmpeg (e.g. one with `zscale`/libzimg for
HDR tonemapping) without touching your `PATH`.

```toml
[media]
ffmpeg = "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg"
ffprobe = "/opt/homebrew/opt/ffmpeg-full/bin/ffprobe"
hwenc = "auto"            # auto | vaapi | videotoolbox | none
hwenc_bitrate = "6M"      # set to pin a fixed rate; unset = scales with height
hwenc_maxrate = "8M"
hwenc_bufsize = "12M"
vaapi_device = "/dev/dri/renderD128"
youtube_max_height = 1080            # default cap for YouTube playback quality
youtube_cookies_from_browser = "chrome"   # chrome | safari | firefox | ...
# youtube_cookiefile = "/path/to/cookies.txt"   # alternative to the above
```

Leave `hwenc_bitrate` unset to let the encoder scale the bitrate with the
output resolution (≈12M at 1080p, 6M at 720p, …); set it to pin a fixed rate.

`youtube_cookies_from_browser` (or `youtube_cookiefile`) makes YouTube channel
and stream resolution reliable: without logged-in cookies, repeated requests
from one IP eventually trip YouTube's "Sign in to confirm you're not a bot".
Point it at a browser you're signed into YouTube with.

Run `maneki doctor` to see which encoder will actually be used.

### `[logging]`

```toml
[logging]
level = "INFO"           # DEBUG | INFO | WARNING | ERROR
format = "pretty"        # pretty | json (json for shipping logs)
```

## Environment variables

Every setting has a `MANEKI_*` override. Nested keys use `__` (double
underscore); a handful of common ones also have a short flat alias.

| Variable | Section / meaning |
| --- | --- |
| `MANEKI_CONFIG` | Path to the config file (overrides the location) |
| `MANEKI_LIBRARY` | Default library root (also a `serve`/`info`/`list` argument) |
| `MANEKI_SERVER__USERNAME` / `MANEKI_SERVER__PASSWORD` | `[server]` credentials |
| `MANEKI_FFMPEG` / `MANEKI_FFPROBE` | `[media]` ffmpeg / ffprobe binary |
| `MANEKI_HWENC` | `[media]` encoder: `auto` / `vaapi` / `videotoolbox` / `none` |
| `MANEKI_HWENC_BITRATE` / `_MAXRATE` / `_BUFSIZE` | `[media]` hardware bitrate (override the height-scaled default) |
| `MANEKI_VAAPI_DEVICE` | `[media]` VAAPI render node |
| `MANEKI_YT_COOKIES_FROM_BROWSER` | `[media]` read YouTube cookies from a browser profile (`chrome` / `safari` / `firefox` / …) |
| `MANEKI_YT_COOKIEFILE` | `[media]` path to an exported Netscape `cookies.txt` |
| `MANEKI_ACOUSTID_KEY` | `[acoustid]` API key |
| `MANEKI_LOG_LEVEL` / `MANEKI_LOG_FORMAT` | `[logging]` level / renderer |

`maneki config show` lists which `MANEKI_*` variables are currently set (values
masked) so you can see what's overriding the file.
