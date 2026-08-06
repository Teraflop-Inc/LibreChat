#!/usr/bin/env bash
# Verify the OpenShift values overlay — CWORK-1115
#
# Proves four things, none by assertion:
#   1. The STOCK LibreChat image crashloops under an arbitrary UID (the
#      OpenShift restricted-v2 shape). This is the negative control — if it
#      ever starts passing, upstream fixed the image and this overlay's volume
#      section can shrink.
#   2. The same image under the same UID RUNS once the three write paths are
#      backed by writable volumes.
#   3. The chart rendered with values-openshift.yaml contains no hardcoded
#      runAsUser or fsGroup — the two keys restricted-v2 rejects at admission.
#   4. It still asserts the SCC-positive settings that must survive.
#
# Requires docker. Nothing is left running. No cluster needed.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
VALUES="${REPO}/deploy/uuh/helm/values-openshift.yaml"
IMG="registry.librechat.ai/danny-avila/librechat-dev:latest"
UID_GID="1000670000:0"          # random high UID + root group == restricted-v2
FAILED=0

step() { printf '\n\033[1m== %s\033[0m\n' "$1" >&2; }
pass() { printf '  \033[32m✅ %s\033[0m\n' "$1" >&2; }
fail() { printf '  \033[31m❌ %s\033[0m\n' "$1" >&2; FAILED=1; }

cleanup() { docker rm -f lc-scc-neg lc-scc-pos >/dev/null 2>&1; rm -f "${MINENV:-}"; }
trap cleanup EXIT

step "1/4  Write paths under an arbitrary UID (stock image)"
OUT=$(docker run --rm --user "$UID_GID" --entrypoint sh "$IMG" -c '
for d in /app /app/uploads /app/client/public/images; do
  if touch "$d/.w" 2>/dev/null; then echo "WRITABLE $d"; rm -f "$d/.w"; else echo "READONLY $d"; fi
done' 2>&1)
echo "$OUT" | sed 's/^/     /' >&2
if echo "$OUT" | grep -q READONLY; then
  pass "confirmed read-only under arbitrary UID (image uses chown node:node, not chgrp 0 + chmod g=u)"
else
  fail "expected read-only paths; upstream may have fixed the image — re-check the overlay"
fi

step "2/4  NEGATIVE CONTROL — stock image must crashloop"
# A minimal synthetic .env is required, and the reason is worth recording: with
# NO .env the container dies earlier still, at module load in api/db/index.js,
# and never reaches the logger. That is a different failure, and treating it as
# the SCC failure would make this control pass for the wrong reason. The env
# below is deliberately fake — no secrets, and the Mongo host is unreachable on
# purpose, since we only need the process to get as far as opening its log file.
MINENV="$(mktemp)"
printf 'MONGO_URI=mongodb://unreachable.invalid:27017/LibreChat\nHOST=0.0.0.0\nPORT=3080\n' > "$MINENV"
docker rm -f lc-scc-neg >/dev/null 2>&1
docker run -d --name lc-scc-neg --user "$UID_GID" \
  --security-opt no-new-privileges --cap-drop ALL \
  -v "$MINENV:/app/.env:ro" \
  -e HOST=0.0.0.0 -e PORT=3080 "$IMG" >/dev/null 2>&1
# Poll rather than sleep a fixed interval: on a loaded machine a fixed 22s was
# occasionally short enough to read the logs before the crash landed, which made
# this control fail intermittently. A flaky control is worse than no control.
for _ in $(seq 1 40); do
  docker logs lc-scc-neg 2>&1 | grep -q "EACCES" && break
  [ "$(docker inspect -f '{{.State.Status}}' lc-scc-neg 2>/dev/null)" = "exited" ] && break
  sleep 2
done
NEG_STATUS=$(docker inspect -f '{{.State.Status}}' lc-scc-neg 2>/dev/null)
if [ "$NEG_STATUS" = "exited" ] && docker logs lc-scc-neg 2>&1 | grep -q "EACCES"; then
  pass "crashlooped with EACCES, as expected — the failure is real"
  docker logs lc-scc-neg 2>&1 | grep -m1 "EACCES" | sed 's/^/     /' >&2
else
  fail "expected an EACCES crash; got status=$NEG_STATUS"
fi

step "3/4  POSITIVE — same UID, writable volumes at the three paths"
docker rm -f lc-scc-pos >/dev/null 2>&1
docker run -d --name lc-scc-pos --user "$UID_GID" \
  --security-opt no-new-privileges --cap-drop ALL \
  --tmpfs /app/logs:rw,mode=1777 \
  --tmpfs /app/uploads:rw,mode=1777 \
  --tmpfs /app/client/public/images:rw,mode=1777 \
  -v "$MINENV:/app/.env:ro" \
  -e HOST=0.0.0.0 -e PORT=3080 "$IMG" >/dev/null 2>&1
# Wait until the process has clearly got past startup — either it settled
# (running) or it exited on the unreachable database. Either way it is far
# enough along for "did it hit EACCES?" to be a meaningful question.
for _ in $(seq 1 40); do
  docker logs lc-scc-pos 2>&1 | grep -qiE "EACCES|MongoDB|listening|ENOTFOUND|querySrv" && break
  [ "$(docker inspect -f '{{.State.Status}}' lc-scc-pos 2>/dev/null)" = "exited" ] && break
  sleep 2
done
# No datastores here, so the process may exit on a DB connect rather than a
# permission error. The claim under test is narrow: no EACCES.
if docker logs lc-scc-pos 2>&1 | grep -q "EACCES"; then
  fail "still hitting EACCES with volumes mounted"
  docker logs lc-scc-pos 2>&1 | grep -m2 "EACCES" | sed 's/^/     /' >&2
else
  pass "no permission errors — the volume fix resolves the SCC failure"
fi

step "4/4  Rendered chart must not carry UIDs restricted-v2 rejects"
docker run --rm -v "$REPO:/apps" -w /apps alpine/helm:latest \
  dependency build ./helm/librechat >/dev/null 2>&1
RENDERED=$(docker run --rm -v "$REPO:/apps" -w /apps alpine/helm:latest \
  template librechat ./helm/librechat -f "deploy/uuh/helm/values-openshift.yaml" 2>/dev/null)

if [ -z "$RENDERED" ]; then
  fail "chart failed to render"
else
  printf '%s' "$RENDERED" | python3 -c '
import sys
txt=sys.stdin.read()
dep=[d for d in txt.split("---") if "kind: Deployment" in d and "langfuse" not in d]
d=dep[0] if dep else ""
checks=[
 ("no hardcoded runAsUser (Helm MERGES maps — needs null, not {})", "runAsUser" not in d),
 ("no hardcoded fsGroup",                     "fsGroup" not in d),
 ("runAsNonRoot: true retained",              "runAsNonRoot: true" in d),
 ("allowPrivilegeEscalation: false",          "allowPrivilegeEscalation: false" in d),
 ("all capabilities dropped",                 "drop:" in d and "- ALL" in d),
 ("/app/logs mounted",                        "/app/logs" in d),
 ("/app/uploads mounted",                     "/app/uploads" in d),
 ("/app/client/public/images mounted",        "/app/client/public/images" in d),
]
bad=0
for n,ok in checks:
    print(("  \033[32m✅ %s\033[0m" if ok else "  \033[31m❌ %s\033[0m") % n)
    bad += 0 if ok else 1
sys.exit(1 if bad else 0)
' >&2 || FAILED=1
fi

if [ "$FAILED" -eq 0 ]; then
  printf '\n\033[32m✅ all checks passed\033[0m\n' >&2
else
  printf '\n\033[31m❌ failures above\033[0m\n' >&2
fi
exit "$FAILED"
