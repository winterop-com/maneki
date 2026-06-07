"""Small video-transcode utilities."""

from __future__ import annotations

from maneki.video.serve.transcode import log_safe


def test_log_safe_collapses_line_breaks() -> None:
    # A crafted filename with embedded CR/LF must not be able to forge log
    # lines (CodeQL py/log-injection): newlines become spaces, one line out.
    assert log_safe("ep1\r\nINJECTED admin login") == "ep1  INJECTED admin login"
    assert log_safe("clean-id") == "clean-id"
    assert "\n" not in log_safe("a\nb\r\nc")


def test_log_safe_stringifies_non_str() -> None:
    assert log_safe(42) == "42"
    assert log_safe(ValueError("boom\nx")) == "boom x"
