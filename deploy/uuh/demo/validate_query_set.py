#!/usr/bin/env python3
"""Validate the UUH demo query set (CWORK-1108).

The ticket states plainly: "This IS the test suite." Formal retrieval
evaluation was deprioritised, so the contract that replaces it is this file —
pre-canned answers we know are correct, structurally enforced.

This does NOT score retrieval quality. It enforces that the query set is
internally consistent and complete enough to hand to CWORK-1109 (corpus
generation) without ambiguity. Catching a dangling document reference here
costs seconds; catching it after 20 documents are generated costs a rewrite.

Run:  uv run --with pyyaml deploy/uuh/demo/validate_query_set.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import yaml

QUERY_SET = Path(__file__).parent / "query-set.yaml"

# Verbatim from CWORK-1108. The hero query is the demo's centrepiece and is
# quoted in the ticket; if someone paraphrases it, the demo drifts from what
# was agreed with Alex. Compared whitespace-normalised, not character-exact.
HERO_TEXT = (
    "Given this denied line item, draft a response to the insurer arguing "
    "the disputed service was medically necessary, citing the clinical record."
)

REQUIRED_QUESTION_FIELDS = (
    "id",
    "question",
    "expected_answer",
    "source_documents",
    "why_this_question",
)
REQUIRED_DOC_FIELDS = ("id", "type", "summary")


def norm(s: str) -> str:
    """Collapse whitespace so YAML line-wrapping doesn't cause false failures."""
    return " ".join(s.split())


def validate(data: dict) -> list[str]:
    errors: list[str] = []

    questions = data.get("questions") or []
    documents = data.get("documents") or []

    # ── Ticket: "3-4 questions written" ──────────────────────────────────
    # Lower bound is the real constraint: "A single question looks rehearsed
    # to an audience."
    if not 3 <= len(questions) <= 4:
        errors.append(f"expected 3-4 questions, found {len(questions)}")

    # ── Exactly one hero, matching the ticket verbatim ───────────────────
    heroes = [q for q in questions if q.get("hero")]
    if len(heroes) != 1:
        errors.append(f"expected exactly 1 hero question, found {len(heroes)}")
    elif norm(heroes[0].get("question", "")) != norm(HERO_TEXT):
        errors.append(
            "hero question does not match CWORK-1108 verbatim.\n"
            f"    ticket: {norm(HERO_TEXT)}\n"
            f"    found:  {norm(heroes[0].get('question', ''))}"
        )

    # ── Every question fully specified ───────────────────────────────────
    seen_q: set[str] = set()
    for i, q in enumerate(questions):
        qid = q.get("id", f"<question {i}>")
        for field in REQUIRED_QUESTION_FIELDS:
            if not q.get(field):
                errors.append(f"{qid}: missing required field '{field}'")
        if qid in seen_q:
            errors.append(f"duplicate question id '{qid}'")
        seen_q.add(qid)

    # ── Every document fully specified ───────────────────────────────────
    seen_d: set[str] = set()
    for i, d in enumerate(documents):
        did = d.get("id", f"<document {i}>")
        for field in REQUIRED_DOC_FIELDS:
            if not d.get(field):
                errors.append(f"{did}: missing required field '{field}'")
        if did in seen_d:
            errors.append(f"duplicate document id '{did}'")
        seen_d.add(did)

    # ── Referential integrity: the actual handoff contract to CWORK-1109 ──
    # A question pointing at a document nobody will generate is the single
    # most likely way this demo quietly breaks.
    for q in questions:
        qid = q.get("id", "<unknown>")
        for ref in q.get("source_documents") or []:
            if ref not in seen_d:
                errors.append(
                    f"{qid}: source_documents references '{ref}', "
                    "which is not declared in documents[]"
                )

    # ── The hero needs a clinical record to cite ─────────────────────────
    # "citing the clinical record" is not decoration — it forces the corpus
    # to carry linked document types, which neither CWORK-1108 nor -1109
    # states outright. Enforce it so the constraint cannot be lost.
    if len(heroes) == 1:
        by_id = {d.get("id"): d for d in documents}
        hero_types = {
            by_id[r]["type"]
            for r in (heroes[0].get("source_documents") or [])
            if r in by_id and by_id[r].get("type")
        }
        for needed in ("denial_notice", "clinical_note"):
            if needed not in hero_types:
                errors.append(
                    f"hero question must cite a '{needed}' "
                    f"(the ticket's wording requires it); got types {sorted(hero_types)}"
                )

    # ── At least one guardrail question ──────────────────────────────────
    # For a health system, demonstrating the system declines to invent an
    # answer is worth more than one more correct answer.
    if not any(q.get("expects_refusal") for q in questions):
        errors.append(
            "no question with expects_refusal: true — the demo should prove "
            "the system declines to answer what the corpus does not contain"
        )

    return errors


def main() -> int:
    # Optional path arg so the validator can be pointed at a mutated copy to
    # confirm it actually has teeth (see mutation_test.sh).
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else QUERY_SET

    if not target.exists():
        print(f"FAIL: {target} does not exist")
        return 1

    data = yaml.safe_load(target.read_text()) or {}
    errors = validate(data)

    n_q = len(data.get("questions") or [])
    n_d = len(data.get("documents") or [])

    if errors:
        print(f"FAIL: {len(errors)} problem(s) in {target.name}\n")
        for e in errors:
            print(f"  - {e}")
        return 1

    print(f"PASS: {target.name} valid — {n_q} questions, {n_d} documents declared")
    return 0


if __name__ == "__main__":
    sys.exit(main())
