"""Matching what somebody typed against a video's file name.

WORDS, NOT ONE STRING. Release names separate words with dots, dashes and underscores
("Star.Trek.DS9.s01e03.Past.Prologue"), so "Past Prologue" typed with a space was never a
substring of anything. Both sides are cut into words on anything that is not a letter or a
digit, and every word typed has to start one of the name's words, in any order.
"""

from __future__ import annotations

import re

# Anything that is not a letter or a digit in any script; `_` is a word character to `\w`.
_SEPARATORS = re.compile(r"[\W_]+")


def _words(text: str) -> list[str]:
    return [word for word in _SEPARATORS.split(text.lower()) if word]


def matches(query: str, text: str) -> bool:
    """True when every word of `query` begins a word of `text`; nothing typed matches nothing."""
    wanted = _words(query)
    if not wanted:
        return False
    have = _words(text)
    return all(any(word.startswith(term) for word in have) for term in wanted)
