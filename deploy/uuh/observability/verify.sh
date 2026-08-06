#!/usr/bin/env bash
# Verify the UUH observability collector — CWORK-1119
#
# Proves three things, none of them by assertion:
#   1. Phoenix runs under an arbitrary high UID with GID 0 (the OpenShift
#      restricted-v2 shape) once PHOENIX_WORKING_DIR points somewhere writable.
#   2. A Langfuse-flavoured span — what LibreChat actually emits — arrives in
#      Phoenix as a first-class LLM span with correct token accounting, after
#      passing through otelcol.yaml's transform.
#   3. The two export pipelines are independent: Phoenix still receives even
#      with the Langfuse backend unreachable.
#
# Requires docker and uv. Leaves nothing running.
set -uo pipefail

CFG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/otelcol.yaml"
PHX=uuh-obs-phoenix
COL=uuh-obs-collector
PHX_PORT=16007
COL_PORT=14318
WORK="$(mktemp -d)"
FAILED=0

cleanup() {
  docker rm -f "$PHX" "$COL" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

step() { printf '\n\033[1m== %s\033[0m\n' "$1" >&2; }
pass() { printf '  \033[32m✅ %s\033[0m\n' "$1" >&2; }
fail() { printf '  \033[31m❌ %s\033[0m\n' "$1" >&2; FAILED=1; }

step "1/4  Phoenix under an arbitrary OpenShift UID"
docker rm -f "$PHX" >/dev/null 2>&1
# 1000670000:0 is the shape OpenShift restricted-v2 assigns: random high UID,
# GID 0, no privilege escalation, all capabilities dropped.
docker run -d --name "$PHX" \
  --user 1000670000:0 \
  --security-opt no-new-privileges --cap-drop ALL \
  -e PHOENIX_WORKING_DIR=/tmp/phoenix \
  -e PHOENIX_TELEMETRY_ENABLED=false \
  -e PHOENIX_ALLOW_EXTERNAL_RESOURCES=false \
  -e PHOENIX_ALLOWED_SANDBOX_PROVIDERS=NONE \
  -p "${PHX_PORT}:6006" \
  arizephoenix/phoenix:latest >/dev/null 2>&1

for _ in $(seq 1 30); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 \
      "http://localhost:${PHX_PORT}/healthz" 2>/dev/null)" = "200" ] && break
  [ "$(docker inspect -f '{{.State.Status}}' "$PHX" 2>/dev/null)" = "exited" ] && break
  sleep 5
done

if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 \
      "http://localhost:${PHX_PORT}/healthz" 2>/dev/null)" = "200" ]; then
  ident=$(docker exec "$PHX" /usr/bin/python3.13 -c \
    "import os;print(f'uid={os.getuid()} gid={os.getgid()} HOME={os.environ.get(\"HOME\")}')" 2>/dev/null)
  pass "healthy — $ident"
else
  fail "Phoenix did not become healthy"
  docker logs "$PHX" 2>&1 | tail -5 >&2
  exit 1
fi

step "2/4  Collector with the shipped otelcol.yaml"
docker rm -f "$COL" >/dev/null 2>&1
# The Langfuse endpoint is deliberately unreachable: this doubles as the
# pipeline-independence test in step 4.
docker run -d --name "$COL" -p "${COL_PORT}:4318" \
  -e UUH_OTEL_RECEIVER_ENDPOINT=0.0.0.0:4318 \
  -e UUH_OTEL_MEMORY_LIMIT_MIB=256 \
  -e UUH_OTEL_MEMORY_SPIKE_LIMIT_MIB=64 \
  -e UUH_LANGFUSE_BASE_URL=http://langfuse-not-running.invalid:3000 \
  -e UUH_LANGFUSE_AUTH_HEADER='Basic dGVzdDp0ZXN0' \
  -e UUH_PHOENIX_ENDPOINT="http://host.docker.internal:${PHX_PORT}" \
  -e UUH_PHOENIX_TLS_INSECURE=true \
  -v "${CFG}:/etc/otelcol-contrib/config.yaml:ro" \
  otel/opentelemetry-collector-contrib:latest >/dev/null 2>&1
sleep 12

if [ "$(docker inspect -f '{{.State.Status}}' "$COL" 2>/dev/null)" = "running" ]; then
  pass "collector running, config accepted"
else
  fail "collector failed to start"
  docker logs "$COL" 2>&1 | tail -10 >&2
  exit 1
fi

step "3/4  Send a Langfuse-flavoured span (what LibreChat emits)"
cat >"${WORK}/send.py" <<'PY'
import os
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.resources import Resource
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

endpoint = f"http://localhost:{os.environ['COL_PORT']}/api/public/otel/v1/traces"
provider = TracerProvider(resource=Resource.create({"service.name": "librechat"}))
provider.add_span_processor(SimpleSpanProcessor(OTLPSpanExporter(endpoint=endpoint)))
trace.set_tracer_provider(provider)

with trace.get_tracer("cwork-1119").start_as_current_span("uuh-verify-generation") as s:
    s.set_attribute("langfuse.observation.type", "generation")
    s.set_attribute("langfuse.observation.input", '[{"role":"user","content":"What is CO-197?"}]')
    s.set_attribute("langfuse.observation.output", '{"content":"CO-197 is a denial code."}')
    s.set_attribute("langfuse.observation.model.name", "claude-sonnet-5")
    s.set_attribute("langfuse.observation.usage_details", '{"input":42,"output":17,"total":59}')
provider.shutdown()
PY

COL_PORT="$COL_PORT" uv run --quiet \
  --with opentelemetry-sdk --with opentelemetry-exporter-otlp-proto-http \
  python "${WORK}/send.py" >/dev/null 2>&1 \
  && pass "span sent to collector" || fail "failed to send span"
sleep 8

step "4/4  Assert Phoenix read it as a first-class LLM span"
RESULT=$(curl -s -X POST "http://localhost:${PHX_PORT}/graphql" \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ projects(first:10) { edges { node { spans(first:20) { edges { node { name spanKind tokenCountTotal tokenCountPrompt tokenCountCompletion } } } } } } }"}' 2>/dev/null)

echo "$RESULT" | python3 -c '
import json, sys
rows = [e["node"]
        for p in json.load(sys.stdin)["data"]["projects"]["edges"]
        for e in p["node"]["spans"]["edges"]
        if e["node"]["name"] == "uuh-verify-generation"]
if not rows:
    print("NOTFOUND"); raise SystemExit
r = rows[0]
ok = (r["spanKind"] == "llm" and r["tokenCountTotal"] == 59
      and r["tokenCountPrompt"] == 42 and r["tokenCountCompletion"] == 17)
print(("OK " if ok else "BAD ") + f'"'"'kind={r["spanKind"]} total={r["tokenCountTotal"]} '"'"'
      f'"'"'prompt={r["tokenCountPrompt"]} completion={r["tokenCountCompletion"]}'"'"')
' > "${WORK}/assert" 2>/dev/null

VERDICT=$(cat "${WORK}/assert" 2>/dev/null)
case "$VERDICT" in
  OK*)       pass "transform verified — ${VERDICT#OK }" ;;
  NOTFOUND)  fail "span never reached Phoenix" ;;
  *)         fail "wrong attributes — ${VERDICT#BAD }" ;;
esac

if docker logs "$COL" 2>&1 | grep -qiE "langfuse-not-running|no such host|connection refused"; then
  pass "Langfuse leg failed as designed, Phoenix leg unaffected — pipelines independent"
else
  printf '  \033[33m⚠️  could not confirm the Langfuse leg errored\033[0m\n' >&2
fi

if [ "$FAILED" -eq 0 ]; then
  printf '\n\033[32m✅ all checks passed\033[0m\n' >&2
else
  printf '\n\033[31m❌ failures above\033[0m\n' >&2
fi
exit "$FAILED"
