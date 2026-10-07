"""Copy the built client into `src/maneki/` so the wheel bundles it.

`desktop/app/` is the client, and it is what `/` serves. `maneki serve --ui`
discovers it next to `maneki/`, which is the only copy that exists in a
PyPI/uv install; a dev checkout falls back to `desktop/app/dist/`.

Wired into `make build` so every wheel ships it. The destination is
gitignored -- a regenerated build artifact, not a hand-edited source tree.

Idempotent; safe to run repeatedly. The destination is wiped first so a
removed source file does not linger in the bundle.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

SOURCE = REPO_ROOT / "desktop" / "app" / "dist"
DEST = REPO_ROOT / "src" / "maneki" / "_ui_static"


def main() -> None:
    """Replace the bundled copy with the build; exit non-zero when there is no build."""
    if not (SOURCE / "index.html").is_file():
        sys.exit(f"copy_ui_static: no built client at {SOURCE} (run `make app` first)")
    if DEST.exists():
        shutil.rmtree(DEST)
    shutil.copytree(SOURCE, DEST)
    print(f">>> Bundled {SOURCE.relative_to(REPO_ROOT)} -> {DEST.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
