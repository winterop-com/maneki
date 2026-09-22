"""System endpoints — `ping`, `getLicense`, `getMusicFolders`.

Three smallest endpoints in the spec. Their job in Phase 1 is to prove
the auth dependency, the response envelope, and routing all wire up.
"""

from __future__ import annotations

from fastapi import APIRouter, Request

from maneki.audio.serve.app import envelope
from maneki.books.subsonic import BOOKS_FOLDER_ID, BOOKS_FOLDER_NAME, MUSIC_FOLDER_ID

router = APIRouter()


@router.api_route("/ping", methods=["GET", "POST", "HEAD"])
@router.api_route("/ping.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def ping() -> dict:
    """Auth check — clients ping before doing anything else."""
    return envelope()


@router.api_route("/getLicense", methods=["GET", "POST", "HEAD"])
@router.api_route("/getLicense.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def get_license() -> dict:
    """Subsonic was paid software; clients still check this. Always return valid."""
    return envelope(
        "license",
        {
            "valid": True,
            "email": "self-hosted@maneki.audio.local",
            "licenseExpires": "2099-12-31T00:00:00.000Z",
        },
    )


@router.api_route("/getMusicFolders", methods=["GET", "POST", "HEAD"])
@router.api_route("/getMusicFolders.view", methods=["GET", "POST", "HEAD"], include_in_schema=False)
async def get_music_folders(request: Request) -> dict:
    """The library's folders: music, plus audiobooks when the root has them.

    Books are their own folder so a client can keep them apart from music,
    and every browse endpoint honours the `musicFolderId` that picks one.
    """
    folders = [{"id": MUSIC_FOLDER_ID, "name": "Music"}]
    books = getattr(request.app.state, "books", None)
    if books is not None and books.books:
        folders.append({"id": BOOKS_FOLDER_ID, "name": BOOKS_FOLDER_NAME})
    return envelope("musicFolders", {"musicFolder": folders})
