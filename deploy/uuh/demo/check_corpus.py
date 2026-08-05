#!/usr/bin/env python3
"""Check the corpus against the CWORK-1108 contract, before embedding.

Retrieval failures are expensive to diagnose — you cannot tell a chunking
problem from a corpus that simply never contained the fact. This runs first
and separates those two cases: if the fact is not in the document, that is a
corpus bug, not a retrieval bug.

It enforces the constraints that are load-bearing but invisible:

  * Q2's expected answer asserts CO-197 appears 5 times and CO-50 three. A
    different mix silently invalidates the answer with nothing appearing broken.
  * Q4's guardrail depends on the ABSENCE of lab values in CN-04417. If a lab
    value creeps in, the guardrail question becomes answerable and stops
    testing refusal.
  * Every document is synthetic and says so.

Run:  uv run --with pyyaml deploy/uuh/demo/check_corpus.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml

HERE = Path(__file__).parent
CORPUS = HERE / "corpus"
QUERY_SET = HERE / "query-set.yaml"

# Q2's expected answer hard-codes these. Kept here so a mismatch is a test
# failure rather than a wrong demo answer.
EXPECTED_CODE_COUNTS = {"CO-197": 5, "CO-50": 3}

SYNTHETIC_MARKER = "SYNTHETIC DEMONSTRATION DATA"

# Patterns that would mean a lab value leaked into the hero clinical note.
LAB_VALUE_PATTERNS = [
    r"\bHbA1c\b",
    r"\bA1c\b",
    r"\d+\.?\d*\s*%",          # any percentage
    r"\d+\.?\d*\s*mg/dL",
    r"\d+\.?\d*\s*mmol/L",
]


def check() -> list[str]:
    errors: list[str] = []

    if not CORPUS.exists():
        return [f"corpus directory {CORPUS} does not exist"]

    files = {p.stem: p for p in CORPUS.glob("*.md")}
    spec = yaml.safe_load(QUERY_SET.read_text())
    declared = {d["id"]: d for d in spec.get("documents") or []}

    # ── Manifest and corpus must agree in both directions ────────────────
    for did in declared:
        if did not in files:
            errors.append(f"{did}: declared in query-set.yaml but no corpus/{did}.md")
    for fid in files:
        if fid not in declared:
            errors.append(f"{fid}: corpus/{fid}.md exists but is not declared in query-set.yaml")

    texts = {stem: p.read_text() for stem, p in files.items()}

    # ── Everything is synthetic and says so ──────────────────────────────
    for stem, text in sorted(texts.items()):
        if SYNTHETIC_MARKER not in text:
            errors.append(f"{stem}: missing '{SYNTHETIC_MARKER}' banner")

    # ── Denial-code distribution (Q2's expected answer depends on it) ─────
    for code, want in EXPECTED_CODE_COUNTS.items():
        # Count documents whose denial code IS this code, not every mention —
        # policies and other notices reference codes in passing.
        got = sum(
            1
            for stem, t in texts.items()
            if stem.startswith("DN-") and re.search(rf"\*\*Denial code: {re.escape(code)}\*\*", t)
        )
        if got != want:
            errors.append(
                f"denial code {code}: found {got} denial notice(s), "
                f"Q2's expected answer asserts {want}"
            )

    # ── Q4 guardrail depends on ABSENCE of lab values in the hero note ───
    hero_note = texts.get("CN-04417", "")
    for pat in LAB_VALUE_PATTERNS:
        m = re.search(pat, hero_note, re.I)
        if m:
            errors.append(
                f"CN-04417 contains '{m.group(0)}' — Q4's guardrail requires the "
                "hero clinical note to hold NO laboratory values, or the question "
                "becomes answerable and stops testing refusal"
            )

    # ── Facts each question's must_include depends on must EXIST ─────────
    # Distinguishes "retrieval missed it" from "it was never written down".
    for q in spec.get("questions") or []:
        if q.get("expects_refusal"):
            continue  # a refusal's must_include describes the answer, not the corpus
        sources = " ".join(texts.get(s, "") for s in (q.get("source_documents") or []))
        for fact in q.get("must_include") or []:
            if fact.lower() not in sources.lower():
                errors.append(
                    f"{q['id']}: must_include '{fact}' appears in NO source document "
                    "— unanswerable regardless of retrieval quality"
                )

    return errors


def main() -> int:
    errors = check()
    n = len(list(CORPUS.glob("*.md"))) if CORPUS.exists() else 0

    if errors:
        print(f"FAIL: {len(errors)} problem(s) in corpus\n")
        for e in errors:
            print(f"  - {e}")
        return 1

    print(f"PASS: corpus consistent — {n} documents, "
          f"denial codes match Q2, guardrail intact")
    return 0


if __name__ == "__main__":
    sys.exit(main())
