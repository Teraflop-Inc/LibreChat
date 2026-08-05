# Chunking sweep — CWORK-1109

CWORK-1109 left chunking deliberately unprescribed: *"Pick the strategy
empirically from measured retrieval performance — bitter-lesson framing, don't
hand-design what you can determine from results."*

So it was measured. Reproduce with `bash deploy/uuh/demo/chunk_sweep.sh`.
Each row rebuilds the vector store from scratch and re-runs the CWORK-1108
questions at k=8 over 22 documents.

| chunk_size | overlap | chunks | Q1 hero | Q2 aggregate | Q3 policy | Q4 guardrail | passed |
|-----------|---------|--------|---------|--------------|-----------|--------------|--------|
| 1500 | 100 | 29 | FAIL | PASS | PASS | FAIL | 2/4 |
| 800 | 150 | 47 | FAIL | PASS | PASS | FAIL | 2/4 |
| 400 | 100 | 92 | FAIL | PASS | PASS | FAIL | 2/4 |
| 250 | 50 | 162 | FAIL | PASS | PASS | FAIL | 2/4 |

(Q4 shows FAIL here because the sweep predates its retrieval exemption — see
the last section. It was never a real failure.)

## Result: chunking is not the lever. Recommend 1500 / 100.

A 5.6× swing in chunk count (29 → 162) changed **nothing**. Every
configuration retrieves the same documents for every question.

The ticket warned that "a chunk that severs a procedure code from its
justification retrieves as nonsense" — a real hazard, but not one this corpus
hits. These documents are small (most are a single chunk even at 1500) and each
is internally coherent, so there is little for a splitter to sever.

**Recommendation: keep `CHUNK_SIZE=1500`, `CHUNK_OVERLAP=100`.** Not because it
scored best — nothing scored best — but because at identical retrieval it
produces 29 chunks instead of 162: 5.6× fewer embedding calls, 5.6× less vector
storage, lower query latency. Spend nothing to gain nothing.

⚠️ This conclusion is scoped to 22 short, internally coherent documents.
Ingesting real UUH material — long discharge summaries, multi-page operative
reports, scanned faxes — changes the premise, and the sweep should be re-run.
The script exists for exactly that.

## The actual finding: single-shot retrieval cannot answer the hero query

Chasing the chunking dead-end surfaced something more important.

**`CN-04417` never retrieves for Q1, at any chunk size.** The cause is neither
chunking nor the document — it is a vocabulary gap between question and
evidence:

- The hero question is **insurance-domain**: "insurer", "medically necessary",
  "denied line item".
- The clinical note is **clinical-domain**: "radiculopathy", "dorsiflexion",
  "foot drop", "straight leg raise".

A single embedding does not bridge those. Probing confirms the document is
perfectly retrievable with vocabulary matched to it:

| probe | top results |
|---|---|
| `foot drop dorsiflexion weakness lumbar radiculopathy` | **CN-04417**, TR-04417, CN-04421 |
| `new progressive neurological deficit refractory to conservative therapy` | PP-MWHP-IMAGING, **CN-04417**, TR-04417 |
| the hero question as written | DN-04421, DN-04420, DN-04417 … (no CN-04417) |

Adding the claim number to the question barely helps — embeddings do not do
exact identifier matching. Adding the **procedure** ("MRI lumbar spine CPT
72148") promotes the correct denial to first place, which is the useful lever.

### Consequence for CWORK-1110

The hero query needs **multi-step retrieval**, not one shot. That is precisely
what the `agents` + `file_search` path does natively — and CWORK-1107 already
established that path is the only one that touches pgvector at all.

Measured both ways at 1500/100:

```
SINGLE-SHOT            2/3 scored   (Q1 fails: missing CN-04417, PP-MWHP-IMAGING)
AGENTIC (3 probes)     3/3 scored   (Q1 passes: all targets retrieved)
```

The probes are recorded as `retrieval_probes` on Q1 in `query-set.yaml`, so
CWORK-1110 inherits them rather than rediscovering this.

**Do not "fix" this by rewording the hero question.** Its wording is verbatim
from CWORK-1108 and enforced by `validate_query_set.py`. The finding is that
the demo must run on the agents path — not that the question is wrong.

## Near-miss distractors are working

CWORK-1109 required distractors so "retrieval has to actually discriminate
rather than match the only document mentioning the procedure." They earned
their place immediately: **DN-04421 outranked the true hero denial DN-04417**
on the unqualified hero query.

DN-04421 is a deliberate near-miss — same denial code (CO-50), same anatomy
(lumbar spine), same "not deemed a medical necessity" phrasing; different
procedure, patient, and payer. Without it the hero query would have appeared to
work by default, because DN-04417 would have been the only plausible match. It
is why this weakness surfaced before the demo rather than during it.

## Q4 is exempt from retrieval scoring

Q4's success is the model **refusing** — a generation-layer property. There is
no HbA1c anywhere in the corpus, so retrieval failing to surface one is correct
behaviour, not a defect. Scoring it on whether `CN-04417` comes back is a
category error. Verified in actual chat at CWORK-1110, the only layer where
refusal is observable.
