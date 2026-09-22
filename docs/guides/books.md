# `maneki books import`

Identifies every audiobook waiting in an inbox folder and copies it into the library as `<library>/<Author>/<Title>/`, with tags, chapters and a `cover.jpg`. The audio is copied byte for byte: only the tags change, and nothing is re-encoded.

```
uvx maneki books import INBOX LIBRARY [...flags]
```

On a combined library served from one root, the inbox is `inbox/books/` and the library is `Audiobooks/`. `maneki serve` keeps both out of the music library (see [`maneki serve`](serve-unified.md#auto-detection)):

```
maneki books import /Volumes/T9/Media/inbox/books /Volumes/T9/Media/Audiobooks --dry-run
```

## What counts as a book

Each entry directly in `INBOX` is one book:

- a folder holding audio at any depth, played in natural order (`Part 2` before `Part 10`, `CD1/` before `CD2/`);
- a single audio file.

Loose files from several books must not share one folder: with no tags, nothing tells their parts apart. Put each book in its own folder first; the folder's name can be anything.

## How a book is identified

1. **Its own tags**, when every file agrees on an album (the book's title) and an artist (its author).
2. **Otherwise its name.** Rip names follow no single convention, so the name is split on ` - ` and read both ways: `Thinking, Fast and Slow - Daniel Kahneman` and `Kahneman Daniel - Thinking, Fast and Slow(Egan Patrick) - 2011(80bps)` both work. A trailing parenthetical naming a person is taken as the narrator (`(read by Andy Serkis)`), a four-digit year as the year, and rip details (`(Unabridged)`, `[MP3 64kbps]`) are dropped.
3. **The catalog** settles it. Audible's catalog is searched with the cleaned name, and each edition is scored by how much of its title and author the name contains, so a swapped `Title - Author` still matches. Summaries and reviews of a book are never taken for the book. When Audible has nothing, the iTunes Search API is tried.

Offline, or with `--no-enrich`, the book is named from step 1 or 2 alone.

## Chapters

Chapters come from, best first:

1. **The file**: m4b / m4a chapter tracks, MP3 ID3 `CHAP` frames, Ogg and FLAC `CHAPTERxxx` comments.
2. **The catalog**, from [Audnexus](https://github.com/laxamentumtech/audnexus) (the chapter source Audiobookshelf uses), only when this recording's length matches an Audible edition's to within 3 seconds. Audible releases open with a few seconds of branding and close with a few more, which rips often drop; the match allows for either being cut. When a cut intro and a cut outro explain the length equally well, the chapters are placed at the earlier of the two positions, so a jump lands a few seconds early rather than after a chapter's first words.
3. **One chapter per file**, for a book split into several files.

A recording whose length matches no edition keeps the book's title, author and cover, but not the edition's narrator, ASIN or chapters: it may be a different reading of the same book.

## Two copies of one book

When two inbox entries identify as the same book, one is imported: the copy with known chapters first, then the one whose length matches an edition, then the higher bit rate. The other is reported as a skip, and stays in the inbox.

## What is written

| | MP3 | M4B / M4A | FLAC / Ogg / Opus |
|---|---|---|---|
| Title / author | `TALB` / `TPE1` + `TPE2` | `©alb` / `©ART` + `aART` | `album` / `artist` + `albumartist` |
| Narrator | `TCOM` | `©wrt` | `composer` |
| Genre | `Audiobook` | `Audiobook`, media kind audiobook | `Audiobook` |
| Description, ASIN | `COMM`, `TXXX:ASIN` | `desc` / `ldes`, `ASIN` | `description`, `asin` |
| Chapters | `CHAP` / `CTOC` frames | kept when already in the file | `CHAPTERxxx` / `CHAPTERxxxNAME` |
| Cover | `APIC` + `cover.jpg` | `covr` + `cover.jpg` | `cover.jpg` |

These follow the conventions Audiobookshelf reads. A one-file book is named after its title (`Thinking, Fast and Slow.mp3`); the parts of a multi-file book are `NN - <part>.mp3`, without the rip's own numbering. mutagen cannot write new chapters into an m4b, so catalog chapters for one are reported and left out.

The cover is the catalog's full-size art, else an image in the book's folder (`cover`, `folder` and `front` first), else one embedded in the audio, resized to `--cover-max-edge`.

## Serving

`maneki serve <root>` mounts the books API when `<root>` has an `Audiobooks/` folder. It reads everything back from the files the import wrote: tags, chapters, lengths, `cover.jpg`.

| Endpoint | What it returns |
|---|---|
| `GET /books/api/books` | Every book, by author then title: title, author, narrator, year, series, length, chapter count. |
| `GET /books/api/books/{id}` | One book with its description, its chapters on the book's timeline, and its files in order, each with its offset and a stream URL. |
| `GET /books/api/books/{id}/files/{n}` | The `n`th file as stored, with HTTP Range support, so a player can seek anywhere without the server decoding it. |
| `GET /books/api/books/{id}/cover` | `cover.jpg`, else the picture embedded in the first file. |
| `GET` / `POST /books/api/scan` | Rescan status / start a rescan. Only books whose files changed are re-read. |
| `GET /books/api/progress` | Every book this account has started, most recently played first. |
| `GET` / `PUT` / `DELETE /books/api/books/{id}/progress` | Where this account stopped: read it, record it, or forget it. |

### In Subsonic clients

Books are also served through the Subsonic API, in a music folder of their own called `Audiobooks` (`getMusicFolders` reports it beside `Music`). Pointing a client at that folder gives a shelf of books and nothing else; every browse endpoint honours `musicFolderId`.

Inside it, an author reads as an artist, a book as an album, and a book's files as its songs, each typed `audiobook` so a client can treat them as spoken word. Book ids carry their own prefixes (`bka_`, `bkb_`, `bkt_`), so they can never be confused with music.

The position is the same one the books API keeps. A client that bookmarks a book file writes the book's position, and a book with a position comes back from `getBookmarks` as a bookmark on the file it falls in, with `bookmarkPosition` on the song. Stopping on a phone and opening the web app resumes in the same place, and the other way round.

A client that ignores music folders will list book authors among music artists. That is the trade for phone resume; the folder is there for clients that respect it.

### Resuming

An hour into a book, closing the app has to pick up where you left off, so the position is kept on the server rather than in one browser: it follows you between the web app, the desktop apps and any other client of the same account. Each account has its own, in `<root>/.maneki/users/<name>/books.db`, beside its favourites and play history, so an index rebuild never loses it.

A position is one offset in seconds on the book's whole timeline. For a book split across files, the player maps the offset back to a file using the offsets in the book's detail. A player is expected to `PUT` it every few seconds and on pause; the write is a single row.

The book list carries each book's position and whether it is finished, so a shelf renders from one request. A book counts as finished once the position reaches its last minute (or the last 2% of a book shorter than fifty minutes), since most books end in credits. A player that knows better can say so outright, in either direction.

A book's id comes from its folder's path, so it stays the same across restarts and rescans until the folder moves. Under `--auth` the endpoints need the same bearer token as `/video/*`.

## All flags

| Flag | Default | What it does |
|---|---|---|
| `--dry-run` | off | Identify and plan every book, write nothing. The table shows what would happen. |
| `--enrich` / `--no-enrich` | on when Audible is reachable | Look books up on Audible, Audnexus and iTunes. |
| `--overwrite` | off | Replace a book already in the library. Without it, such a book is skipped. |
| `--remove-source` | off | Delete each book from the inbox once it is imported. Skipped and failed books stay. |
| `--cover-max-edge` | 1000 | Longest cover edge, in pixels. |

The command exits non-zero when a book fails; skips are not failures.
