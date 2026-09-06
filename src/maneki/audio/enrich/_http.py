"""Shared httpx client + 1 req/sec throttle for online enrichment providers."""

from __future__ import annotations

import math
import socket
import threading
import time

import httpx

from maneki import __version__

USER_AGENT = f"maneki/audio/{__version__} ( https://github.com/winterop-com/maneki )"
DEFAULT_TIMEOUT = 15.0
RATE_LIMIT_SECONDS = 1.0  # MusicBrainz allows 1 req/sec for anonymous use.
# MusicBrainz answers 503 (and occasionally 429) when it is overloaded or
# when it decides a client is over the rate limit — both transient. Retry
# with a short backoff before giving up; `Retry-After` wins when present.
RETRY_STATUSES = frozenset({429, 503})
RETRY_BACKOFF_SECONDS: tuple[float, ...] = (2.0, 5.0)
MAX_RETRY_AFTER_SECONDS = 30.0
# Circuit breaker: once a host has exhausted the retry ladder this many times
# in a row it is treated as down for the rest of the process and requests go
# through single-shot. Keeps a sustained outage from adding the full backoff
# to every album of a long batch run.
RETRY_BREAKER_THRESHOLD = 2


class _Throttle:
    """Thread-safe minimum-interval gate between requests to one host."""

    def __init__(self, min_interval: float) -> None:
        self._min_interval = min_interval
        self._lock = threading.Lock()
        self._last = 0.0

    def wait(self) -> None:
        with self._lock:
            now = time.monotonic()
            sleep_for = self._min_interval - (now - self._last)
            if sleep_for > 0:
                time.sleep(sleep_for)
            self._last = time.monotonic()

    def hold(self, seconds: float) -> None:
        """Push the next permitted request for this host `seconds` into the future.

        A `Retry-After` / 429 asks the whole client to back off, not just the
        thread that saw it — so the pause is recorded on the shared gate and
        every caller's next `wait()` honours it.
        """
        with self._lock:
            self._last = max(self._last, time.monotonic() + seconds - self._min_interval)


_throttles: dict[str, _Throttle] = {}
_throttle_lock = threading.Lock()
# host_key -> consecutive exhausted retry ladders; hosts at the threshold are tripped.
_exhausted_ladders: dict[str, int] = {}


def get_client() -> httpx.Client:
    """Build an httpx client with our polite defaults. Caller closes it."""
    return httpx.Client(
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
        timeout=DEFAULT_TIMEOUT,
        follow_redirects=True,
    )


def is_online(timeout: float = 0.5) -> bool:
    """Return True when MusicBrainz is reachable (TCP-level check, no HTTP).

    Short timeout (500 ms) — a real handshake completes in well under 100 ms;
    blocking longer just adds latency to offline runs. On flaky networks where
    the probe is unreliable, pass `--enrich` to bypass it entirely.
    """
    try:
        with socket.create_connection(("musicbrainz.org", 443), timeout=timeout):
            return True
    except OSError:
        return False


def _retry_delay(response: httpx.Response, fallback: float) -> float:
    """Seconds to wait before retrying `response`: a sane `Retry-After`, else `fallback`.

    Only the RFC 7231 delay-seconds form is honoured (an HTTP-date is rare
    from these hosts and not worth parsing); anything non-finite or negative
    falls back so a malformed header can never reach `time.sleep`.
    """
    header = (response.headers.get("Retry-After") or "").strip()
    if header:
        try:
            seconds = float(header)
        except ValueError:
            seconds = math.nan
        if math.isfinite(seconds) and seconds >= 0:
            return min(seconds, MAX_RETRY_AFTER_SECONDS)
    return fallback


def _record_ladder_outcome(host_key: str, exhausted: bool) -> None:
    with _throttle_lock:
        _exhausted_ladders[host_key] = _exhausted_ladders.get(host_key, 0) + 1 if exhausted else 0


def throttled_get(client: httpx.Client, url: str, *, host_key: str, **kwargs: object) -> httpx.Response:
    """GET `url` with a host-keyed minimum-interval throttle applied first.

    Transient 503/429 answers are retried once per entry in
    `RETRY_BACKOFF_SECONDS`; the last response is returned either way so
    callers keep their own `raise_for_status()` handling. After
    `RETRY_BREAKER_THRESHOLD` consecutive exhausted ladders the host is
    considered down and further calls are single-shot (a success resets it).
    """
    with _throttle_lock:
        throttle = _throttles.setdefault(host_key, _Throttle(RATE_LIMIT_SECONDS))
        tripped = _exhausted_ladders.get(host_key, 0) >= RETRY_BREAKER_THRESHOLD
    backoffs: tuple[float, ...] = () if tripped else RETRY_BACKOFF_SECONDS
    for backoff in backoffs:
        throttle.wait()
        response = client.get(url, **kwargs)  # type: ignore[arg-type]
        if response.status_code not in RETRY_STATUSES:
            _record_ladder_outcome(host_key, exhausted=False)
            return response
        throttle.hold(_retry_delay(response, backoff))
    throttle.wait()
    response = client.get(url, **kwargs)  # type: ignore[arg-type]
    if not tripped:
        _record_ladder_outcome(host_key, exhausted=response.status_code in RETRY_STATUSES)
    elif response.status_code not in RETRY_STATUSES:
        _record_ladder_outcome(host_key, exhausted=False)
    return response
