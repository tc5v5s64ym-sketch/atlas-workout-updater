#!/bin/sh
# Harden the Playwright install path against the apt/Azure-mirror failure (#1715).
#
# Failure mode (classified firsthand 2026-11-11, recurring 2026-11-13..15):
# the hosted E2E job fails at "Install Playwright (browser + system deps)"
# because apt cannot resolve azure.archive.ubuntu.com
# ("Temporary failure resolving 'azure.archive.ubuntu.com'"), so no spec runs.
# The apt half of `playwright install --with-deps` / `install-deps` depends on
# the Azure Ubuntu mirror, which periodically stalls or fails.
#
# Mechanism (builder's choice; prior art named on #1715):
#   1. Before each install attempt, check whether the Azure mirror resolves.
#      If it does not, and the canonical archive.ubuntu.com does, rewrite the
#      apt sources away from the Azure mirror (same packages, different host).
#      When the Azure mirror is healthy, the sources are left untouched.
#   2. Retry the install itself (up to PLAYWRIGHT_INSTALL_ATTEMPTS, default 3)
#      with a backoff, so a transient DNS blip does not fail the job outright.
#
# The gate is not weakened: this script exits non-zero unless the install
# itself succeeds, and it changes nothing about which browsers or system
# deps are installed. Usage:
#   scripts/ci/playwright-install.sh install --with-deps chromium
#   scripts/ci/playwright-install.sh install-deps chromium
#
# APT_SOURCES_ROOT is overridable for local verification of the rewrite logic
# (default /etc/apt). PLAYWRIGHT_INSTALL_ATTEMPTS and
# PLAYWRIGHT_INSTALL_RETRY_DELAY_SECONDS are overridable for the same reason.
set -u

AZURE_MIRROR="azure.archive.ubuntu.com"
FALLBACK_MIRROR="archive.ubuntu.com"
APT_SOURCES_ROOT="${APT_SOURCES_ROOT:-/etc/apt}"
MAX_ATTEMPTS="${PLAYWRIGHT_INSTALL_ATTEMPTS:-3}"
RETRY_DELAY_SECONDS="${PLAYWRIGHT_INSTALL_RETRY_DELAY_SECONDS:-30}"

if [ "$#" -eq 0 ]; then
  echo "#1715 usage: playwright-install.sh <playwright install args...>" >&2
  exit 2
fi

if command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
else
  SUDO=""
fi

log() {
  echo "#1715 playwright-install: $*"
}

host_resolves() {
  # No getent (non-glibc host): assume usable; the retry loop is the backstop.
  if ! command -v getent >/dev/null 2>&1; then
    return 0
  fi
  timeout 10 getent hosts "$1" >/dev/null 2>&1
}

rewrite_mirror() {
  # Rewrite every apt source file that mentions the Azure mirror. Missing
  # paths are fine (a runner may carry sources.list, ubuntu.sources, or both).
  files="$(grep -rl "azure\\.archive\\.ubuntu\\.com" \
    "$APT_SOURCES_ROOT/sources.list" \
    "$APT_SOURCES_ROOT/sources.list.d" 2>/dev/null || true)"
  if [ -z "$files" ]; then
    log "no apt source file mentions $AZURE_MIRROR; nothing to rewrite"
    return 0
  fi
  # shellcheck disable=SC2086
  for file in $files; do
    log "rewriting $AZURE_MIRROR -> $FALLBACK_MIRROR in $file"
    # shellcheck disable=SC2086
    if ! $SUDO sed -i "s/azure\\.archive\\.ubuntu\\.com/archive.ubuntu.com/g" "$file"; then
      log "WARNING: could not rewrite $file; continuing with the retry loop"
      return 1
    fi
  done
  if grep -r "azure\\.archive\\.ubuntu\\.com" \
      "$APT_SOURCES_ROOT/sources.list" \
      "$APT_SOURCES_ROOT/sources.list.d" 2>/dev/null; then
    log "WARNING: $AZURE_MIRROR still present in apt sources after rewrite"
    return 1
  fi
  log "apt sources now point at $FALLBACK_MIRROR"
  return 0
}

ensure_mirror() {
  if host_resolves "$AZURE_MIRROR"; then
    log "$AZURE_MIRROR resolves; apt sources unchanged"
    return 0
  fi
  log "$AZURE_MIRROR does not resolve"
  if ! host_resolves "$FALLBACK_MIRROR"; then
    log "WARNING: $FALLBACK_MIRROR does not resolve either; leaving apt sources alone"
    return 0
  fi
  rewrite_mirror || true
}

attempt=1
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  ensure_mirror
  log "playwright $* (attempt $attempt/$MAX_ATTEMPTS)"
  if npx playwright "$@"; then
    log "playwright $* succeeded on attempt $attempt"
    exit 0
  fi
  log "playwright $* failed on attempt $attempt/$MAX_ATTEMPTS"
  attempt=$((attempt + 1))
  if [ "$attempt" -le "$MAX_ATTEMPTS" ]; then
    log "retrying in ${RETRY_DELAY_SECONDS}s"
    sleep "$RETRY_DELAY_SECONDS"
  fi
done

log "playwright $* failed after $MAX_ATTEMPTS attempts"
exit 1
