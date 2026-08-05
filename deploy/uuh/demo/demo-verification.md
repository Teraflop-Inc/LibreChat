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
| Documents | 20 attached (see the FerretDB cap below) |
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
see the cap below — so the planned distractor was absent. But File Search still
retrieved Wasatch **denial notices**, which carry "180 days from this notice per
Section 7.3", and the model still answered **90 days** for Mountain West. The
rival figure was in its context and it did not conflate. Stronger evidence than
the planned test, obtained by accident.

## ⚠️ BLOCKER FOR CWORK-1112: FerretDB caps an agent at 20 documents

Attaching the 21st document fails, deterministically, with HTTP 500:

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

**The agent document is 36,849 bytes. FerretDB computes the post-update size as
32,545,191 — 883× its actual size.** The reported figure is byte-identical on
every retry regardless of which file is uploaded, so it is a fixed
mis-computation, not accumulation.

Mechanism on the LibreChat side: every agent update appends a full snapshot to
`versions[]` (21 versions = 34.6 KB of the 36.8 KB document). Attaching a file
is such an update.

Two reproduction attempts against FerretDB **did not** trigger it — a plain
nested-array `$push` (40 pushes) and a faithful `versions[]`-shaped document
(40 updates, 52 KB). So it is specific to LibreChat's actual update path, and
narrowing it further is upstream work.

**Impact on UUH:** a hard 20-document ceiling per agent. Their real corpus will
be far larger. This is exactly the incompatibility CWORK-1107 predicted would
"surface on day one rather than during the M2 spike."

**Not yet established: whether stock MongoDB is unaffected.** That A/B is the
decisive datapoint for CWORK-1112 and has not been run. Do not conclude FerretDB
is at fault until it has — the reproductions above failed to isolate it, so a
LibreChat-side interaction is not ruled out.

Missing from the demo as a result: `TR-04417` (hero transcript — corroborating
only, Q1 does not depend on it) and `PP-WSHA-PRIORAUTH` (Q3's distractor, which
turned out not to matter — see above).

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
