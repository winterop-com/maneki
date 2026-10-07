#!/usr/bin/env bash
# Install Ubuntu packages on a CI runner without letting a slow mirror eat the job.
#
# The Azure Ubuntu mirror sometimes trickles: on 2026-10-07 it stalled three jobs
# (CI, the PyPI release and the desktop release) until their job timeouts, mid-way
# through downloading packages nobody asked for. So each attempt gets a bounded
# time, a killed attempt has dpkg repaired before the next one, and after three
# attempts the step fails in minutes rather than in twenty.
#
# Usage: scripts/apt_install.sh [--no-install-recommends] PACKAGE...
set -euo pipefail

ATTEMPT_SECONDS=240
ATTEMPTS=3

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
done

echo "::error::apt could not install: $*"
exit 1
