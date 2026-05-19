"""Minimal MediaKit-native video FastAPI app.

Endpoints (v0, base layer only):
- GET /capabilities       server identity + audio/video presence flags
- GET /api/videos         flat list of video files under <root>/videos/
- GET /api/videos/{id}/stream    range-supported raw file serve (no transcode)

No HLS, no transcoding, no UI yet. Those land as layers on top of this base.
"""

from mediakit.video.serve.app import create_app

__all__ = ["create_app"]
