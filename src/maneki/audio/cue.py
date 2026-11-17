"""Single-file CD images with a CUE sheet: parse the sheet, split the image into tracks.

EAC and friends often rip a whole disc to one `Album.flac` next to an
`Album.cue` (or `Album.flac.cue`) that lists where each track starts. The
convert pipeline works per track, so such an image is split into one FLAC per
track in a scratch directory first, tagged from the sheet, and those files
then go through the pipeline like any other album.
"""

from __future__ import annotations

import os
import re
import shlex
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

# CUE time is MM:SS:FF with 75 frames per second (CD sectors).
_FRAMES_PER_SECOND = 75
_TIME_RE = re.compile(r"^(\d+):(\d{1,2}):(\d{1,2})$")
# Tags carried over from the image that describe the whole disc, not one track.
_DISC_ONLY_TAGS = frozenset(
    {
        "TITLE",
        "TRACKNUMBER",
        "TRACKTOTAL",
        "TOTALTRACKS",
        "CUESHEET",
        "ARTIST",
        "ISRC",
        "LYRICS",
        "UNSYNCEDLYRICS",
    }
)


class CueTrack(BaseModel):
    """One `TRACK` entry: its number, start offset and per-track tags."""

    model_config = ConfigDict(frozen=True)

    number: int
    start_s: float
    title: str | None = None
    performer: str | None = None
    isrc: str | None = None


class CueSheet(BaseModel):
    """A parsed CUE sheet that points at exactly one audio file."""

    model_config = ConfigDict(frozen=True)

    path: Path
    file: str
    title: str | None = None
    performer: str | None = None
    date: str | None = None
    genre: str | None = None
    tracks: list[CueTrack] = Field(default_factory=list)


class CueImage(BaseModel):
    """An audio image together with the sheet that splits it."""

    model_config = ConfigDict(frozen=True)

    image: Path
    sheet: CueSheet


def _read_text(path: Path) -> str:
    """Decode a CUE file: UTF-8 (with or without BOM) first, then Windows-1252."""
    raw = path.read_bytes()
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode("cp1252", errors="replace")


def _parse_time(value: str) -> float | None:
    match = _TIME_RE.match(value)
    if not match:
        return None
    minutes, seconds, frames = (int(g) for g in match.groups())
    return minutes * 60 + seconds + frames / _FRAMES_PER_SECOND


def _args(line: str) -> list[str]:
    try:
        return shlex.split(line, posix=True)
    except ValueError:
        return line.split()


def parse_cue(path: Path) -> CueSheet | None:
    """Parse `path`. Returns None unless the sheet names one FILE and has 2+ tracks.

    Sheets that list one FILE per track describe an already-split rip, which the
    pipeline handles without help, so they are not treated as images.
    """
    try:
        text = _read_text(path)
    except OSError:
        return None

    files: list[str] = []
    disc: dict[str, str] = {}
    tracks: list[CueTrack] = []
    current: dict[str, object] | None = None

    def flush() -> None:
        if current is not None and current.get("start_s") is not None:
            tracks.append(CueTrack.model_validate(current))

    for raw_line in text.splitlines():
        parts = _args(raw_line.strip())
        if not parts:
            continue
        keyword = parts[0].upper()
        if keyword == "FILE" and len(parts) >= 2:
            files.append(parts[1])
        elif keyword == "TRACK" and len(parts) >= 2:
            flush()
            try:
                current = {"number": int(parts[1]), "start_s": None}
            except ValueError:
                current = None
        elif keyword == "INDEX" and len(parts) >= 3 and current is not None:
            if parts[1] == "01":
                current["start_s"] = _parse_time(parts[2])
        elif keyword in ("TITLE", "PERFORMER") and len(parts) >= 2:
            value = parts[1].strip() or None
            key = keyword.lower()
            if current is None:
                if value:
                    disc[key] = value
            else:
                current[key] = value
        elif keyword == "ISRC" and len(parts) >= 2 and current is not None:
            current["isrc"] = parts[1]
        elif keyword == "REM" and len(parts) >= 3 and current is None:
            rem_key = parts[1].upper()
            if rem_key == "DATE":
                disc["date"] = parts[2]
            elif rem_key == "GENRE":
                disc["genre"] = parts[2]
    flush()

    if len(set(files)) != 1 or len(tracks) < 2:
        return None
    tracks.sort(key=lambda t: t.number)
    return CueSheet(path=path, file=files[0], tracks=tracks, **disc)


def _sheet_for(audio: Path) -> CueSheet | None:
    """Find a CUE sheet in `audio`'s folder whose FILE entry names `audio`."""
    candidates = [audio.with_name(f"{audio.name}.cue"), audio.with_suffix(".cue")]
    try:
        candidates += sorted(p for p in audio.parent.iterdir() if p.suffix.lower() == ".cue" and p not in candidates)
    except OSError:
        pass
    for cue_path in candidates:
        if not cue_path.is_file():
            continue
        sheet = parse_cue(cue_path)
        if sheet is None:
            continue
        named = Path(sheet.file.replace("\\", "/")).name
        # Rippers sometimes write `Album.wav` in the sheet next to a FLAC they
        # compressed afterwards, so a matching stem is enough.
        if named.casefold() == audio.name.casefold() or Path(named).stem.casefold() == audio.stem.casefold():
            return sheet
    return None


def find_cue_images(tracks: list[Path]) -> list[CueImage]:
    """Return every file in `tracks` that is a whole-disc image with a CUE sheet."""
    images: list[CueImage] = []
    for audio in tracks:
        sheet = _sheet_for(audio)
        if sheet is not None:
            images.append(CueImage(image=audio, sheet=sheet))
    return images


def _image_tags(image: Path) -> tuple[dict[str, list[str]], list[object]]:
    """Disc-level tags and pictures from a FLAC image, to carry onto each track."""
    if image.suffix.lower() != ".flac":
        return {}, []
    try:
        from mutagen.flac import FLAC, VCFLACDict

        flac = FLAC(image)
    except Exception:  # noqa: BLE001 - an unreadable tag block just means nothing to carry over
        return {}, []
    tags: dict[str, list[str]] = {}
    comments = flac.tags if isinstance(flac.tags, VCFLACDict) else []
    for key, value in comments:
        upper = key.upper()
        if upper in _DISC_ONLY_TAGS:
            continue
        tags.setdefault(upper, []).append(value)
    return tags, list(flac.pictures)


def split_image(image: CueImage, dest: Path, *, workers: int = 4) -> list[Path]:
    """Split `image` into one tagged FLAC per CUE track under `dest`.

    Each track runs from its `INDEX 01` to the next track's `INDEX 01`; the
    last runs to the end of the file. Output is FLAC so the split is lossless
    and the pipeline's usual encode step decides the final codec.
    """
    from mutagen.flac import FLAC

    from maneki.audio.convert import FFMPEG_BIN, FFmpegFailedError, ensure_ffmpeg

    ensure_ffmpeg()
    dest.mkdir(parents=True, exist_ok=True)
    sheet = image.sheet
    total = len(sheet.tracks)
    carried, pictures = _image_tags(image.image)

    def split_one(index: int) -> Path:
        track = sheet.tracks[index]
        end = sheet.tracks[index + 1].start_s if index + 1 < total else None
        out = dest / f"{track.number:02d}.flac"
        tmp = out.with_name(f".{out.name}.part.flac")
        cmd = [
            FFMPEG_BIN,
            "-y",
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            f"{track.start_s:.6f}",
        ]
        if end is not None:
            cmd += ["-t", f"{end - track.start_s:.6f}"]
        cmd += ["-i", str(image.image), "-map", "0:a:0", "-map_metadata", "-1", "-c:a", "flac", str(tmp)]
        result = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            tmp.unlink(missing_ok=True)
            raise FFmpegFailedError(cmd, result.returncode, result.stderr)

        flac = FLAC(tmp)
        for key, values in carried.items():
            flac[key] = values
        carried_artist = carried.get("ALBUMARTIST") or carried.get("ALBUM ARTIST") or []
        album_artist = sheet.performer or (carried_artist[0] if carried_artist else None)
        fields = {
            "TITLE": track.title,
            "ARTIST": track.performer or album_artist,
            "ALBUM": sheet.title,
            "ALBUMARTIST": album_artist,
            "DATE": sheet.date,
            "GENRE": sheet.genre,
            "ISRC": track.isrc,
            "TRACKNUMBER": str(track.number),
            "TRACKTOTAL": str(total),
        }
        for key, value in fields.items():
            if value:
                flac[key] = value
        for picture in pictures:
            flac.add_picture(picture)
        flac.save()
        os.replace(tmp, out)
        return out

    with ThreadPoolExecutor(max_workers=max(1, min(workers, total))) as pool:
        return list(pool.map(split_one, range(total)))
