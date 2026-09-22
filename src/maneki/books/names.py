"""Guess a book's author, title, narrator and year from a rip's file or folder name.

Rip names follow no single convention: `Title - Author`, `Author - Title`,
`Last First - Title(Narrator) - 2011(80bps)`. The guess here is a best
effort for offline imports and a clean keyword string for the catalog
search, whose answer settles which part was the author.
"""

from __future__ import annotations

import re

from maneki.books.models import NameGuess

# Bracketed groups that describe the rip rather than the book.
_RIP_WORDS = (
    r"mp3|m4b|m4a|aac|flac|ogg|opus|\d+\s*k?bps|\d+\s*khz|vbr|cbr|"
    r"unabridged|abridged|audio\s*book|retail|\d+\s*cds?|\d+\s*discs?"
)
_RIP_BRACKET_RE = re.compile(rf"[\(\[\{{][^\(\)\[\]\{{\}}]*\b(?:{_RIP_WORDS})\b[^\(\)\[\]\{{\}}]*[\)\]\}}]", re.I)
_BARE_BITRATE_RE = re.compile(r"\b\d+\s*k?bps\b", re.I)
_YEAR_RE = re.compile(r"^(?:19|20)\d{2}$")
_BRACKETED_YEAR_RE = re.compile(r"[\(\[]\s*((?:19|20)\d{2})\s*[\)\]]")
# A trailing parenthetical naming the reader: `(Egan Patrick)`, `(read by Kate Reading)`.
_TRAILING_PAREN_RE = re.compile(r"\s*[\(\[]([^\(\)\[\]]+)[\)\]]\s*$")
_READ_BY_RE = re.compile(r"^(?:read|narrated|performed)\s+by\s+", re.I)
_SEPARATOR_RE = re.compile(r"\s+-\s+|\s*_-_\s*")

# Words that mark a phrase as a title rather than a person's name.
_TITLE_WORDS = frozenset(
    "the a an and or of to in on for with at by from is are how why what when who "
    "my your our their this that these those "
    "part book volume vol episode chapter edition series collection trilogy saga".split()
)
# Lower-case particles a real name may carry (`Ursula K. Le Guin`, `Johann von Goethe`).
_NAME_PARTICLES = frozenset("de van von der den la le da di du del bin ibn".split())


def looks_like_person(phrase: str) -> bool:
    """True when `phrase` reads like a person's name rather than a title.

    One to four words, each capitalised or an initial, with no digits and no
    title words. `Tolkien, J.R.R.` (surname first, comma) qualifies too.
    """
    text = phrase.strip()
    if not text or any(ch.isdigit() for ch in text):
        return False
    if text.count(",") > 1:
        return False
    words = text.replace(",", " ").split()
    if not 1 <= len(words) <= 4:
        return False
    for word in words:
        if word.lower() in _TITLE_WORDS:
            return False
        if word.lower() in _NAME_PARTICLES:
            continue
        if not word[0].isupper():
            return False
    return True


def guess_from_name(name: str) -> NameGuess:
    """Split a rip's name (without extension) into the parts a lookup needs."""
    text = name.replace("_", " ")
    year = None
    bracketed_year = _BRACKETED_YEAR_RE.search(text)
    text = _RIP_BRACKET_RE.sub(" ", text)
    text = _BARE_BITRATE_RE.sub(" ", text)

    segments: list[str] = []
    narrator = None
    for raw in _SEPARATOR_RE.split(text):
        segment = raw.strip(" -")
        if not segment:
            continue
        if _YEAR_RE.match(segment):
            year = segment
            continue
        # Peel trailing parentheticals naming a year or the reader, last first:
        # `The Hobbit (read by Andy Serkis) (2020)`.
        while (paren := _TRAILING_PAREN_RE.search(segment)) is not None:
            inner = _READ_BY_RE.sub("", paren.group(1).strip())
            if _YEAR_RE.match(inner):
                year = year or inner
            elif narrator is None and looks_like_person(inner):
                narrator = inner
            else:
                break
            segment = segment[: paren.start()].strip()
        if segment:
            segments.append(segment)
    if year is None and bracketed_year is not None:
        year = bracketed_year.group(1)

    title, author = _assign(segments)
    terms = " ".join(p for p in (author, title) if p) or name
    return NameGuess(terms=terms, title=title, author=author, narrator=narrator, year=year)


def clean_title(text: str) -> str:
    """`text` without bracketed rip details or bare bit rates: `It (Unabridged) [MP3]` becomes `It`."""
    cleaned = _BARE_BITRATE_RE.sub(" ", _RIP_BRACKET_RE.sub(" ", text))
    return " ".join(cleaned.split()).strip(" -")


def _assign(segments: list[str]) -> tuple[str | None, str | None]:
    """Return `(title, author)` from the name's segments."""
    if not segments:
        return None, None
    if len(segments) == 1:
        return segments[0], None
    first, second = segments[0], " - ".join(segments[1:])
    first_person, second_person = looks_like_person(first), looks_like_person(second)
    if second_person and not first_person:
        return first, second
    # `Author - Title` is the more common rip convention, so it wins a tie.
    return second, first
