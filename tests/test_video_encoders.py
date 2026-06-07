"""Pluggable H.264 encoder selection + codec args (no GPU / real ffmpeg)."""

from __future__ import annotations

import types
from pathlib import Path

import pytest

from maneki.video.serve import encoders
from maneki.video.serve.encoders import select_encoder, video_codec_args


@pytest.fixture(autouse=True)
def _clear_caches() -> None:
    # Detection is cached for process lifetime; reset before each test so env /
    # monkeypatched detection takes effect. (monkeypatch reverts the patched
    # functions after the test, so clearing only at setup is safe.)
    select_encoder.cache_clear()
    encoders._vaapi_works.cache_clear()
    encoders._ffmpeg_encoders.cache_clear()
    encoders.tonemap_available.cache_clear()


# --- codec args (pure functions) -------------------------------------------


def test_libx264_sdr_is_unchanged() -> None:
    decode, vf, encode = video_codec_args("libx264", hdr=False)
    assert decode == []
    assert vf is None
    assert encode == ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23"]


def test_libx264_hdr_inserts_software_tonemap() -> None:
    _, vf, _ = video_codec_args("libx264", hdr=True)
    assert vf is not None
    assert "tonemap" in vf and "zscale" in vf


def test_videotoolbox_is_bitrate_driven() -> None:
    decode, vf, encode = video_codec_args("h264_videotoolbox", hdr=False)
    assert decode == []
    assert vf is None
    assert encode[:2] == ["-c:v", "h264_videotoolbox"]
    assert "-b:v" in encode and "-maxrate" in encode


def test_vaapi_sets_device_and_uploads_to_gpu() -> None:
    decode, vf, encode = video_codec_args("h264_vaapi", hdr=False)
    assert "-vaapi_device" in decode
    assert vf == "format=nv12,hwupload"
    assert encode[:2] == ["-c:v", "h264_vaapi"]


def test_vaapi_hdr_tonemaps_then_uploads() -> None:
    _, vf, _ = video_codec_args("h264_vaapi", hdr=True)
    assert vf is not None
    assert "tonemap" in vf
    # Upload must come last so the encoder gets a GPU surface.
    assert vf.endswith("format=nv12,hwupload")


# --- selection -------------------------------------------------------------


def test_env_none_forces_software(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MANEKI_HWENC", "none")
    assert select_encoder() == "libx264"


def test_env_videotoolbox_used_when_listed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MANEKI_HWENC", "videotoolbox")
    monkeypatch.setattr(encoders, "_ffmpeg_encoders", lambda: frozenset({"h264_videotoolbox", "libx264"}))
    assert select_encoder() == "h264_videotoolbox"


def test_env_videotoolbox_falls_back_when_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MANEKI_HWENC", "videotoolbox")
    monkeypatch.setattr(encoders, "_ffmpeg_encoders", lambda: frozenset({"libx264"}))
    assert select_encoder() == "libx264"


def test_env_vaapi_requires_a_working_device(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MANEKI_HWENC", "vaapi")
    monkeypatch.setattr(encoders, "_vaapi_works", lambda: False)
    assert select_encoder() == "libx264"


def test_auto_prefers_vaapi_when_it_probes_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MANEKI_HWENC", "auto")
    monkeypatch.setattr(encoders, "_vaapi_works", lambda: True)
    assert select_encoder() == "h264_vaapi"


# --- HDR probe -------------------------------------------------------------


def _fake_run(stdout: str) -> object:
    def run(*_args: object, **_kwargs: object) -> object:
        return types.SimpleNamespace(stdout=stdout, returncode=0)

    return run


def test_is_hdr_true_for_pq(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(encoders, "ffprobe_path", lambda: "/usr/bin/ffprobe")
    monkeypatch.setattr(encoders.subprocess, "run", _fake_run("smpte2084\n"))
    assert encoders.is_hdr(tmp_path / "movie.mkv") is True


def test_is_hdr_false_for_sdr(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(encoders, "ffprobe_path", lambda: "/usr/bin/ffprobe")
    monkeypatch.setattr(encoders.subprocess, "run", _fake_run("bt709\n"))
    assert encoders.is_hdr(tmp_path / "movie.mkv") is False


# --- tonemap (zscale) availability gate ------------------------------------


def test_tonemap_available_true_when_zscale_present(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(encoders, "ffmpeg_path", lambda: "/usr/bin/ffmpeg")
    monkeypatch.setattr(encoders.subprocess, "run", _fake_run(" .S zscale            V->V       Apply resizing\n"))
    assert encoders.tonemap_available() is True


def test_tonemap_available_false_without_zscale(monkeypatch: pytest.MonkeyPatch) -> None:
    # tonemap present but no zscale -> can't run the software tonemap chain.
    monkeypatch.setattr(encoders, "ffmpeg_path", lambda: "/usr/bin/ffmpeg")
    monkeypatch.setattr(encoders.subprocess, "run", _fake_run(" .S tonemap           V->V       Conversion\n"))
    assert encoders.tonemap_available() is False
