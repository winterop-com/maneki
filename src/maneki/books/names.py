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
# A trailing parenthetical naming the reader: `(Egan Patrick)`, `(read by Kate Reading)`,
# `(VC2 - read by Frank Muller)`, `(short story with Joe Hill - read by Stephen Lang)`.
_TRAILING_PAREN_RE = re.compile(r"\s*[\(\[]([^\(\)\[\]]+)[\)\]]\s*$")
_READ_BY_RE = re.compile(r"(?:^|\s)(?:read|narrated|performed)\s+by\s+(.+)$", re.I)
# A trailing note that counts what the book collects: `(4 novellas)`, `(20 short stories)`.
_CONTENTS_NOTE_RE = re.compile(r"^\d+\s+(?:novellas?|novels?|short\s+stories|stories|essays)$", re.I)
_SEPARATOR_RE = re.compile(r"\s+-\s+|\s*_-_\s*")
_OPEN_BRACKETS = "([{"
_CLOSE_BRACKETS = ")]}"

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
    for raw in _split_segments(text):
        segment = raw.strip(" -")
        if not segment:
            continue
        if _YEAR_RE.match(segment):
            year = segment
            continue
        segment, reader, paren_year = _peel(segment)
        narrator = narrator or reader
        year = year or paren_year
        if segment:
            segments.append(segment)
    if year is None and bracketed_year is not None:
        year = bracketed_year.group(1)

    title, author = _assign(segments)
    terms = " ".join(p for p in (author, title) if p) or name
    return NameGuess(terms=terms, title=title, author=author, narrator=narrator, year=year)


def split_reader(title: str) -> tuple[str, str | None]:
    """`title` without trailing notes on its reader, with the reader they name.

    Album tags carry the same notes as folder names:
    `The Witching Hour (MW1 - read by Laura Giannarelli)` becomes
    `("The Witching Hour", "Laura Giannarelli")`.
    """
    peeled, reader, _ = _peel(title.strip())
    return (peeled or title.strip()), reader


def author_from_folder(name: str) -> str | None:
    """The author a folder is named for, if it is: `Anne Rice/` holding her books.

    A folder named `Author - Something` gives its author; one named only for
    a person gives that person, given two words or more so that a shelf such
    as `Audiobooks` is not taken for one.
    """
    guess = guess_from_name(name)
    if guess.author:
        return guess.author
    if guess.title and len(guess.title.split()) >= 2 and looks_like_person(guess.title):
        return guess.title
    return None


def clean_title(text: str) -> str:
    """`text` without bracketed rip details or bare bit rates: `It (Unabridged) [MP3]` becomes `It`."""
    cleaned = _BARE_BITRATE_RE.sub(" ", _RIP_BRACKET_RE.sub(" ", text))
    return " ".join(cleaned.split()).strip(" -")


def _split_segments(text: str) -> list[str]:
    """`text` split at its ` - ` separators, except those inside brackets.

    `1985 - The Vampire Lestat (VC2 - read by Frank Muller)` has two
    segments, not three: the dash in the parenthetical is part of its note.
    """
    segments: list[str] = []
    start = 0
    for match in _SEPARATOR_RE.finditer(text):
        before = text[: match.start()]
        depth = sum(before.count(c) for c in _OPEN_BRACKETS) - sum(before.count(c) for c in _CLOSE_BRACKETS)
        if depth <= 0:
            segments.append(text[start : match.start()])
            start = match.end()
    segments.append(text[start:])
    return segments


def _peel(segment: str) -> tuple[str, str | None, str | None]:
    """Peel trailing parentheticals naming a year, the reader or the contents, last first.

    `The Hobbit (read by Andy Serkis) (2020)` gives the reader and the year.
    In `(VC2 - read by Frank Muller)` or `(4 novellas - read by Frank Muller)`
    whatever comes before "read by" is a series code or a note, and goes
    with it. Returns `(segment, reader, year)`.
    """
    reader: str | None = None
    year: str | None = None
    while (paren := _TRAILING_PAREN_RE.search(segment)) is not None:
        inner = paren.group(1).strip()
        read_by = _READ_BY_RE.search(inner)
        if read_by is not None:
            reader = reader or read_by.group(1).strip() or None
        elif _YEAR_RE.match(inner):
            year = year or inner
        elif _CONTENTS_NOTE_RE.match(inner):
            pass
        elif reader is None and looks_like_person(inner):
            reader = inner
        else:
            break
        segment = segment[: paren.start()].strip()
    return segment, reader, year


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
