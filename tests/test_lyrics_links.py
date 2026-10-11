"""A link where the words should be is not lyrics."""

from __future__ import annotations

from maneki.audio.lyrics import real_lyrics


def test_a_link_alone_is_no_lyrics() -> None:
    """262 tracks carried an advert's address as their embedded "lyric", and the overlay showed it
    as the words of the song."""
    assert real_lyrics("www.t.me/pmedia_music") is None
    assert real_lyrics("  https://example.org/a?b=c \n") is None
    assert real_lyrics("t.me/channel\nwww.example.org") is None
    assert real_lyrics("") is None
    assert real_lyrics(None) is None


def test_words_are_lyrics_even_with_a_link_among_them() -> None:
    text = "I want to break free\nhttps://example.org"
    assert real_lyrics(text) == text
    assert real_lyrics("[00:12.00]Hello") == "[00:12.00]Hello"
