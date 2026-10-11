"""Video search matches the words typed, however a release name separates them."""

from __future__ import annotations

from maneki.video.search import matches


def test_words_typed_with_spaces_find_a_dotted_release_name() -> None:
    # "Past Prologue" found nothing: the file says "Past.Prologue".
    name = "Star.Trek.DS9.s01e03.Past.Prologue.mkv"
    assert matches("Past Prologue", name)
    assert matches("star trek past", name)
    assert matches("ds9 S01E03", name)


def test_every_word_has_to_be_there() -> None:
    assert not matches("past future", "Star.Trek.DS9.s01e03.Past.Prologue.mkv")


def test_a_dash_or_an_underscore_separates_words_too() -> None:
    assert matches("star trek generations", "Star_Trek-Generations (1994).mkv")


def test_nothing_typed_matches_nothing() -> None:
    assert not matches("   ", "anything.mkv")


def test_letters_beyond_ascii_stay_in_their_word() -> None:
    assert matches("røyksopp", "Röyksopp.Live.at.Øya.mkv") is False
    assert matches("øya", "Röyksopp.Live.at.Øya.mkv")
