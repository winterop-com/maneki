"""Post-rename Tauri release artifacts so they're distinguishable from Electron.

Tauri 2's `tauri.conf.json` has no `artifactName` option (unlike
`electron-builder`'s `package.json["build"]["artifactName"]`), so we
can't ask the bundler to embed "Tauri" in the filename directly.
Instead this script runs after `cargo tauri build` and renames each
artifact to `Maneki-Tauri-X.Y.Z-arch.<ext>`: `.app` / `.dmg` on macOS,
`.deb` / `.rpm` / `.AppImage` on Linux, `.msi` / `.exe` on Windows.

Idempotent: re-runs after partial builds skip already-renamed files.
Best-effort: missing files / unsupported names are logged but don't
fail the build.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
BUNDLE_ROOT = REPO_ROOT / "desktop" / "tauri" / "src-tauri" / "target" / "release" / "bundle"
ARTIFACT_SUFFIXES = (".dmg", ".deb", ".rpm", ".AppImage", ".msi", ".exe")


def rename_one(path: Path) -> Path | None:
    """Rename a Tauri artifact to embed `Tauri` in the filename.

    Examples:
      Maneki_0.12.3_aarch64.dmg     -> Maneki-Tauri-0.12.3-aarch64.dmg
      Maneki.app                    -> Maneki-Tauri.app
      Maneki_0.12.3_amd64.deb       -> Maneki-Tauri-0.12.3-amd64.deb
      Maneki-0.12.3-1.x86_64.rpm    -> Maneki-Tauri-0.12.3-1.x86_64.rpm
      Maneki_0.12.3_amd64.AppImage  -> Maneki-Tauri-0.12.3-amd64.AppImage

    Returns the new Path on success, None if the file was already
    renamed or didn't match a known shape.
    """
    name = path.name
    if name.startswith("Maneki-Tauri"):
        return None  # already renamed
    # `Maneki_<version>_<arch>.<ext>`: Tauri's default shape for every
    # bundle except rpm. The Windows ones carry a suffix in the arch slot
    # (`x64-setup.exe`, `x64_en-US.msi`), which is kept verbatim.
    m = re.fullmatch(r"Maneki_(\d+(?:\.\d+)*)_([\w-]+)\.(dmg|app\.tar\.gz|deb|AppImage|msi|exe)", name)
    # `Maneki-<version>-<release>.<arch>.rpm`: rpm has its own convention.
    m_rpm = re.fullmatch(r"Maneki-(\d+(?:\.\d+)*)-(\d+)\.(\w+)\.rpm", name)
    if m:
        version, arch, ext = m.group(1), m.group(2), m.group(3)
        new = path.with_name(f"Maneki-Tauri-{version}-{arch}.{ext}")
    elif m_rpm:
        version, release, arch = m_rpm.group(1), m_rpm.group(2), m_rpm.group(3)
        new = path.with_name(f"Maneki-Tauri-{version}-{release}.{arch}.rpm")
    elif name == "Maneki.app":
        new = path.with_name("Maneki-Tauri.app")
    else:
        return None
    if new.exists():
        # An older renamed copy exists — replace it so re-runs keep
        # the latest build's bytes.
        if new.is_dir():
            import shutil

            shutil.rmtree(new)
        else:
            new.unlink()
    path.rename(new)
    return new


def main() -> None:
    """Walk the bundle dir and rename every recognisable artifact."""
    if not BUNDLE_ROOT.exists():
        print(f"(no bundle directory at {BUNDLE_ROOT}; skipping)")
        sys.exit(0)
    renamed: list[Path] = []
    for entry in sorted(BUNDLE_ROOT.rglob("*")):
        if entry.suffix in ARTIFACT_SUFFIXES or entry.name.endswith(".app") or entry.name.endswith(".app.tar.gz"):
            new = rename_one(entry)
            if new is not None:
                renamed.append(new)
    if renamed:
        print(">>> Renamed Tauri artifacts:")
        for path in renamed:
            print(f"    {path.relative_to(REPO_ROOT)}")
    else:
        print(">>> No Tauri artifacts to rename (already done or none built).")


if __name__ == "__main__":
    main()
