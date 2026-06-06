.PHONY: help install lint check test coverage docs docs-serve docs-build docs-screenshots build build-python dist-collect desktop-sync-frontend desktop-sync-version desktop-tauri desktop-tauri-dev desktop-tauri-build _wipe-tauri-userdata desktop-electron desktop-electron-dev desktop-electron-build _wipe-electron-userdata ui-static-sync clean

UV := $(shell command -v uv 2> /dev/null)

# Local-only secrets (Apple ID / app-specific password / team id for
# desktop notarization) live in a gitignored `.env` at the repo root — see
# `.env.example` and SIGNING.md. Sourced + exported here so the Tauri and
# Electron build recipes can notarize. Use plain `KEY=value` lines (make
# include syntax — no surrounding quotes). Absent `.env` is fine.
ifneq (,$(wildcard .env))
include .env
export APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID APPLE_SIGNING_IDENTITY APPLE_APP_SPECIFIC_PASSWORD
endif

help:
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@echo "  install      Install dependencies"
	@echo "  lint         Run ruff (with --fix) + mypy + pyright — local dev, mutates code"
	@echo "  check        Run ruff (no --fix) + mypy + pyright — CI-safe, never mutates"
	@echo "  test         Run pytest"
	@echo "  coverage     Run pytest with coverage"
	@echo "  docs-serve   Serve documentation locally with live reload"
	@echo "  docs-build   Build static documentation site to ./site"
	@echo "  docs-screenshots  Regenerate the TUI SVG screenshots in docs/screenshots/"
	@echo "  docs         Alias for docs-serve"
	@echo "  build        Build release versions of everything; collect into ./dist"
	@echo "  build-python Build Python wheel + sdist via uv build (-> ./dist)"
	@echo "  dist-collect Copy desktop build artifacts into ./dist for easy access"
	@echo "  desktop-tauri        Build the Tauri desktop app .app bundle (release)"
	@echo "  desktop-tauri-dev    Run Tauri dev (wipes user-data first for a fresh launch)"
	@echo "  desktop-tauri-build  Same as desktop-tauri (explicit name)"
	@echo "  desktop-electron     Build the Electron app .dmg under desktop/electron/dist/"
	@echo "  desktop-electron-dev Run Electron dev (wipes user-data first for a fresh launch)"
	@echo "  desktop-electron-build Same as desktop-electron (explicit name)"
	@echo "  clean        Remove caches and build artifacts"

install:
	@echo ">>> Installing dependencies"
	@$(UV) sync --all-extras --group dev

lint:
	@echo ">>> Running linter"
	@$(UV) run ruff format .
	@$(UV) run ruff check . --fix
	@echo ">>> Running type checkers"
	@$(UV) run mypy --explicit-package-bases src tests
	@$(UV) run pyright

check:
	@echo ">>> Running format check (no mutations)"
	@$(UV) run ruff format --check .
	@echo ">>> Running lint check (no mutations)"
	@$(UV) run ruff check .
	@echo ">>> Running type checkers"
	@$(UV) run mypy --explicit-package-bases src tests
	@$(UV) run pyright

test:
	@echo ">>> Running tests"
	@$(UV) run pytest -q

coverage:
	@echo ">>> Running tests with coverage"
	@$(UV) run coverage run -m pytest -q
	@$(UV) run coverage report
	@$(UV) run coverage xml

docs-serve:
	@echo ">>> Serving documentation at http://127.0.0.1:8000"
	@$(UV) run mkdocs serve

docs-build:
	@echo ">>> Building documentation site"
	@$(UV) run mkdocs build

docs-screenshots:
	@echo ">>> Regenerating TUI SVG screenshots"
	@$(UV) run python scripts/gen_screenshots.py

docs: docs-serve

# ---------------------------------------------------------------------------
# Desktop wrappers
#
# `desktop/react/` is the single shared frontend (React + Babel-standalone).
# Both Tauri and Electron wrappers load `desktop/react/index.html` in
# their native webview. The same files are also bundled into the
# Python wheel for `maneki ui` via `scripts/copy_ui_static.py`.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Release builds
#
# `make build` produces release versions of every shippable surface,
# then collects them all into ./dist for easy access:
#
#   ./dist/maneki-X.Y.Z-py3-none-any.whl       (Python wheel)
#   ./dist/maneki-X.Y.Z.tar.gz                  (Python sdist)
#   ./dist/Maneki-Tauri-X.Y.Z-aarch64.dmg       (Tauri DMG)
#   ./dist/Maneki-Tauri.app                     (Tauri app bundle)
#   ./dist/Maneki-Electron-X.Y.Z-arm64.dmg      (Electron DMG)
#
# Each sub-target can also run on its own — useful when you only need
# one artifact (e.g. CI publishing the Python wheel without touching
# the desktop apps). Sub-targets still write to their native build
# directories first; `dist-collect` is the single place that copies
# them all into ./dist.
# ---------------------------------------------------------------------------

# Read the current version from pyproject.toml so dist-collect copies
# ONLY the current build's artifacts and ignores stale older versions
# left behind in desktop/electron/dist (electron-builder doesn't prune
# its own output dir between builds, and old DMGs accumulate fast at
# ~95 MB each).
VERSION := $(shell grep '^version' pyproject.toml | sed 's/version = "\(.*\)"/\1/')

build: build-python desktop-tauri-build desktop-electron-build dist-collect
	@echo ">>> All release builds complete. Artifacts collected in ./dist (v$(VERSION)):"
	@ls -lh dist/ | tail -n +2

build-python: ui-static-sync
	@echo ">>> Building Python wheel + sdist into ./dist"
	@$(UV) build

ui-static-sync:
	@$(UV) run python scripts/copy_ui_static.py

# Copy desktop artifacts into ./dist alongside the Python wheel + sdist
# so a single directory has everything `make build` produced. Wipes
# stale prior-version desktop artifacts in ./dist so a clean re-run
# leaves only the current version. Safe to run on its own after a
# partial build (skips files that don't exist yet).
dist-collect:
	@echo ">>> Collecting v$(VERSION) artifacts into ./dist"
	@mkdir -p dist
	@# Wipe prior-version desktop artifacts so dist/ only holds the
	@# current build (Python wheel + sdist already overwrote in place
	@# via uv build).
	@find dist -maxdepth 1 \( -name 'Maneki-Tauri-*' -o -name 'Maneki-Electron-*' \) -exec rm -rf {} + 2>/dev/null || true
	@# Tauri DMG for current version (post-renamed by scripts/rename_tauri_artifacts.py)
	@cp -f desktop/tauri/src-tauri/target/release/bundle/dmg/Maneki-Tauri-$(VERSION)-*.dmg dist/ 2>/dev/null || true
	@# Tauri .app — preserve the bundle directory structure verbatim.
	@if [ -d desktop/tauri/src-tauri/target/release/bundle/macos/Maneki-Tauri.app ]; then \
		cp -R desktop/tauri/src-tauri/target/release/bundle/macos/Maneki-Tauri.app dist/; \
	fi
	@# Electron DMG for current version only.
	@cp -f desktop/electron/dist/Maneki-Electron-$(VERSION)-*.dmg dist/ 2>/dev/null || true
	@# Electron .app — produced under mac-arm64/ as Maneki.app, copy
	@# with the Electron tag in the name to disambiguate from the Tauri
	@# bundle that lives alongside it in dist/.
	@if [ -d desktop/electron/dist/mac-arm64/Maneki.app ]; then \
		cp -R desktop/electron/dist/mac-arm64/Maneki.app dist/Maneki-Electron.app; \
	fi

# The React frontend at `desktop/react/` owns its own CSS / JS — nothing
# to sync from the Python web/static tree any more. Target kept as a
# no-op so existing build chains (`desktop-tauri-build` etc.) and CI
# don't break on the dropped dependency; safe to remove once we're
# sure no external callers depend on it.
desktop-sync-frontend:
	@:

desktop-sync-version:
	@$(UV) run python scripts/sync_desktop_versions.py

desktop-tauri: desktop-tauri-build

# Wipe Tauri / WebKit user-data dirs so every dev launch starts fresh
# (no leftover localStorage, cookies, saved session, IndexedDB, or
# WKWebView cache). macOS-only paths; production builds keep their
# data per the OS conventions.
_wipe-tauri-userdata:
	@echo ">>> Wiping Tauri user-data dirs (com.winterop.maneki)"
	@rm -rf "$$HOME/Library/Application Support/com.winterop.maneki"
	@rm -rf "$$HOME/Library/Caches/com.winterop.maneki"
	@rm -rf "$$HOME/Library/WebKit/com.winterop.maneki"
	@rm -rf "$$HOME/Library/HTTPStorages/com.winterop.maneki"
	@rm -rf "$$HOME/Library/Cookies/com.winterop.maneki.binarycookies"
	@rm -rf "$$HOME/Library/Preferences/com.winterop.maneki.plist"

desktop-tauri-dev: desktop-sync-frontend _wipe-tauri-userdata
	@echo ">>> Tauri dev — opens window pointed at desktop/react/index.html"
	@cd desktop/tauri/src-tauri && cargo tauri dev

desktop-tauri-build: desktop-sync-frontend desktop-sync-version
	@echo ">>> Tauri release build — produces a .app under desktop/tauri/src-tauri/target/release/bundle/"
	@# Sign with a Developer ID if one is available, mirroring electron-builder's
	@# keychain auto-discovery so a local `make build` produces a signed Tauri app
	@# too (CI sets APPLE_SIGNING_IDENTITY from secrets; locally we sniff the
	@# login keychain). Honours a pre-set APPLE_SIGNING_IDENTITY; with no cert it
	@# falls back to an ad-hoc (unsigned) build. Notarization still needs the
	@# Apple ID env vars (see SIGNING.md) — unset here, same as Electron locally.
	@cd desktop/tauri/src-tauri && \
	  SIGN_ID="$${APPLE_SIGNING_IDENTITY:-$$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)}"; \
	  if [ -n "$$SIGN_ID" ]; then \
	    echo ">>> Signing as: $$SIGN_ID"; \
	    APPLE_SIGNING_IDENTITY="$$SIGN_ID" cargo tauri build; \
	  else \
	    echo ">>> No Developer ID in keychain — ad-hoc (unsigned) build"; \
	    cargo tauri build; \
	  fi
	@# Tauri 2 has no artifactName option, so post-rename the .dmg /
	@# .app so they're distinguishable from the Electron sibling
	@# ('Maneki_X.Y.Z_arch.dmg' -> 'Maneki-Tauri-X.Y.Z-arch.dmg').
	@$(UV) run python scripts/rename_tauri_artifacts.py

desktop-electron: desktop-electron-build

# Same idea as the Tauri wipe but for Electron's storage paths.
# Electron uses the appName (Maneki) for its user-data directory,
# with a fallback under the electron appId; clear both so a stale
# install can't survive.
_wipe-electron-userdata:
	@echo ">>> Wiping Electron user-data dirs"
	@rm -rf "$$HOME/Library/Application Support/Maneki"
	@rm -rf "$$HOME/Library/Application Support/maneki-desktop-electron"
	@rm -rf "$$HOME/Library/Application Support/com.winterop.maneki.electron"
	@rm -rf "$$HOME/Library/Caches/Maneki"
	@rm -rf "$$HOME/Library/Caches/com.winterop.maneki.electron"
	@rm -rf "$$HOME/Library/Preferences/com.winterop.maneki.electron.plist"
	@rm -rf "$$HOME/Library/Preferences/Maneki.plist"

desktop-electron-dev: desktop-sync-frontend _wipe-electron-userdata
	@echo ">>> Electron dev — opens window pointed at desktop/react/index.html"
	@cd desktop/electron && (test -d node_modules || bun install) && bun run start

desktop-electron-build: desktop-sync-frontend desktop-sync-version
	@echo ">>> Electron release build — produces a .dmg under desktop/electron/dist/"
	@cd desktop/electron && (test -d node_modules || bun install) && bun run build

clean:
	@echo ">>> Cleaning up"
	@find . -type f -name "*.pyc" -delete
	@find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
	@find . -type d -name ".pytest_cache" -exec rm -rf {} + 2>/dev/null || true
	@find . -type d -name ".ruff_cache" -exec rm -rf {} + 2>/dev/null || true
	@find . -type d -name ".mypy_cache" -exec rm -rf {} + 2>/dev/null || true
	@rm -rf .coverage htmlcov coverage.xml
	@rm -rf .pyright
	@rm -rf dist build *.egg-info
	@rm -rf site

.DEFAULT_GOAL := help
