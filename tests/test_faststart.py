"""Faststart: the index moves in front of the audio and nothing else about the file changes."""

from __future__ import annotations

import io
import os
import shutil
import struct
import subprocess
from pathlib import Path

import pytest
from mutagen.mp4 import MP4, MP4Cover, MP4FreeForm
from PIL import Image

from maneki.audio.convert import OutputFormat, encode
from maneki.audio.faststart import FaststartError, faststart, faststart_library, iter_mp4_files, needs_faststart

MBID = "cc197bad-dc9c-440d-a5b5-d52ba2e14234"

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not on PATH")


def _top_level_kinds(path: Path) -> list[str]:
    kinds = []
    data = path.read_bytes()
    at = 0
    while at < len(data):
        size, kind = struct.unpack_from(">I4s", data, at)
        if size == 1:
            size = struct.unpack_from(">Q", data, at + 8)[0]
        kinds.append(kind.decode("latin1"))
        at += size
    return [k for k in kinds if k in ("moov", "mdat")]


def _audio_md5(path: Path) -> str:
    return subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-map", "0:a", "-c", "copy", "-f", "md5", "-"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()


def _tagged_m4a(path: Path) -> Path:
    """A real m4a with its index LAST (ffmpeg's default), tagged the way convert tags one."""
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-y", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
         "-c:a", "aac", "-b:a", "96k", "-f", "ipod", str(path)],
        check=True,
    )  # fmt: skip
    cover = io.BytesIO()
    Image.new("RGB", (64, 64), (10, 20, 30)).save(cover, format="JPEG")
    tagged = MP4(path)
    tagged["\xa9nam"] = ["Higher Power"]
    tagged["\xa9ART"] = ["Coldplay"]
    tagged["----:com.apple.iTunes:MusicBrainz Artist Id"] = [MP4FreeForm(MBID.encode())]
    tagged["covr"] = [MP4Cover(cover.getvalue(), imageformat=MP4Cover.FORMAT_JPEG)]
    tagged.save()
    os.utime(path, ns=(1_600_000_000_000_000_000, 1_600_000_000_000_000_000))
    return path


def test_the_index_moves_first_and_nothing_else_changes(tmp_path: Path) -> None:
    track = _tagged_m4a(tmp_path / "one.m4a")
    assert _top_level_kinds(track) == ["mdat", "moov"]
    original = tmp_path / "original.m4a"
    shutil.copy2(track, original)

    assert needs_faststart(track)
    assert faststart(track) == "converted"

    assert _top_level_kinds(track) == ["moov", "mdat"]
    assert not needs_faststart(track)
    assert track.stat().st_size == original.stat().st_size
    # The file's time moves, so media-sync carries the rewrite to the server.
    assert track.stat().st_mtime_ns != original.stat().st_mtime_ns
    assert _audio_md5(track) == _audio_md5(original)
    before, after = MP4(original), MP4(track)
    assert dict(after.tags or {}) == dict(before.tags or {})
    assert after.info is not None and before.info is not None
    assert after.info.length == pytest.approx(before.info.length)
    decoded = subprocess.run(["ffmpeg", "-v", "error", "-i", str(track), "-f", "null", "-"], capture_output=True)
    assert decoded.returncode == 0
    assert decoded.stderr == b""


def test_a_second_run_leaves_the_file_alone(tmp_path: Path) -> None:
    track = _tagged_m4a(tmp_path / "one.m4a")
    faststart(track)
    rewritten = track.read_bytes()
    assert faststart(track) == "already"
    assert track.read_bytes() == rewritten


def test_two_copies_rewritten_separately_end_up_identical(tmp_path: Path) -> None:
    first = _tagged_m4a(tmp_path / "a" / "one.m4a")
    second = tmp_path / "b" / "one.m4a"
    second.parent.mkdir()
    shutil.copy2(first, second)
    faststart(first)
    faststart(second)
    assert first.read_bytes() == second.read_bytes()


def test_the_library_pass_keeps_each_album_folders_time(tmp_path: Path) -> None:
    """'Recently added' sorts by the album folder's time; a rewrite is not an album arriving."""
    album = tmp_path / "Coldplay" / "2021 - Record"
    _tagged_m4a(album / "01.m4a")
    _tagged_m4a(album / "02.m4a")
    os.utime(album, ns=(1_500_000_000_000_000_000, 1_500_000_000_000_000_000))
    heard: list[str] = []
    counts = faststart_library(tmp_path, on_file=lambda path, result: heard.append(f"{path.name}:{result}"))
    assert counts == {"converted": 2, "already": 0, "skipped": 0}
    assert heard == ["01.m4a:converted", "02.m4a:converted"]
    assert album.stat().st_mtime_ns == 1_500_000_000_000_000_000
    assert sorted(p.name for p in album.iterdir()) == ["01.m4a", "02.m4a"]


def test_dry_run_writes_nothing(tmp_path: Path) -> None:
    track = _tagged_m4a(tmp_path / "one.m4a")
    before = track.read_bytes()
    assert faststart(track, dry_run=True) == "converted"
    assert track.read_bytes() == before
    assert list(tmp_path.iterdir()) == [track]


def test_a_file_that_is_not_mp4_is_refused_untouched(tmp_path: Path) -> None:
    bogus = tmp_path / "bogus.m4a"
    bogus.write_bytes(b"\x00\x00\x00\x10ftypM4A \x00\x00\x00\x00")
    with pytest.raises(FaststartError):
        faststart(bogus)
    assert bogus.read_bytes() == b"\x00\x00\x00\x10ftypM4A \x00\x00\x00\x00"


def test_iter_mp4_files_skips_maneki_state_and_hidden_files(tmp_path: Path) -> None:
    (tmp_path / "Artist" / "Album").mkdir(parents=True)
    (tmp_path / "Artist" / "Album" / "01.m4a").write_bytes(b"")
    (tmp_path / "Artist" / "Album" / "cover.jpg").write_bytes(b"")
    (tmp_path / "Artist" / "Album" / ".01.m4a.faststart.tmp").write_bytes(b"")
    (tmp_path / ".maneki").mkdir()
    (tmp_path / ".maneki" / "cache.m4a").write_bytes(b"")
    assert [p.relative_to(tmp_path).as_posix() for p in iter_mp4_files(tmp_path)] == ["Artist/Album/01.m4a"]


def test_convert_writes_the_index_first(tmp_path: Path) -> None:
    source = tmp_path / "source.wav"
    subprocess.run(
        ["ffmpeg", "-y", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=duration=1", str(source)],
        check=True,
    )
    for fmt in (OutputFormat.AAC, OutputFormat.ALAC):
        out = tmp_path / f"out-{fmt.value}.m4a"
        encode(source, out, fmt)
        assert _top_level_kinds(out) == ["moov", "mdat"], fmt


def test_the_cli_rewrites_a_library(tmp_path: Path) -> None:
    from typer.testing import CliRunner

    from maneki.audio.cli import app

    track = _tagged_m4a(tmp_path / "Coldplay" / "2021 - Record" / "01.m4a")
    runner = CliRunner()
    dry = runner.invoke(app, ["library", "faststart", str(tmp_path), "--dry-run"])
    assert dry.exit_code == 0, dry.output
    assert "would rewrite 1" in dry.output
    assert _top_level_kinds(track) == ["mdat", "moov"]
    done = runner.invoke(app, ["library", "faststart", str(tmp_path)])
    assert done.exit_code == 0, done.output
    assert "rewrote 1" in done.output
    assert _top_level_kinds(track) == ["moov", "mdat"]
