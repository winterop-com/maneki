"""Propagate `pyproject.toml`'s version to the desktop wrappers.

The Python package is the single source of truth for the project's
version. The user-visible bundle metadata (Tauri `tauri.conf.json` and
Electron `package.json`) needs to mirror it so the .app / .dmg
artifacts report a consistent number — those values flow into
Info.plist's `CFBundleShortVersionString`, the DMG filename
(`Maneki-Tauri-X.Y.Z-…dmg` / `Maneki-Electron-X.Y.Z-…dmg`), and
the macOS About window.

We also bump `desktop/tauri/src-tauri/Cargo.toml`'s `[package].version`
so the build log reads the real version (`Compiling maneki-desktop
vX.Y.Z`) instead of a frozen placeholder. The original reason for *not*
doing this was lock drift — bumping Cargo.toml without refreshing
`Cargo.lock` left a stale `maneki-desktop` entry, and CI never runs
`cargo` to fix it. We sidestep that by updating the matching entry in
`Cargo.lock` in the same pass, so the manifest and lock stay in lockstep
with no follow-up chore PR.

Run via `make desktop-sync-version` (auto-invoked by the
desktop-{tauri,electron}-build targets). Idempotent — safe to run
multiple times; only writes files where the version has actually
changed.
"""

from __future__ import annotations

import json
import re
import sys
import tomllib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def read_pyproject_version() -> str:
    """Pull the `[project].version` string out of pyproject.toml."""
    with (REPO_ROOT / "pyproject.toml").open("rb") as f:
        data = tomllib.load(f)
    version = data["project"]["version"]
    if not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+(?:[\w.+-]*)?", version):
        raise SystemExit(f"unexpected version shape: {version!r}")
    return version


def update_json_version(path: Path, version: str) -> bool:
    """Update top-level `version` field in a JSON file. Returns True if changed."""
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("version") == version:
        return False
    data["version"] = version
    # Preserve indent style — tauri.conf.json + package.json both use 2 spaces.
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return True


# NOTE: index.html no longer carries a `<meta name=mk-version>` or `?v=`
# cache-busters — the SPA is a Vite build (content-hashed filenames) and the
# version label compiles in from a Vite define that reads pyproject.toml
# directly (see desktop/react/vite.config.js). So this script no longer
# touches index.html.


# The `[package].version` line is the first `version = "..."` in Cargo.toml
# (the `[package]` table is at the top), so a single first-match replace
# targets it without touching dependency pins.
_CARGO_PKG_VERSION_RE = re.compile(r'(?m)^version = "[^"]*"')
# The workspace crate's own entry in Cargo.lock: `name` then `version` on
# consecutive lines (cargo's deterministic ordering).
_CARGO_LOCK_DESKTOP_RE = re.compile(r'(name = "maneki-desktop"\nversion = ")[^"]*(")')


def update_cargo_version(path: Path, version: str) -> bool:
    """Update `[package].version` in the Tauri crate's Cargo.toml. Returns True if changed."""
    text = path.read_text(encoding="utf-8")
    new_text, n = _CARGO_PKG_VERSION_RE.subn(f'version = "{version}"', text, count=1)
    if n == 0:
        raise SystemExit(f"[package].version not found in {path}")
    if new_text == text:
        return False
    path.write_text(new_text, encoding="utf-8")
    return True


def update_cargo_lock_version(path: Path, version: str) -> bool:
    """Keep the `maneki-desktop` entry in Cargo.lock in lockstep. Returns True if changed."""
    text = path.read_text(encoding="utf-8")
    new_text, n = _CARGO_LOCK_DESKTOP_RE.subn(rf"\g<1>{version}\g<2>", text)
    if n == 0:
        raise SystemExit(f"maneki-desktop entry not found in {path}")
    if new_text == text:
        return False
    path.write_text(new_text, encoding="utf-8")
    return True


def main() -> None:
    """CLI entrypoint: sync user-visible desktop versions to pyproject.toml."""
    version = read_pyproject_version()
    print(f">>> Syncing desktop versions to {version}")
    targets: list[tuple[Path, str]] = []
    json_paths = [
        REPO_ROOT / "desktop" / "tauri" / "src-tauri" / "tauri.conf.json",
        REPO_ROOT / "desktop" / "electron" / "package.json",
    ]
    for path in json_paths:
        if update_json_version(path, version):
            targets.append((path, "updated"))
        else:
            targets.append((path, "already in sync"))
    src_tauri = REPO_ROOT / "desktop" / "tauri" / "src-tauri"
    cargo_toml = src_tauri / "Cargo.toml"
    targets.append((cargo_toml, "updated" if update_cargo_version(cargo_toml, version) else "already in sync"))
    cargo_lock = src_tauri / "Cargo.lock"
    targets.append((cargo_lock, "updated" if update_cargo_lock_version(cargo_lock, version) else "already in sync"))
    for path, status in targets:
        print(f"    {status:18} {path.relative_to(REPO_ROOT)}")
    sys.exit(0)


if __name__ == "__main__":
    main()
