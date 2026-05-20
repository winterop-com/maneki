"""Shared HTTP access-log middleware for the maneki app stack.

One structured log line per HTTP request, with the canonical Apache
combined log fields (client IP, authenticated user, method, path, HTTP
version, status, bytes, referer, user_agent) plus a `duration_ms` for
slow-endpoint spotting. Routes through the structlog handler that
`configure_logging()` installs, so `MANEKI_LOG_FORMAT=json` produces
one machine-parseable record per request.

Originally lived inside `audio/serve/app.py` for the Subsonic mount;
lifted here so the video sub-app gets the same per-request line
(without it, /video/api/* requests were silent because the unified
logging config silences uvicorn's default access log in favour of
this richer one).

Each sub-app instantiates the middleware with its own logger name so
the audio + video access logs stay distinguishable in JSON output and
ConsoleRenderer's logger-name suffix:

    [maneki.audio.serve.access]
    [maneki.video.serve.access]
"""

from __future__ import annotations

import time
from typing import Any

import structlog
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response


def make_access_log_middleware(logger_name: str) -> type[BaseHTTPMiddleware]:
    """Return a Starlette middleware class that logs requests to `logger_name`.

    Returning a class (rather than a callable instance) lets the caller
    register it via the canonical `app.add_middleware(...)` API. Each
    call returns a fresh subclass bound to its own logger so the audio
    and video stacks log under distinct names without sharing module
    state.
    """
    access_log = structlog.stdlib.get_logger(logger_name)

    class _AccessLogMiddleware(BaseHTTPMiddleware):
        """One structured log line per HTTP request."""

        async def dispatch(self, request: Request, call_next: Any) -> Response:
            started = time.perf_counter()
            response: Response = await call_next(request)
            elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
            client = request.client.host if request.client else "-"
            # Subsonic auth puts the username in `?u=`; surface it where
            # an Apache log would carry `%u`. Falls back to "-" for any
            # request that hasn't authenticated yet (root probe, OPTIONS,
            # /video/* under auth=off, etc.). A future bearer-token
            # decoder can extend this without changing the call sites.
            user = request.query_params.get("u") or "-"
            http_version = request.scope.get("http_version", "1.1")
            bytes_sent = response.headers.get("content-length", "-")
            access_log.info(
                "request",
                client=client,
                user=user,
                method=request.method,
                path=request.url.path,
                http_version=http_version,
                status=response.status_code,
                bytes=bytes_sent,
                referer=request.headers.get("referer", "-"),
                user_agent=request.headers.get("user-agent", "-"),
                duration_ms=elapsed_ms,
            )
            return response

    return _AccessLogMiddleware
