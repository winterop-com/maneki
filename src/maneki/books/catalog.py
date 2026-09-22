"""Look a book up online: Audible for the edition, Audnexus for its chapters, iTunes as a fallback.

- **Audible catalog** (`api.audible.com/1.0/catalog/products`): a keyword
  search returning editions with authors, narrators, release date and
  runtime to the minute.
- **Audnexus** (`api.audnex.us`, the community API Audiobookshelf uses): an
  edition's chapter list to the millisecond, its full-size cover, and its
  description.
- **iTunes Search** (`media=audiobook`): title, author, year and artwork for
  books Audible does not list. It has no runtimes and no chapters.

Chapters are only taken from the catalog when this recording's length
matches the edition's to within a few seconds; see `align_chapters`.
"""

from __future__ import annotations

import html
import logging
import re
import unicodedata

import httpx2 as httpx

from maneki.audio.enrich._http import get_client, throttled_get
from maneki.books.models import CatalogBook, CatalogChapters, Chapter, NameGuess

log = logging.getLogger(__name__)

AUDIBLE_SEARCH_URL = "https://api.audible.com/1.0/catalog/products"
AUDNEXUS_URL = "https://api.audnex.us/books"
ITUNES_SEARCH_URL = "https://itunes.apple.com/search"
_AUDIBLE_GROUPS = "contributors,product_attrs,media,product_desc,series"

# A catalog's chapter list is used when the file is within this many seconds
# of the edition's runtime, after allowing for a dropped Audible intro/outro.
CHAPTER_TOLERANCE_S = 3.0
# Two readings of the file's length that fit within this of each other are
# treated as equally likely (see `align_chapters`).
_AMBIGUOUS_FIT_S = 1.0
# A candidate counts as the same recording, for picking between editions,
# when its runtime is within this fraction of the file's.
RUNTIME_MATCH_RATIO = 0.01
_MIN_TITLE_SCORE = 0.75
_MIN_AUTHOR_SCORE = 0.5
# Catalog entries that are about a book rather than the book itself.
_DERIVATIVE_WORDS = frozenset({"summary", "summaries", "review", "analysis", "study", "guide", "takeaways"})
_WORD_RE = re.compile(r"[a-z0-9]+")
_TAG_RE = re.compile(r"<[^>]+>")
_PARAGRAPH_END_RE = re.compile(r"</p\s*>|<br\s*/?>", re.I)
_EDITION_SUFFIX_RE = re.compile(r"\s*\((?:un)?abridged\)\s*$", re.I)


class BookCatalog:
    """Audible, Audnexus and iTunes behind one client. Close it when done."""

    def __init__(self, client: httpx.Client | None = None) -> None:
        self._client = client or get_client()
        self._owns_client = client is None

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def search(self, terms: str) -> list[CatalogBook]:
        """Editions matching `terms`, Audible first, then iTunes."""
        return self.audible_search(terms) + self.itunes_search(terms)

    def audible_search(self, terms: str) -> list[CatalogBook]:
        params = {"keywords": terms, "num_results": "10", "response_groups": _AUDIBLE_GROUPS}
        data = self._json(AUDIBLE_SEARCH_URL, host_key="api.audible.com", params=params)
        products = data.get("products") if isinstance(data, dict) else None
        return [_audible_book(p) for p in products or [] if isinstance(p, dict) and p.get("title")]

    def itunes_search(self, terms: str) -> list[CatalogBook]:
        params = {"term": terms, "media": "audiobook", "limit": "10"}
        data = self._json(ITUNES_SEARCH_URL, host_key="itunes.apple.com", params=params)
        results = data.get("results") if isinstance(data, dict) else None
        return [_itunes_book(r) for r in results or [] if isinstance(r, dict) and r.get("collectionName")]

    def chapters(self, asin: str) -> CatalogChapters | None:
        """The edition's chapter list from Audnexus, or None when it has none."""
        data = self._json(f"{AUDNEXUS_URL}/{asin}/chapters", host_key="api.audnex.us")
        if not isinstance(data, dict) or not data.get("chapters") or not data.get("runtimeLengthMs"):
            return None
        chapters: list[Chapter] = []
        for raw in data["chapters"]:
            start = float(raw.get("startOffsetMs", 0)) / 1000
            chapters.append(
                Chapter(
                    title=str(raw.get("title") or f"Chapter {len(chapters) + 1}").strip(),
                    start_s=start,
                    end_s=start + float(raw.get("lengthMs", 0)) / 1000,
                )
            )
        return CatalogChapters(
            runtime_s=float(data["runtimeLengthMs"]) / 1000,
            chapters=chapters,
            intro_s=float(data.get("brandIntroDurationMs") or 0) / 1000,
            outro_s=float(data.get("brandOutroDurationMs") or 0) / 1000,
        )

    def details(self, book: CatalogBook) -> CatalogBook:
        """`book` with Audnexus's full-size cover and description filled in where it has them."""
        if not book.asin:
            return book
        data = self._json(f"{AUDNEXUS_URL}/{book.asin}", host_key="api.audnex.us")
        if not isinstance(data, dict):
            return book
        updates: dict[str, object] = {}
        if data.get("image"):
            updates["cover_url"] = str(data["image"])
        if not book.description and data.get("description"):
            updates["description"] = plain_text(str(data["description"]))
        return book.model_copy(update=updates)

    def fetch_image(self, url: str) -> bytes | None:
        host = httpx.URL(url).host or "images"
        try:
            response = throttled_get(self._client, url, host_key=host)
            response.raise_for_status()
        except httpx.HTTPError as exc:
            log.info("cover download failed for %s: %s", url, exc)
            return None
        return response.content or None

    def _json(self, url: str, *, host_key: str, params: dict[str, str] | None = None) -> object:
        try:
            response = throttled_get(self._client, url, host_key=host_key, params=params)
            if response.status_code == 404:
                return None
            response.raise_for_status()
            return response.json()
        except (httpx.HTTPError, ValueError) as exc:
            log.info("%s lookup failed: %s", host_key, exc)
            return None


def choose(guess: NameGuess, duration_s: float, candidates: list[CatalogBook]) -> list[CatalogBook]:
    """The candidates that are this book, best first.

    Scores each edition by how much of its title and author the rip's name
    contains, then prefers editions whose runtime matches this recording.
    The name's parts are matched as a whole, so a swapped `Title - Author`
    guess scores the same as the right order.
    """
    name_words = _words(" ".join(p for p in (guess.terms, guess.title, guess.author) if p))
    narrator_words = _words(guess.narrator or "")
    scored: list[tuple[float, int, CatalogBook]] = []
    for order, book in enumerate(candidates):
        title_words = _words(_EDITION_SUFFIX_RE.sub("", book.title))
        if not title_words or (title_words & _DERIVATIVE_WORDS and not name_words & _DERIVATIVE_WORDS):
            continue
        title_score = len(title_words & name_words) / len(title_words)
        author_score = max((_overlap(_words(a), name_words) for a in book.authors), default=0.0)
        has_author_in_name = bool(guess.author) or author_score > 0
        if title_score < _MIN_TITLE_SCORE:
            continue
        if has_author_in_name and author_score < _MIN_AUTHOR_SCORE:
            continue
        if not has_author_in_name and title_score < 1.0:
            continue
        runtime_score = 1.0 if runtime_matches(book, duration_s) else 0.0
        narrator_score = max((_overlap(narrator_words, _words(n)) for n in book.narrators), default=0.0)
        total = 0.5 * title_score + 0.3 * author_score + 0.15 * runtime_score + 0.05 * narrator_score
        scored.append((total, order, book))
    scored.sort(key=lambda item: (-item[0], item[1]))
    return [book for _, _, book in scored]


def runtime_matches(book: CatalogBook, duration_s: float) -> bool:
    """True when the edition's runtime is within `RUNTIME_MATCH_RATIO` of this recording's."""
    if not book.runtime_s or duration_s <= 0:
        return False
    return abs(duration_s - book.runtime_s) / book.runtime_s <= RUNTIME_MATCH_RATIO


def align_chapters(catalog: CatalogChapters, duration_s: float) -> list[Chapter] | None:
    """The catalog's chapters on this recording's timeline, or None when it is a different recording.

    Tries the edition as released and with the Audible intro and/or outro
    cut, and keeps whichever lands within `CHAPTER_TOLERANCE_S` of the file's
    length. A cut intro shifts every chapter earlier by its length.

    Length alone cannot always tell a cut intro from a cut outro. When two
    readings fit within `_AMBIGUOUS_FIT_S` of each other, the one with the
    earlier chapter starts wins: a jump then lands a few seconds early,
    never after a chapter's first words.
    """
    variants = [(0.0, 0.0), (catalog.intro_s, 0.0), (catalog.intro_s, catalog.outro_s), (0.0, catalog.outro_s)]
    fits = [
        (abs(duration_s - (catalog.runtime_s - cut_intro - cut_outro)), cut_intro) for cut_intro, cut_outro in variants
    ]
    fits = [fit for fit in fits if fit[0] <= CHAPTER_TOLERANCE_S]
    if not fits:
        return None
    best_diff = min(diff for diff, _ in fits)
    shift = max(cut_intro for diff, cut_intro in fits if diff <= best_diff + _AMBIGUOUS_FIT_S)
    aligned: list[Chapter] = []
    for chapter in catalog.chapters:
        start = max(0.0, chapter.start_s - shift)
        end = min(duration_s, chapter.end_s - shift)
        if end - start >= 0.5:
            aligned.append(Chapter(title=chapter.title, start_s=start, end_s=end))
    if aligned:
        aligned[-1] = aligned[-1].model_copy(update={"end_s": duration_s})
    return aligned or None


def plain_text(markup: str) -> str:
    """Catalog descriptions arrive as HTML; keep the words and the paragraph breaks."""
    text = _PARAGRAPH_END_RE.sub("\n\n", markup)
    text = html.unescape(_TAG_RE.sub("", text))
    paragraphs = [" ".join(p.split()) for p in text.split("\n\n")]
    return "\n\n".join(p for p in paragraphs if p)


def _audible_book(product: dict[str, object]) -> CatalogBook:
    images = product.get("product_images")
    cover = None
    if isinstance(images, dict) and images:
        cover = str(images[max(images, key=lambda k: int(k) if str(k).isdigit() else 0)])
    series = product.get("series")
    first_series = series[0] if isinstance(series, list) and series and isinstance(series[0], dict) else {}
    runtime = product.get("runtime_length_min")
    summary = product.get("publisher_summary") or product.get("merchandising_summary")
    return CatalogBook(
        source="audible",
        asin=str(product.get("asin") or "") or None,
        title=str(product.get("title")).strip(),
        subtitle=str(product.get("subtitle") or "").strip() or None,
        authors=_names(product.get("authors")),
        narrators=_names(product.get("narrators")),
        year=str(product.get("release_date") or "")[:4] or None,
        runtime_s=float(str(runtime)) * 60 if runtime else None,
        cover_url=cover,
        description=plain_text(str(summary)) if summary else None,
        series=str(first_series.get("title") or "").strip() or None,
        series_position=str(first_series.get("sequence") or "").strip() or None,
        language=str(product.get("language") or "") or None,
    )


def _itunes_book(result: dict[str, object]) -> CatalogBook:
    artwork = str(result.get("artworkUrl100") or "")
    description = result.get("description")
    return CatalogBook(
        source="itunes",
        title=_EDITION_SUFFIX_RE.sub("", str(result.get("collectionName"))).strip(),
        authors=[str(result.get("artistName") or "").strip()] if result.get("artistName") else [],
        year=str(result.get("releaseDate") or "")[:4] or None,
        # iTunes serves any size up to the original from the same path.
        cover_url=artwork.replace("100x100bb", "3000x3000bb") if artwork else None,
        description=plain_text(str(description)) if description else None,
    )


def _names(raw: object) -> list[str]:
    if not isinstance(raw, list):
        return []
    return [str(item.get("name")).strip() for item in raw if isinstance(item, dict) and item.get("name")]


def _words(text: str) -> set[str]:
    folded = unicodedata.normalize("NFKD", text.casefold())
    return set(_WORD_RE.findall("".join(ch for ch in folded if not unicodedata.combining(ch))))


def _overlap(part: set[str], whole: set[str]) -> float:
    return len(part & whole) / len(part) if part else 0.0
