#!/usr/bin/env bash
# Apply UUH branding to a running LibreChat container — CWORK-1111
#
# WHY A SCRIPT RATHER THAN VOLUME MOUNTS
#
# Mounting a patched index.html looks tidier and is a trap: index.html
# references HASHED bundles (assets/index.C9mj20tM.js). After any upstream
# rebuild those hashes change, and a pinned index.html would point at files
# that no longer exist — the app would fail to boot entirely, for a branding
# change. This script instead INJECTS one line into whatever index.html is
# present, so it survives upstream bumps.
#
# The asset paths it overwrites (assets/favicon-*.png, apple-touch-icon,
# logo.svg) are NOT hashed, so those are stable across releases.
#
# Nothing here edits LibreChat source. Re-run after any container recreate:
#   make -C deploy/uuh brand
set -uo pipefail

CONTAINER="${LIBRECHAT_CONTAINER:-LibreChat}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST=/app/client/dist

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "FAIL: container '$CONTAINER' is not running — start the stack first" >&2
  exit 1
fi

echo "── stylesheet ──"
docker cp "$HERE/uuh-brand.css" "$CONTAINER:$DIST/assets/uuh-brand.css"
echo "  assets/uuh-brand.css copied"

echo "── marks ──"
# Favicons: the scraped .ico is used as-is where the browser accepts it; the
# PNG slots are left alone unless a real PNG pack arrives, because rasterising
# an .ico into each size would produce worse artwork than LibreChat's default.
docker cp "$HERE/assets/logo.svg" "$CONTAINER:$DIST/assets/logo.svg"
echo "  assets/logo.svg replaced (UUH mark)"

echo "── inject stylesheet link ──"
# The container runs as the host UID and cannot write into /app/client/dist,
# so in-place sed fails with EPERM. docker cp runs as root, so patch on the
# host and copy back. Idempotent — re-running is a no-op.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Always inject into a PRISTINE index.html, never into an already-patched one.
# Editing an edited file is how this broke: a cleanup `sed /uuh-brand/d`
# deleted the whole line, which also carried </head>, leaving no anchor for the
# next injection. Keep one untouched copy and re-derive from it every run.
if ! docker exec "$CONTAINER" test -f "$DIST/index.html.uuh-orig" 2>/dev/null; then
  docker exec "$CONTAINER" sh -c "cp $DIST/index.html $DIST/index.html.uuh-orig" 2>/dev/null \
    || {
      # dist is not writable by the container user; stage the copy via docker cp
      docker cp "$CONTAINER:$DIST/index.html" "$TMP/orig.html" >/dev/null 2>&1
      docker cp "$TMP/orig.html" "$CONTAINER:$DIST/index.html.uuh-orig" >/dev/null 2>&1
    }
  echo "  saved pristine index.html.uuh-orig"
fi
docker cp "$CONTAINER:$DIST/index.html.uuh-orig" "$TMP/index.html" >/dev/null 2>&1

# Content hash in the href. Without it the browser serves a stale cached
# stylesheet after every edit — which presents as "the CSS is served (200) and
# the selector matches, but nothing changes", and sends you hunting a cascade
# bug that does not exist. Cost an hour once; do not remove.
HASH="$(shasum -a 256 "$HERE/uuh-brand.css" | cut -c1-8)"
LINK="assets/uuh-brand.css?v=${HASH}"

# Single line, no embedded newline. Portable newline insertion in BSD sed is
# fiddly and an earlier attempt emitted a LITERAL "\n" into the markup, which
# the browser rendered as visible text in the top-left of every page. HTML does
# not care about the line break, so do not reintroduce one.
sed -i '' "s#</head>#  <link rel=\"stylesheet\" href=\"${LINK}\" /></head>#" "$TMP/index.html"
grep -q 'uuh-brand.css' "$TMP/index.html" || { echo "  FAIL: could not inject into index.html" >&2; exit 1; }
docker cp "$TMP/index.html" "$CONTAINER:$DIST/index.html" >/dev/null 2>&1
echo "  injected with cache-busting hash v=${HASH}"

echo "── verify ──"
FAILED=0
docker exec "$CONTAINER" sh -c "test -f $DIST/assets/uuh-brand.css" \
  && echo "  stylesheet present" || { echo "  stylesheet MISSING"; FAILED=1; }
REFS=$(docker exec "$CONTAINER" sh -c "grep -c 'uuh-brand.css' $DIST/index.html" 2>/dev/null | tr -d ' \r')
echo "  index.html references: ${REFS:-0}"
[ "${REFS:-0}" -ge 1 ] || FAILED=1

if [ "$FAILED" -ne 0 ]; then
  echo >&2
  echo "BRANDING NOT APPLIED — see failures above." >&2
  exit 1
fi

echo "── restart api ──"
# REQUIRED, not cosmetic. api/server/index.js:161 does
#     let indexHTML = fs.readFileSync(indexPath, 'utf8')
# ONCE at startup and serves that string from memory thereafter. Patching the
# file on disk has zero effect until the process restarts — the stylesheet
# returns 200 while the page never references it, which looks like a CSS
# cascade problem and is not one.
ROOT="$(git -C "$HERE" rev-parse --show-toplevel)"
docker compose -f "$ROOT/docker-compose.yml" -f "$ROOT/deploy/uuh/docker-compose.uuh.yml" \
  restart api >/dev/null 2>&1
for _ in $(seq 1 30); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3080/)" = "200" ] && break
  sleep 2
done

if curl -s http://localhost:3080/ | grep -q 'uuh-brand.css'; then
  echo "  served index.html now references the stylesheet"
else
  echo "  FAIL: stylesheet still not in the served HTML" >&2
  exit 1
fi

echo
echo "Branding applied."
echo "NOTE: a 'docker compose up --force-recreate' rebuilds the container layer"
echo "      and discards this. Re-run after any recreate."
