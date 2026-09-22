"""Copy the built clients into `src/maneki/` so the wheel bundles them.

TWO CLIENTS SHIP, AND BOTH ARE REACHABLE. `desktop/app/` is the current
client -- the one on the shared template, with music, radio, audiobooks and
the command palette -- and it is what `/` serves. `desktop/react/` is the
client it replaces, which still carries the video and YouTube screens the new
one has not grown yet, and it stays served at `/classic` until it has.

`maneki serve --ui` discovers them next to `maneki/`, which is the only copy
that exists in a PyPI/uv install; a dev checkout falls back to the `dist/`
trees in the repo.

Wired into `make build` so every wheel ships both. The destinations are
gitignored -- regenerated build artifacts, not hand-edited source trees.

Idempotent; safe to run repeatedly. Each destination is wiped first so a
removed source file does not linger in the bundle.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

#: Each (source, destination) the wheel carries. The first is what `/` serves.
BUNDLES: list[tuple[Path, Path]] = [
    (REPO_ROOT / "desktop" / "app" / "dist", REPO_ROOT / "src" / "maneki" / "_ui_static"),
    (REPO_ROOT / "desktop" / "react" / "dist", REPO_ROOT / "src" / "maneki" / "_ui_static_classic"),
]


def copy(source: Path, dest: Path, *, required: bool) -> None:
    """Replace `dest` with `source`, or say why it could not be."""
    if not (source / "index.html").is_file():
        if required:
            sys.exit(f"copy_ui_static: no built client at {source} (run `make app` first)")
        print(f">>> No build at {source.relative_to(REPO_ROOT)}; skipping")
        return
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(source, dest)
    print(f">>> Bundled {source.relative_to(REPO_ROOT)} -> {dest.relative_to(REPO_ROOT)}")


def main() -> None:
    """Run the copies; exit non-zero with a clear message when the main client is missing."""
    for index, (source, dest) in enumerate(BUNDLES):
        copy(source, dest, required=index == 0)


if __name__ == "__main__":
    main()
