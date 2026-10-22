#!/usr/bin/env bash
# Install Ubuntu packages on a CI runner without letting a slow mirror eat the job.
#
# The Azure Ubuntu mirror sometimes trickles: on 2026-10-07 it stalled three jobs
# (CI, the PyPI release and the desktop release) until their job timeouts, mid-way
# through downloading packages nobody asked for. So each attempt gets a bounded
# time, a killed attempt has dpkg repaired before the next one, and after three
# attempts the step fails in minutes rather than in twenty.
#
# Retrying the same mirror was not enough: on 2026-10-22 it trickled through all
# three attempts on three runs out of four. A trickle is not an error, so apt never
# moves on to the other entries in its mirrorlist by itself. After a failed attempt
# apt is pointed at archive.ubuntu.com alone.
#
# Usage: scripts/apt_install.sh [--no-install-recommends] PACKAGE...
set -euo pipefail

ATTEMPT_SECONDS=240
ATTEMPTS=3
FALLBACK_MIRROR=http://archive.ubuntu.com/ubuntu/

use_fallback_mirror() {
    # GitHub's Ubuntu images read their mirrors from a mirrorlist file; other
    # images name the Azure mirror in the sources themselves.
    if [ -f /etc/apt/apt-mirrors.txt ]; then
        echo "$FALLBACK_MIRROR" | sudo tee /etc/apt/apt-mirrors.txt >/dev/null
    fi
    sudo sed -i "s#http://azure.archive.ubuntu.com/ubuntu/\?#${FALLBACK_MIRROR}#g" \
        /etc/apt/sources.list /etc/apt/sources.list.d/* 2>/dev/null || true
    echo "::notice::apt now uses ${FALLBACK_MIRROR}"
}

for attempt in $(seq 1 "$ATTEMPTS"); do
    if timeout "$ATTEMPT_SECONDS" bash -c '
        sudo apt-get update -o Acquire::Retries=3 &&
        sudo apt-get install -y -o Acquire::Retries=3 "$@"
    ' _ "$@"; then
        exit 0
    fi
    echo "::warning::apt attempt ${attempt}/${ATTEMPTS} failed or ran past ${ATTEMPT_SECONDS}s"
    # A killed install can leave dpkg half-configured and the lock held.
    sudo dpkg --configure -a || true
    if [ "$attempt" -eq 1 ]; then
        use_fallback_mirror
    fi
done

echo "::error::apt could not install: $*"
exit 1
