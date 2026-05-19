"""Tests for the subtitle-default priority pass.

Direct unit tests against `_apply_default_priority`: build a synthetic
track list, run the helper, assert exactly the expected track is
marked `default=True`. No fastapi / video / ffmpeg involvement.
"""

from __future__ import annotations

import pytest

from mediakit.video.serve.app import _apply_default_priority


def _track(lang: str, label: str, default: bool = False, kind: str = "embedded") -> dict[str, object]:
    return {"lang": lang, "label": label, "default": default, "kind": kind}


def _sidecar(lang: str, label: str) -> dict[str, object]:
    return _track(lang, label, kind="sidecar")


def test_no_tracks_is_a_noop() -> None:
    tracks: list[dict[str, object]] = []
    _apply_default_priority(tracks)
    assert tracks == []


def test_prefers_english_sdh_over_plain_english() -> None:
    tracks = [
        _track("eng", "English"),
        _track("eng", "English (SDH)"),
    ]
    _apply_default_priority(tracks)
    assert tracks[0]["default"] is False
    assert tracks[1]["default"] is True


def test_falls_back_to_plain_english_when_no_sdh() -> None:
    tracks = [
        _track("spa", "Spanish"),
        _track("eng", "English"),
        _track("fra", "French"),
    ]
    _apply_default_priority(tracks)
    assert [t["default"] for t in tracks] == [False, True, False]


def test_no_default_when_no_english() -> None:
    tracks = [
        _track("spa", "Spanish"),
        _track("fra", "French"),
        _track("jpn", "Japanese"),
    ]
    _apply_default_priority(tracks)
    assert all(t["default"] is False for t in tracks)


@pytest.mark.parametrize(
    "label",
    [
        "English (SDH)",
        "English [CC]",
        "English (CC)",
        "English CC",
        "English (Hearing Impaired)",
        "English (HoH)",
        "english sdh",  # case-insensitive
    ],
)
def test_recognises_sdh_variants(label: str) -> None:
    tracks = [
        _track("eng", "English"),
        _track("eng", label),
    ]
    _apply_default_priority(tracks)
    chosen = [t for t in tracks if t["default"]]
    assert chosen == [tracks[1]], f"expected {label!r} to be picked over plain English"


def test_three_letter_eng_works() -> None:
    tracks = [_track("eng", "English (SDH)")]
    _apply_default_priority(tracks)
    assert tracks[0]["default"] is True


def test_two_letter_en_works() -> None:
    tracks = [_track("en", "English (SDH)")]
    _apply_default_priority(tracks)
    assert tracks[0]["default"] is True


def test_ignores_pre_existing_default_when_no_english() -> None:
    """ffprobe's stream-disposition default is intentionally discarded -
    real-world files often mark Spanish or Japanese as default and we
    don't want that to leak through when there's no English option."""
    tracks = [
        _track("spa", "Spanish", default=True),
        _track("jpn", "Japanese"),
    ]
    _apply_default_priority(tracks)
    assert all(t["default"] is False for t in tracks)


def test_lone_und_sidecar_becomes_default() -> None:
    """A `.srt` dropped next to the video with no language tag is the
    user's explicit "use this" signal."""
    tracks = [_sidecar("und", "Subtitles")]
    _apply_default_priority(tracks)
    assert tracks[0]["default"] is True


def test_sidecar_beats_embedded_english() -> None:
    """An untagged sidecar still wins over a stream-tagged English
    embedded track - the sidecar is a deliberate user choice."""
    tracks = [
        _track("eng", "English"),
        _sidecar("und", "Subtitles"),
    ]
    _apply_default_priority(tracks)
    assert tracks[0]["default"] is False
    assert tracks[1]["default"] is True


def test_english_sidecar_picked_over_other_sidecars() -> None:
    """When multiple sidecars exist, prefer English."""
    tracks = [
        _sidecar("fr", "FR"),
        _sidecar("eng", "English"),
        _sidecar("und", "Subtitles"),
    ]
    _apply_default_priority(tracks)
    assert [t["default"] for t in tracks] == [False, True, False]


def test_sdh_sidecar_picked_over_plain_english_sidecar() -> None:
    tracks = [
        _sidecar("en", "English"),
        _sidecar("en", "English (SDH)"),
    ]
    _apply_default_priority(tracks)
    assert tracks[0]["default"] is False
    assert tracks[1]["default"] is True


def test_sdh_in_unrelated_word_is_not_a_false_positive() -> None:
    """The substring 'sdh' is rare enough that titles like 'Sundhauser'
    aren't a real-world concern, but verify the matcher doesn't drag in
    unrelated tokens like a bare 'cc' inside a regular word."""
    tracks = [
        _track("eng", "English"),
        _track("eng", "Accent: British"),  # contains 'cc' as substring
    ]
    _apply_default_priority(tracks)
    # Plain English wins, NOT the "Accent" track (which doesn't really
    # match our SDH patterns because there's no surrounding space).
    assert tracks[0]["default"] is True
    assert tracks[1]["default"] is False
