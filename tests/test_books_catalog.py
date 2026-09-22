"""Book identification: rip names, catalog scoring, chapter alignment, and the catalog client."""

from __future__ import annotations

from collections.abc import Callable

import httpx2 as httpx
import pytest

from maneki.audio.enrich import _http
from maneki.books.catalog import BookCatalog, align_chapters, choose, plain_text
from maneki.books.models import CatalogBook, CatalogChapters, Chapter
from maneki.books.names import clean_title, guess_from_name, looks_like_person

Handler = Callable[[httpx.Request], httpx.Response]

# Audible's two unabridged editions of the book, and a summary that is not it.
_EGAN = CatalogBook(
    source="audible",
    asin="B005TKKCWC",
    title="Thinking, Fast and Slow",
    authors=["Daniel Kahneman"],
    narrators=["Patrick Egan"],
    year="2011",
    runtime_s=1202 * 60,
)
_EGAN_REISSUE = _EGAN.model_copy(update={"asin": "B006QNR18Y", "runtime_s": 1204 * 60})
_SUMMARY = CatalogBook(
    source="audible",
    asin="B084BMZDRM",
    title="Summary of Thinking, Fast and Slow by Daniel Kahneman: Key Takeaways & Analysis",
    authors=["Ninja Reads"],
    runtime_s=106 * 60,
)


@pytest.fixture(autouse=True)
def _no_throttle(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(_http, "RATE_LIMIT_SECONDS", 0.0)
    monkeypatch.setattr(_http, "_throttles", {})
    monkeypatch.setattr(_http, "_exhausted_ladders", {})


# --- names ---------------------------------------------------------------------


def test_title_then_author() -> None:
    guess = guess_from_name("Thinking, Fast and Slow - Daniel Kahneman")
    assert (guess.title, guess.author) == ("Thinking, Fast and Slow", "Daniel Kahneman")


def test_surname_first_with_narrator_year_and_bitrate() -> None:
    guess = guess_from_name("Kahneman Daniel - Thinking, Fast and Slow(Egan Patrick) - 2011(80bps)")
    assert guess.title == "Thinking, Fast and Slow"
    assert guess.author == "Kahneman Daniel"
    assert guess.narrator == "Egan Patrick"
    assert guess.year == "2011"


def test_read_by_and_year_parentheticals_peel_in_either_order() -> None:
    guess = guess_from_name("Tolkien, J.R.R. - The Hobbit (read by Andy Serkis) (2020)")
    assert (guess.author, guess.title, guess.narrator, guess.year) == (
        "Tolkien, J.R.R.",
        "The Hobbit",
        "Andy Serkis",
        "2020",
    )


def test_rip_details_are_dropped() -> None:
    guess = guess_from_name("Stephen King - It (Unabridged) [MP3 64kbps]")
    assert (guess.author, guess.title) == ("Stephen King", "It")


def test_part_numbers_are_not_narrators() -> None:
    guess = guess_from_name("Dune (Part One)")
    assert guess.narrator is None
    assert guess.title == "Dune (Part One)"


def test_looks_like_person() -> None:
    assert looks_like_person("Ursula K. Le Guin")
    assert looks_like_person("Tolkien, J.R.R.")
    assert not looks_like_person("Thinking, Fast and Slow")
    assert not looks_like_person("The Hobbit")
    assert not looks_like_person("Catch 22")


def test_clean_title() -> None:
    assert clean_title("It (Unabridged) [MP3]") == "It"


# --- choosing an edition -------------------------------------------------------


def test_choose_prefers_the_edition_whose_runtime_matches() -> None:
    guess = guess_from_name("Kahneman Daniel - Thinking, Fast and Slow(Egan Patrick) - 2011(80bps)")
    other_recording = _EGAN.model_copy(update={"asin": "B0OTHER", "runtime_s": 1311 * 60})
    picked = choose(guess, 72130.09, [_SUMMARY, other_recording, _EGAN])
    assert [b.asin for b in picked] == ["B005TKKCWC", "B0OTHER"]


def test_choose_breaks_a_tie_in_catalog_order() -> None:
    guess = guess_from_name("Thinking, Fast and Slow - Daniel Kahneman")
    picked = choose(guess, 72130.09, [_EGAN_REISSUE, _EGAN])
    assert [b.asin for b in picked] == ["B006QNR18Y", "B005TKKCWC"]


def test_choose_keeps_the_book_when_no_runtime_matches() -> None:
    guess = guess_from_name("Thinking, Fast and Slow - Daniel Kahneman")
    picked = choose(guess, 78716.13, [_SUMMARY, _EGAN, _EGAN_REISSUE])
    assert [b.asin for b in picked] == ["B005TKKCWC", "B006QNR18Y"]


def test_choose_matches_a_swapped_title_and_author() -> None:
    weir = CatalogBook(source="audible", title="Project Hail Mary", authors=["Andy Weir"])
    guess = guess_from_name("Project Hail Mary - Andy Weir")
    assert choose(guess, 0.0, [weir]) == [weir]


def test_choose_rejects_a_different_book_by_the_same_author() -> None:
    other = CatalogBook(source="audible", title="Noise", authors=["Daniel Kahneman"])
    guess = guess_from_name("Thinking, Fast and Slow - Daniel Kahneman")
    assert choose(guess, 0.0, [other]) == []


def test_choose_without_an_author_needs_the_whole_title() -> None:
    hobbit = CatalogBook(source="itunes", title="The Hobbit", authors=["J.R.R. Tolkien"])
    longer = CatalogBook(source="itunes", title="The Hobbit and the Lord of the Rings", authors=["J.R.R. Tolkien"])
    assert choose(guess_from_name("The Hobbit"), 0.0, [longer, hobbit]) == [hobbit]


# --- aligning chapters ---------------------------------------------------------


def _listing(runtime: float, intro: float = 4.0, outro: float = 5.0) -> CatalogChapters:
    return CatalogChapters(
        runtime_s=runtime,
        intro_s=intro,
        outro_s=outro,
        chapters=[
            Chapter(title="Opening Credits", start_s=0.0, end_s=30.0),
            Chapter(title="1", start_s=30.0, end_s=500.0),
            Chapter(title="End Credits", start_s=500.0, end_s=runtime),
        ],
    )


def test_align_exact_runtime_keeps_catalog_times() -> None:
    aligned = align_chapters(_listing(1000.0), 1000.0)
    assert aligned is not None
    assert [c.start_s for c in aligned] == [0.0, 30.0, 500.0]
    assert aligned[-1].end_s == 1000.0


def test_align_cut_intro_shifts_every_chapter_earlier() -> None:
    aligned = align_chapters(_listing(1000.0, intro=4.0, outro=9.0), 996.0)
    assert aligned is not None
    assert [c.start_s for c in aligned] == [0.0, 26.0, 496.0]
    assert aligned[-1].end_s == 996.0


def test_align_ambiguous_cut_puts_chapters_early() -> None:
    """Intro 4 s and outro 5 s both explain a file 4.5 s short: chapters start early, never late."""
    aligned = align_chapters(_listing(1000.0, intro=4.0, outro=5.0), 995.5)
    assert aligned is not None
    assert aligned[1].start_s == 26.0


def test_align_refuses_a_different_recording() -> None:
    assert align_chapters(_listing(1000.0), 1100.0) is None


def test_plain_text_keeps_paragraphs() -> None:
    assert plain_text("<p>One &amp; two.</p><p><b>Three</b></p>") == "One & two.\n\nThree"


# --- the catalog client --------------------------------------------------------


def _catalog(handler: Handler) -> BookCatalog:
    return BookCatalog(httpx.Client(transport=httpx.MockTransport(handler)))


def test_audible_search_parses_products() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "api.audible.com"
        assert request.url.params["keywords"] == "Kahneman Thinking"
        return httpx.Response(
            200,
            json={
                "products": [
                    {
                        "asin": "B005TKKCWC",
                        "title": "Thinking, Fast and Slow",
                        "authors": [{"name": "Daniel Kahneman"}],
                        "narrators": [{"name": "Patrick Egan"}],
                        "release_date": "2011-10-25",
                        "runtime_length_min": 1202,
                        "product_images": {"500": "https://m.media-amazon.com/images/I/41x._SL500_.jpg"},
                        "publisher_summary": "<p>A book.</p>",
                        "series": [{"title": "Series", "sequence": "1"}],
                    }
                ]
            },
        )

    [book] = _catalog(handler).audible_search("Kahneman Thinking")
    assert book.asin == "B005TKKCWC"
    assert book.narrators == ["Patrick Egan"]
    assert book.runtime_s == 1202 * 60
    assert book.year == "2011"
    assert book.description == "A book."
    assert (book.series, book.series_position) == ("Series", "1")


def test_itunes_search_strips_the_edition_and_asks_for_large_art() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["media"] == "audiobook"
        return httpx.Response(
            200,
            json={
                "results": [
                    {
                        "collectionName": "Thinking, Fast and Slow (Unabridged)",
                        "artistName": "Daniel Kahneman",
                        "releaseDate": "2011-10-25T07:00:00Z",
                        "artworkUrl100": "https://is1.mzstatic.com/image/thumb/x.jpg/100x100bb.jpg",
                    }
                ]
            },
        )

    [book] = _catalog(handler).itunes_search("x")
    assert book.title == "Thinking, Fast and Slow"
    assert book.cover_url is not None and book.cover_url.endswith("3000x3000bb.jpg")


def test_chapters_come_back_in_seconds_with_the_branding_lengths() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/books/B005TKKCWC/chapters"
        return httpx.Response(
            200,
            json={
                "runtimeLengthMs": 72134715,
                "brandIntroDurationMs": 3970,
                "brandOutroDurationMs": 4945,
                "chapters": [
                    {"title": "Opening Credits", "startOffsetMs": 0, "lengthMs": 2547456},
                    {"title": "Part I. Two Systems", "startOffsetMs": 2547456, "lengthMs": 3000},
                ],
            },
        )

    listing = _catalog(handler).chapters("B005TKKCWC")
    assert listing is not None
    assert listing.runtime_s == pytest.approx(72134.715)
    assert (listing.intro_s, listing.outro_s) == (3.97, 4.945)
    assert listing.chapters[1] == Chapter(title="Part I. Two Systems", start_s=2547.456, end_s=2550.456)


def test_a_missing_edition_or_a_server_error_is_no_answer() -> None:
    assert _catalog(lambda r: httpx.Response(404)).chapters("B0") is None
    assert _catalog(lambda r: httpx.Response(500)).audible_search("x") == []


def test_details_take_the_full_size_cover() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"image": "https://m.media-amazon.com/images/I/61Z.jpg", "description": "D"})

    book = _catalog(handler).details(_EGAN)
    assert book.cover_url == "https://m.media-amazon.com/images/I/61Z.jpg"
    assert book.description == "D"
