#!/usr/bin/env bash
# Chunking sweep for the UUH corpus (CWORK-1109).
#
# The ticket leaves chunking deliberately unprescribed: "Pick the strategy
# empirically from measured retrieval performance — bitter-lesson framing,
# don't hand-design what you can determine from results."
#
# So this measures rather than argues. For each configuration it rebuilds the
# vector store from scratch and re-runs the CWORK-1108 questions.
#
# The /embed endpoint takes no per-request chunk override — CHUNK_SIZE and
# CHUNK_OVERLAP are read from the environment by rag_api at startup — so each
# configuration requires a container restart. That is why this is slow.
#
# Hypothesis under test: the hero query fails to retrieve CN-04417 because the
# question's vocabulary is insurance-domain ("insurer", "medically necessary")
# while the evidence is clinical-domain ("radiculopathy", "dorsiflexion").
# Smaller chunks should isolate the note's Assessment paragraph, which is the
# part phrased closest to the question.
#
# Run:  bash deploy/uuh/demo/chunk_sweep.sh
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel)"
ENV_FILE="$ROOT/.env"
HARNESS="$ROOT/deploy/uuh/demo/rag_harness.py"
COMPOSE="docker compose -f $ROOT/docker-compose.yml -f $ROOT/deploy/uuh/docker-compose.uuh.yml"
RESULTS="$ROOT/deploy/uuh/demo/chunk_sweep_results.md"

# size:overlap
CONFIGS=("1500:100" "800:150" "400:100" "250:50")

restore() {
  sed -i '' "s/^CHUNK_SIZE=.*/CHUNK_SIZE=$ORIG_SIZE/" "$ENV_FILE"
  sed -i '' "s/^CHUNK_OVERLAP=.*/CHUNK_OVERLAP=$ORIG_OVERLAP/" "$ENV_FILE"
}
ORIG_SIZE=$(grep -E '^CHUNK_SIZE=' "$ENV_FILE" | cut -d= -f2)
ORIG_OVERLAP=$(grep -E '^CHUNK_OVERLAP=' "$ENV_FILE" | cut -d= -f2)
trap restore EXIT

{
  echo "# Chunking sweep — CWORK-1109"
  echo
  echo "Measured, not hand-designed, per the ticket's bitter-lesson framing."
  echo "Each row rebuilds the vector store from scratch and re-runs the"
  echo "CWORK-1108 questions at k=8 over 22 documents."
  echo
  echo "| chunk_size | overlap | chunks | Q1 hero | Q2 aggregate | Q3 policy | Q4 guardrail | passed |"
  echo "|-----------|---------|--------|---------|--------------|-----------|--------------|--------|"
} >"$RESULTS"

for cfg in "${CONFIGS[@]}"; do
  size="${cfg%%:*}"; overlap="${cfg##*:}"
  echo
  echo "════ CHUNK_SIZE=$size CHUNK_OVERLAP=$overlap ════"

  sed -i '' "s/^CHUNK_SIZE=.*/CHUNK_SIZE=$size/" "$ENV_FILE"
  sed -i '' "s/^CHUNK_OVERLAP=.*/CHUNK_OVERLAP=$overlap/" "$ENV_FILE"

  $COMPOSE up -d --force-recreate rag_api >/dev/null 2>&1
  # Wait for the sidecar to answer rather than guessing at a sleep duration.
  for _ in $(seq 1 30); do
    if docker exec LibreChat node -e "fetch('http://rag_api:8000/health').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
      break
    fi
    sleep 2
  done

  uv run --quiet --with pyyaml,requests "$HARNESS" load >/dev/null 2>&1
  chunks=$(docker exec vectordb psql -U myuser -d mydatabase -tAc \
    "SELECT count(*) FROM langchain_pg_embedding;" 2>/dev/null | tr -d ' ')

  out="$(uv run --quiet --with pyyaml,requests "$HARNESS" test 8 2>&1)"
  echo "$out"

  cell() { grep -q "PASS  $1" <<<"$out" && echo "PASS" || echo "FAIL"; }
  passed=$(grep -oE '^[0-9]+/[0-9]+ questions' <<<"$out" | cut -d/ -f1)

  printf '| %s | %s | %s | %s | %s | %s | %s | %s/4 |\n' \
    "$size" "$overlap" "$chunks" \
    "$(cell Q1-appeal-draft)" "$(cell Q2-denial-pattern)" \
    "$(cell Q3-policy-lookup)" "$(cell Q4-guardrail-absent-fact)" \
    "${passed:-0}" >>"$RESULTS"
done

echo
echo "════ results ════"
cat "$RESULTS"
