# Demo verification — CWORK-1110

All four CWORK-1108 questions answered correctly through the LibreChat UI, by a
LibreChat **Agent** using **File Search** (true RAG), on `gpt-4o`.

Built inside LibreChat rather than as a standalone script, per the ticket: the
pitch is "your chat platform doing your work," and a standalone RAG script would
prove retrieval works but not that LibreChat does.

## The agent

| | |
|---|---|
| Name | UUH Denial Appeals |
| Id | `agent_lNe6s9TDnVIrjoB5bNSkt` |
| Model | `gpt-4o` |
| Tools | `["file_search"]` |
| Documents | **22 attached — all of them.** Verification below was run at 20; the last two were blocked by the FerretDB bloat bug documented further down, now resolved |
| Resend Files | on — retrieval fires every message, which is what we want when the corpus *is* the agent's knowledge |

`gpt-4o` was chosen over the `gpt-3.5-turbo` default deliberately: the hero query
needs multi-step retrieval plus synthesis, and the guardrail needs a model that
reliably declines rather than confabulates.

## Before / after — the demo's strongest visual

The same hero question, with and without the agent.

**Without** (plain `openAI` endpoint, no corpus) — a generic template:

> Re: Appeal of Denied Claim – Claim Number: **[Claim Number]**
> … the **[Name of Service]** was recommended … patient presented with **[Patient's Condition]** …

Zero grounding. None of Q1's required facts: no CPT 72148, no CO-50, no eight
weeks, no foot drop.

**With the agent** — it identified the correct claim *unprompted* out of twelve
denials, then argued from the payer's own published criteria:

> The denied line item pertains to claim number **UUH-2026-04417** … MRI lumbar
> spine without contrast (**CPT 72148**) deemed not medically necessary … denial
> code is **CO-50**.
>
> **Progressive Neurological Deficit (Policy MWHP-IMG-004, section 2(b))** — …
> objective motor deficit development, characterized as **foot drop** … left
> ankle dorsiflexion strength graded at **4/5** …
>
> **Failed Conservative Therapy** — completed an **eight-week course** … physical
> therapy 2026-01-06 to 2026-02-27, and NSAID therapy … since 2026-01-06.

It cited `CN-04417` and `PP-MWHP-IMAGING` by name.

## Results

| Question | Result | Evidence |
|---|---|---|
| **Q1 hero** — draft an appeal | **PASS** | CPT 72148 ✓ · CO-50 ✓ · eight-week ✓ · foot drop ✓ · medically necessary ✓ · CO-197 absent ✓ · did not cite the near-miss DN-04421 ✓ |
| **Q2** — most common denial reason | **PASS** | CO-197, **5 claims**, and it enumerated exactly the five authored (04418, 04419, 04422, 04424, 04427) |
| **Q3** — payer appeal requirements | **PASS** | All four required items ✓ · 90 days ✓ · named source `PP-MWHP-APPEALS` ✓ · did **not** state 180 days ✓ |
| **Q4 guardrail** — absent HbA1c | **PASS** | Refused, identified `CN-04417` as the relevant record, stated no lab results exist, **fabricated nothing** |

### Q1's "eight weeks" — a checker artifact, not a content failure

The model wrote "eight-**week** course". A literal substring check for "eight
**weeks**" reports a miss. The fact is present and correct; the assertion was
too literal. Any future automated check should normalise hyphens and whitespace
before matching — a general fix, not a special case for this answer.

### Q3's conflation test passed by a better route than planned

`PP-WSHA-PRIORAUTH` (the rival payer's 180-day window) could not be attached —
see the FerretDB bloat finding below — so the planned distractor was absent. But File Search still
retrieved Wasatch **denial notices**, which carry "180 days from this notice per
Section 7.3", and the model still answered **90 days** for Mountain West. The
rival figure was in its context and it did not conflate. Stronger evidence than
the planned test, obtained by accident.

## ⚠️ BLOCKER FOR CWORK-1112: FerretDB accumulates per-document bloat until the document bricks

> **Correction.** This section originally called it "a 20-document cap" and said
> the stock-Mongo A/B had not been run. Both were wrong. It is **not a cap** —
> 20 is just where this particular agent happened to cross a threshold. Root
> cause is below; all 22 documents are now attached.

**Root cause: documentdb stores a physical BSON row that grows monotonically
with each update and never reclaims space, while the logical document stays
small. Once documentdb's post-update size computation crosses 16 MB,
`findAndModify` on that document fails permanently.**

The evidence chain, each step measured:

| observation | value |
|---|---|
| logical document (read back over the wire) | **9,252 bytes** |
| physical row (`pg_column_size(document)`) | **189,725 bytes** — 20× |
| size documentdb computes for the update | **32,517,923 bytes** — 3,500× |

Discriminating tests, all against the same FerretDB instance:

- Trimming `versions[]` from 22 entries to 3 shrank the logical document
  39 KB → 9 KB. The failure was **unchanged** — so it is not document size.
- `VACUUM FULL` on the underlying table: **no effect** — so it is not MVCC bloat.
- A **fresh** document of identical shape in the **same** collection: **works**.
- A **copy** of the failing document in a different collection: **works**.
- A trivial `findAndModify` on the failing document: **works** — only the
  update path that grows the row fails.
- Removing `$setOnInsert` (which mongoose adds automatically): **no effect**.

So it is neither the collection, the update shape, nor the document's logical
size — it is that specific row's accumulated physical representation.

**Confirmed by the fix.** Rewriting the document with byte-identical content
(delete + reinsert) collapsed the physical row **189,725 → 3,082 bytes**, and
both previously-failing uploads immediately returned HTTP 200. All 22 corpus
documents are now attached.

### Why this matters more than a cap would

A cap is a known limit you design around. This is **silent, unbounded growth on
any frequently-updated document** — the number 20 was an artifact of how many
times this agent had been updated, not a limit. The same failure will reach
conversations, users, sessions, or any hot document in a UUH deployment, and it
gives no warning until the document is already un-updatable.

- **Workaround:** rewrite the document (delete + reinsert identical content).
  Cheap, but it needs a maintenance job, and nothing surfaces *which* documents
  need it before they fail.
- **Note for CWORK-1112:** the earlier claim that "stock MongoDB is untested" no
  longer applies — an A/B on the identical document and update passed on both
  engines, which is exactly why the naive reproduction was misleading. The
  failure needs an *aged* row, not a particular document or statement, so any
  comparison must age the row rather than replay one update.

This is precisely the incompatibility CWORK-1107 predicted would "surface on day
one rather than during the M2 spike."

### Original symptom, for reference

Attaching the 21st document failed, deterministically, with HTTP 500:

```
[/files] Error processing file: Size 32545191 is larger than MaxDocumentSize 16777216
```

FerretDB's own log names the operation:

```
command: findAndModify
result:  DocumentAfterUpdateLargerThanMaxSize
sql:     SELECT p_result::bytea, p_success FROM documentdb_api.find_and_modify($1, $2::bytea)
error:   Size 32545191 is larger than MaxDocumentSize 16777216 (SQLSTATE M003A)
```

**The agent document was 36,849 bytes. FerretDB computed the post-update size as
32,545,191** — the discrepancy explained above.

Missing-document note now obsolete: `TR-04417` and `PP-WSHA-PRIORAUTH` were
initially un-attachable and are now attached, so the corpus is complete at 22.

**Q1 was re-run against the full 22-document corpus after the fix and passes
identically** — claim UUH-2026-04417, CPT 72148, CO-50, eight-week course, foot
drop, no CO-197 leak, near-miss `DN-04421` still not cited — and it now also
draws on the newly-attached encounter transcript. The Q2/Q3/Q4 results below
were obtained at 20 documents;
Q3's conflation test in particular passed *without* its planned distractor.

## Other findings

**LibreChat bans non-browser API clients.** `uaParser` middleware rejects any
request whose User-Agent does not parse as a browser, scoring 20 violation
points and triggering a 2-hour ban of both the user id and the IP. Plain `curl`
gets banned on the first request. Bans persist to Mongo (`logs` collection, keys
`ban:<userId>` / `ban:<ip>`) and survive a restart.

Relevant to UUH: **any scripted or server-to-server integration must send a
browser-like User-Agent**, or `BAN_VIOLATIONS` must be configured. Worth raising
before they build anything against this API.

**Upstream Projects work is still dormant but no longer inert** (re-checked per
the ticket). #13494 and #13495 remain open, unassigned, no milestone — but two
contributors have now volunteered on #13495 (Jul 1, Jul 30), and PR #14626
("feat: scope memory to chat projects") is open. Building on Agents remains
correct and now has a second justification: it avoids the surface upstream is
actively moving.

## Reproducing

```bash
make -C deploy/uuh up            # stack
make -C deploy/uuh corpus-load   # embed corpus into pgvector
# then in the UI: select the "UUH Denial Appeals" agent and ask the four
# questions in deploy/uuh/demo/query-set.yaml
```
