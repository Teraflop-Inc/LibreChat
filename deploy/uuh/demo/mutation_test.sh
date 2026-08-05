#!/usr/bin/env bash
# Mutation test for validate_query_set.py (CWORK-1108).
#
# A validator that only catches "file missing" is worthless — a green run has
# to MEAN something. This deliberately breaks the query set one rule at a time
# and asserts the validator rejects each mutation. If a mutation passes, that
# rule is not actually enforced.
#
# Run:  bash deploy/uuh/demo/mutation_test.sh
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$DIR/query-set.yaml"
VALIDATOR="$DIR/validate_query_set.py"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0

run_validator() { uv run --quiet --with pyyaml "$VALIDATOR" "$1" 2>&1; }

# expect_reject <name> <mutated-file> <substring the error must mention>
#
# Guards against no-op mutations. A mutation that silently fails to apply
# (e.g. BSD sed does NOT support GNU's `0,/re/` form and quietly changes
# nothing) leaves an unmutated file, which the validator rightly accepts —
# indistinguishable from an unenforced rule. Assert the file actually changed
# before drawing any conclusion from the result.
expect_reject() {
  local name="$1" file="$2" want="$3" out
  if cmp -s "$SRC" "$file"; then
    echo "  ✗ $name — MUTATION DID NOT APPLY (file identical to source); test is lying"
    fail=$((fail + 1))
    return
  fi
  out="$(run_validator "$file")"
  if [ $? -eq 0 ]; then
    echo "  ✗ $name — validator ACCEPTED a broken query set (rule not enforced)"
    fail=$((fail + 1))
  elif ! grep -qi -- "$want" <<<"$out"; then
    echo "  ✗ $name — rejected, but not for the expected reason (wanted /$want/)"
    echo "$out" | sed 's/^/       /'
    fail=$((fail + 1))
  else
    echo "  ✓ $name"
    pass=$((pass + 1))
  fi
}

echo "baseline (unmutated must PASS):"
if run_validator "$SRC" >/dev/null; then
  echo "  ✓ baseline passes"
  pass=$((pass + 1))
else
  echo "  ✗ baseline FAILS — fix the query set before trusting mutations"
  exit 1
fi

echo
echo "mutations (each must be REJECTED):"

# 1. Dangling document reference — the likeliest real-world breakage.
sed 's/      - PP-MWHP-IMAGING/      - PP-DOES-NOT-EXIST/' "$SRC" >"$TMP/dangling.yaml"
expect_reject "dangling source_documents reference" "$TMP/dangling.yaml" "not declared"

# 2. Hero query paraphrased away from the ticket's wording.
sed 's/Given this denied line item, draft a response to the insurer arguing/Write an appeal letter explaining why/' "$SRC" >"$TMP/paraphrase.yaml"
expect_reject "hero question paraphrased" "$TMP/paraphrase.yaml" "verbatim"

# 3. Hero loses its clinical note — breaks "citing the clinical record".
sed '/^      - CN-04417   # the clinical record it must cite$/d' "$SRC" >"$TMP/noclinical.yaml"
expect_reject "hero missing clinical_note" "$TMP/noclinical.yaml" "clinical_note"

# 4. Guardrail question removed.
sed 's/^    expects_refusal: true$/    expects_refusal: false/' "$SRC" >"$TMP/noguard.yaml"
expect_reject "no refusal/guardrail question" "$TMP/noguard.yaml" "expects_refusal"

# 5. A question missing its expected answer.
python3 - "$SRC" "$TMP/noanswer.yaml" <<'PY'
import re, sys
src, dst = sys.argv[1], sys.argv[2]
text = open(src).read()
# drop Q3's expected_answer block
text = re.sub(
    r"    expected_answer: >-\n      Four items.*?\n\n", "\n", text, flags=re.S
)
open(dst, "w").write(text)
PY
expect_reject "question missing expected_answer" "$TMP/noanswer.yaml" "expected_answer"

# 6. Two heroes. NOTE: awk, not `sed '0,/re/'` — that form is a GNU extension
# and is a silent no-op on the BSD sed shipped with macOS.
awk '!done && /^    hero: false$/ { sub(/false/, "true"); done=1 } { print }' \
  "$SRC" >"$TMP/twoheroes.yaml"
expect_reject "more than one hero" "$TMP/twoheroes.yaml" "exactly 1 hero"

echo
echo "──────────────────────────────"
echo "passed: $pass   failed: $fail"
[ "$fail" -eq 0 ] || exit 1
