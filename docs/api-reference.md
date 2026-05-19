# API Reference

Auto-generated from docstrings via [mkdocstrings](https://mkdocstrings.github.io/). The public surface is small — most users only touch the CLI — but if you're embedding Maneki in another tool, these are the entry points.

## `maneki.audio.metadata`

Read source audio tags (FLAC / MP3 / generic) and write MP4 ALAC / AAC / MP3 tags.

::: maneki.audio.metadata
    options:
      members:
        - SourceTrack
        - AlbumSummary
        - MusicBrainzIds
        - TagOverrides
        - SUPPORTED_AUDIO_EXTS
        - read_source
        - summarize_album
        - clean_album_title
        - write_tags
        - write_mp4_tags
        - write_id3_tags
        - embed_cover_only
        - apply_tag_overrides

## `maneki.audio.library`

Walk a converted-output directory, build an Artist→Album→Track index, audit it, fix the deterministic warnings, and persist it as a SQLite cache at `<root>/.maneki/index.db`.

::: maneki.audio.library
    options:
      members:
        # Pydantic models — same shape used by serve / library CLI.
        - LibraryTrack
        - LibraryAlbum
        - LibraryIndex
        # Filesystem-driven scanning + auditing (no DB).
        - scan
        - audit
        - audit_album
        # Auto-fix flagged albums (MB year backfill, dir/tag rename).
        - fix_index
        - fix_album
        # SQLite-backed index lifecycle.
        - SCHEMA_VERSION
        - INDEX_DIR_NAME
        - INDEX_DB_NAME
        - db_path
        - open_db
        - is_empty
        - load
        - load_or_scan
        - scan_full
        - validate
        - rescan_albums
        - ValidationResult
        - ScanProgressCallback

## `maneki.audio.serve`

FastAPI factory + auth + config for the Subsonic-compatible HTTP server.

::: maneki.audio.serve
    options:
      members:
        - create_app
        - resolve_credentials
        - ServeConfig

## `maneki.audio.naming`

Filesystem-safe folder + filename builders.

::: maneki.audio.naming
    options:
      members:
        - artist_folder
        - album_folder
        - track_filename
        - clean_folder_album_name
        - leading_year_from_folder
        - is_various_artists
        - sanitize_component
        - VARIOUS_ARTISTS

## `maneki.audio.cover`

Cover-art candidates, picker, normaliser.

::: maneki.audio.cover
    options:
      members:
        - CoverCandidate
        - CoverSource
        - Cover
        - DEFAULT_MAX_EDGE
        - collect_candidates
        - pick_best
        - normalize
