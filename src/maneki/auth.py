"""Bearer-token auth for Maneki-native endpoints.

In-memory token store - tokens survive only until the server process
restarts. Single-user model: credentials come from the same user config
the audio (Subsonic) mount uses, so users edit one place to set their
password.

The audio (Subsonic) mount keeps its own auth grammar (salt + token
query params per the Subsonic spec); this module owns auth for everything
else Maneki-native.
"""

from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta

from pydantic import BaseModel, ConfigDict


class Token(BaseModel):
    """An issued bearer token with its metadata."""

    model_config = ConfigDict(frozen=True)

    value: str
    username: str
    issued_at: datetime
    expires_at: datetime

    @property
    def expired(self) -> bool:
        return self.expires_at <= datetime.now(UTC)


class TokenStore:
    """Issue, validate, and revoke bearer tokens with a fixed TTL.

    Tokens are 256-bit URL-safe random strings. Validation removes
    expired tokens lazily on read so the dict doesn't grow unboundedly
    for short-lived clients.
    """

    DEFAULT_TTL_SECONDS = 24 * 60 * 60

    def __init__(self, ttl_seconds: int = DEFAULT_TTL_SECONDS) -> None:
        self._tokens: dict[str, Token] = {}
        self._ttl = timedelta(seconds=ttl_seconds)

    def issue(self, username: str) -> Token:
        now = datetime.now(UTC)
        token = Token(
            value=secrets.token_urlsafe(32),
            username=username,
            issued_at=now,
            expires_at=now + self._ttl,
        )
        self._tokens[token.value] = token
        return token

    def validate(self, raw: str) -> Token | None:
        token = self._tokens.get(raw)
        if token is None:
            return None
        if token.expired:
            del self._tokens[raw]
            return None
        return token

    def revoke(self, raw: str) -> bool:
        return self._tokens.pop(raw, None) is not None

    def __len__(self) -> int:
        return len(self._tokens)
