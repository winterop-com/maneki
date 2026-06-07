"""Subsonic auth — plain `?p=` and salted-token `?t=md5(password+salt)&s=`.

Both forms are part of the v1.13.0+ spec; modern clients use token, but
older or simpler ones (curl, mpDris) use plain. We accept either, and an
`enc:<hex>` plain-password variant some clients send.

Multi-user: credentials are checked against the `UserRegistry`, so each
account authenticates with its own password. `verify()` returns the matched
account so the caller can scope per-user data to it.
"""

from __future__ import annotations

import hashlib
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from maneki.audio.serve.users import ResolvedUser, UserRegistry


class AuthError(Exception):
    """Raised when auth fails — caller maps to Subsonic error 40."""


def verify(
    registry: UserRegistry,
    *,
    user: str | None,
    password: str | None,
    token: str | None,
    salt: str | None,
) -> ResolvedUser:
    """Validate Subsonic credentials against the registry. Raise `AuthError` on failure.

    Subsonic clients send EITHER `p=<password>` (plain or `enc:<hex>`) OR
    `t=<md5(password+salt)>&s=<salt>`. We accept both, and return the
    authenticated account on success.
    """
    if not user:
        raise AuthError("missing username")
    account = registry.get(user)
    if account is None:
        raise AuthError("wrong username or password")
    if token is not None and salt is not None:
        expected = hashlib.md5((account.password + salt).encode("utf-8")).hexdigest()  # noqa: S324
        # MD5 here is mandated by the Subsonic spec — not our choice and not used
        # for anything secret-bearing (it's a challenge response over a salt).
        if token.lower() != expected.lower():
            raise AuthError("wrong username or password")
        return account
    if password is None:
        raise AuthError("missing password or token")
    if _decode_password(password) != account.password:
        raise AuthError("wrong username or password")
    return account


def _decode_password(value: str) -> str:
    """Decode the `enc:<hex>` form some clients use; pass plain through."""
    if value.startswith("enc:"):
        try:
            return bytes.fromhex(value[4:]).decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            return value
    return value
