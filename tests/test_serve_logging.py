"""The serve logging filter that drops benign CancelledError tracebacks.

A client disconnecting mid-stream or a Ctrl+C shutdown surfaces as an
asyncio.CancelledError that BaseHTTPMiddleware re-raises, so uvicorn logs a
full "Exception in ASGI application" stack for what is never a real error.
`_DropCancelledError` suppresses exactly those records.
"""

from __future__ import annotations

import asyncio
import logging

from maneki.audio.serve.logging import _DropCancelledError


def _record(exc: BaseException | None) -> logging.LogRecord:
    rec = logging.LogRecord(
        name="uvicorn.error",
        level=logging.ERROR,
        pathname=__file__,
        lineno=1,
        msg="Exception in ASGI application",
        args=(),
        exc_info=None,
    )
    if exc is not None:
        rec.exc_info = (type(exc), exc, exc.__traceback__)
    return rec


def test_drops_direct_cancelled_error() -> None:
    assert _DropCancelledError().filter(_record(asyncio.CancelledError())) is False


def test_drops_wrapped_cancelled_error() -> None:
    """The "during handling of the above, another occurred" chain is unwrapped."""
    outer = RuntimeError("ASGI app failed")
    outer.__context__ = asyncio.CancelledError()
    assert _DropCancelledError().filter(_record(outer)) is False


def test_keeps_real_exception() -> None:
    assert _DropCancelledError().filter(_record(ValueError("a real bug"))) is True


def test_keeps_record_without_exc_info() -> None:
    assert _DropCancelledError().filter(_record(None)) is True
