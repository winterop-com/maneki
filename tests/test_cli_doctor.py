"""`maneki doctor` + the encoder-environment probe (no real ffmpeg)."""

from __future__ import annotations

import pytest
from typer.testing import CliRunner

from maneki.cli import app
from maneki.video.serve import encoders


@pytest.fixture(autouse=True)
def _clear_caches() -> None:
    for fn in (
        encoders._ffmpeg_encoders,
        encoders._vaapi_works,
        encoders.tonemap_available,
        encoders.select_encoder,
        encoders._ffmpeg_version,
        encoders._ffprobe_version,
    ):
        fn.cache_clear()


def _stub_env(monkeypatch: pytest.MonkeyPatch, *, ffmpeg: bool, selected: str, zscale: bool) -> None:
    monkeypatch.setattr(encoders, "ffmpeg_path", (lambda: "/usr/bin/ffmpeg") if ffmpeg else (lambda: None))
    monkeypatch.setattr(encoders, "ffprobe_path", (lambda: "/usr/bin/ffprobe") if ffmpeg else (lambda: None))
    monkeypatch.setattr(encoders, "_ffmpeg_encoders", lambda: frozenset({"libx264", selected} if ffmpeg else set()))
    monkeypatch.setattr(encoders, "_ffmpeg_version", lambda: "8.1.1" if ffmpeg else None)
    monkeypatch.setattr(encoders, "_ffprobe_version", lambda: "8.1.1" if ffmpeg else None)
    monkeypatch.setattr(encoders, "_vaapi_works", lambda: selected == "h264_vaapi")
    monkeypatch.setattr(encoders, "tonemap_available", lambda: zscale)
    monkeypatch.setattr(encoders, "select_encoder", lambda: selected)


def test_probe_reports_selected_encoder(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_env(monkeypatch, ffmpeg=True, selected="h264_videotoolbox", zscale=True)
    report = encoders.probe_encoders()
    assert report.ffmpeg_path == "/usr/bin/ffmpeg"
    assert report.ffprobe_path == "/usr/bin/ffprobe"
    assert report.ffmpeg_version == "8.1.1"
    assert report.selected == "h264_videotoolbox"
    assert "h264_videotoolbox" in report.hw_encoders
    assert report.tonemap_zscale is True


def test_doctor_exits_ok_with_ffmpeg(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_env(monkeypatch, ffmpeg=True, selected="libx264", zscale=False)
    result = CliRunner().invoke(app, ["doctor"])
    assert result.exit_code == 0
    assert "libx264" in result.stdout


def test_doctor_exits_nonzero_without_ffmpeg(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_env(monkeypatch, ffmpeg=False, selected="libx264", zscale=False)
    result = CliRunner().invoke(app, ["doctor"])
    assert result.exit_code == 1
