# Billable hours estimate — LibreChat full scope

CWORK-1124 · prepared 2026-08-06 · **internal working document, not customer-facing copy**

Work Order 15 / PO# 7707501 is a **100-hour block**. Teraflop bills $150/hr; Structured
bills UUH ~$250/hr.

> ## Headline: the 100-hour block does not reach production.
>
> Full scope estimates at **~156 hours** (band 135–190h). About **30h is already
> consumed**. The block covers M1, M2 validation, the research tickets, and the start
> of Helm work — it stops well short of a running OpenShift deployment.
>
> This is a finding, not a problem. Better to say it now than at hour 95.

## Basis

Estimates below are **biased high, deliberately.** Two reasons:

1. **Nothing is in production.** Every hour spent so far has been local. The
   OpenShift/Helm/SSO block is the largest line item and the least de-risked, and it is
   estimated from experience rather than from measurement.
2. **Validation is the work, and it should be priced as work.** The M1 numbers came in
   at ~2× estimate almost entirely because of testing — repeat runs, root-cause
   isolation, a chunking sweep, a mutation suite. That testing is what caught two
   wrong answers and one platform bug before a customer saw them. Estimating it thin
   would misrepresent what this engagement actually requires.

Where a number moved, the reason is stated. Where scope is unknown, it is marked
**UNSCOPED** rather than guessed low.

---

## Phase 1 — M1 demo · **COMPLETE** · est 7h → **actual 15h**

| Ticket | Est | Actual | Why it moved |
|---|---|---|---|
| CWORK-1107 stack | 1.5 | **3** | Scope changed mid-flight: the architecture became FerretDB + documentDB rather than MongoDB. Compose-override debugging (base image hardcodes `MONGO_URI`) was not anticipated. |
| CWORK-1108 query set | 0.5 | **1** | Added `validate_query_set.py` so question wording cannot silently drift from the ticket. |
| CWORK-1109 corpus | 2 | **3.5** | 22 documents, plus a retrieval harness and a 4-configuration chunking sweep (full vector-store rebuild per row). |
| CWORK-1110 verify | 1.5 | **5** | The big overrun, and the most valuable. Covers repeat-run verification, FerretDB bloat root-cause isolation (6 discriminating tests), and a three-model comparison. |
| CWORK-1111 branding | 1.5 | **2.5** | Found a no-fork theming route via CSS custom properties, then built a 7-test mutation suite to prove the patcher is idempotent and reversible. |
| **Total** | **7** | **15** | **2.1×** |

**What the overrun bought.** Three things that would otherwise have surfaced in front of
the customer:

- A **platform bug** — FerretDB grows a document's physical row without bound until it
  becomes permanently un-updatable. Silent, and it will reach conversations and sessions
  in a real deployment.
- A **wrong answer** — the aggregate question returned 4, 5, or 6 for a ground truth of
  5, stated confidently. A revenue-cycle director notices a wrong number immediately.
- A **wrong claim** — roughly 1 run in 6 drafted a fluent appeal for the wrong claim,
  wrong payer, and wrong policy.

All three were found by repeating runs rather than by running once. Single-sample
verification would have shipped every one of them.

## Phase 2 — M2 validation · **partially complete** · **25h**

| Ticket | Est | Estimate now | Status |
|---|---|---|---|
| CWORK-1112 FerretDB spike | 16 | **14** (10 spent + 4 new) | ✅ **Done, verdict GREEN.** Converged faster than the 2-day estimate, but created new scope: the bloat bug needs a maintenance job, and nothing currently surfaces which documents are at risk before they fail. |
| CWORK-1113 DBA privileges | 1 | **2** | Blocked on UUH. One conversation, but `pgvector` + `documentdb` + `uuid-ossp` on a hardened image is realistically two or three rounds, not one. |
| CWORK-1114 gateway probe | 1 | **3** | Scope grew. It is no longer "does the gateway speak OpenAI" — M1 established that **`gpt-4o` is not adequate for this workload**. The probe must now also establish whether their gateway serves a model that is, which is a harder question and a commercially significant one. |
| CWORK-1116 code interpreter | — | **6** | ⚠️ **Already answered, and the answer is bad.** LibreChat's code interpreter defaults to `https://api.librechat.ai/v1` — a **third-party hosted API**. User code and data go outbound. For UUH that is PHI egress. 6h covers disabling it and documenting the constraint. **Self-hosting a replacement sandbox is separately UNSCOPED and would be 20h+.** |

## Phase 3 — Research tickets R1–R6 · **12h**

Estimated at 10.5h collectively; several are substantially answered by desk research
already. Held at **12h** rather than reduced, because closing them properly means
hands-on validation, not a written summary — and two have already returned answers that
change the architecture:

- **R3 observability (CWORK-1119): ✅ now complete, 3h.** Purview has **no read API**
  (Microsoft's own docs: *"There are no APIs available to extract data or analytics from
  Microsoft Purview."*), so a real observability platform is required work, not an
  evaluation. Hands-on testing then found the integration point is the **OTel collector
  LibreChat already ships** — no LiteLLM or gateway instrumentation needed — and that
  Phoenix cannot read LibreChat's spans without an attribute transform, which is now
  written and verified. Net effect on this estimate: **Phase 5's observability line holds
  at 10h**, because the transform work is done but the platform still has to be deployed,
  secured, and wired to real traffic.
- **R6 skillification (CWORK-1122):** no credible self-hosted Cowork alternative exists;
  twelve platforms surveyed, every one fails a hard constraint. Confirms the build-on-
  Agents direction.

## Phase 4 — Production deployment · **UNSCOPED until CWORK-1113 returns** · **~66h**

**This is the block that does not fit.** Every line is an estimate from experience; none
of it has been measured, because none of it has been attempted.

| Work | Hours | Risk |
|---|---|---|
| Helm chart — author or adapt, parameterise for UUH | 12 | Medium. No official chart; community charts are of unknown maintenance quality. |
| OpenShift `restricted-v2` SCC compliance | 10 | **High — now with evidence.** Non-root, no privileged containers, arbitrary UID. CWORK-1119 tested one sidecar (Phoenix) under the `restricted-v2` container shape and it **crashlooped at import time**: the image declares `User=0`, OpenShift overrides it, `HOME` becomes `/`, and its working directory is unwritable. One env var fixed it — but that is one container, found in minutes, and the stack has many. FerretDB/documentdb least likely to cooperate. |
| Index creation for `autoIndex: false` | 6 | Medium. Production disables automatic index creation; every index LibreChat relies on must be created explicitly. Missing one degrades silently under load rather than failing loudly. |
| Postgres + extensions in their environment | 8 | **High, and gating.** Blocked on CWORK-1113. If `documentdb` is refused, the FerretDB architecture is void and this re-plans entirely. |
| Deploy and iterate in their cluster | 16 | **High.** First contact with a real environment. Estimated generously and still likely optimistic. |
| SSO (Entra / SAML) | 8 | Medium. |
| Ingress, routes, TLS, network policy | 6 | Medium. |
| **Subtotal** | **66** | |

⚠️ **One dependency can invalidate this whole phase.** If UUH's DBAs refuse the
`documentdb` extension, FerretDB is out and the datastore is re-architected. That is the
single highest-leverage unknown on the engagement, it is one conversation, and it is
currently blocked on the CWORK-1123 email.

## Phase 5 — Integrations · **26h**

| Work | Hours | Note |
|---|---|---|
| M365 MCP connector | 12 | Licensing unresolved — if the official connector requires Copilot licensing, this path may close and the unofficial connector re-enters. |
| Observability integration | 10 | Purview is out (no read API). Assumes Langfuse or equivalent, self-hosted. |
| Web search controls | 4 | Read-only GET only; mode already decided. |

## Phase 6 — Handover · **12h**

| Work | Hours |
|---|---|
| Runbook, upgrade procedure, upstream-merge process | 8 |
| Knowledge transfer with Jason's team | 4 |

The upgrade procedure matters more than it looks. The fork currently carries **zero
drift outside `deploy/uuh/`**, which is what makes pulling upstream security releases
cheap. That property is worth documenting explicitly, because it is easy to destroy with
one well-intentioned edit to `client/src/style.css`.

---

## Totals

| Phase | Hours |
|---|---|
| 1 — M1 demo (complete) | 15 |
| 2 — M2 validation | 25 |
| 3 — Research R1–R6 | 12 |
| 4 — Production deployment | 66 |
| 5 — Integrations | 26 |
| 6 — Handover | 12 |
| Engagement admin — recap email (CWORK-1123), this estimate (CWORK-1124) | 1.5 |
| **Total** | **157.5** |

Consumed to date, itemised so the figure is auditable rather than asserted:

| Work | Hours | Phase |
|---|---|---|
| M1 demo, complete (CWORK-1107 → 1111) | 15 | 1 |
| FerretDB spike, complete (CWORK-1112) | 10 | 2 |
| Observability, complete (CWORK-1119) | 3 | 3 |
| Recap email + this estimate | 1.5 | admin |
| **Consumed** | **29.5** | |

| | Hours |
|---|---|
| Total scope | 157.5 |
| Consumed to date | 29.5 |
| Remaining | **128** |
| **Work Order 15 block** | **100** |
| **Shortfall against full scope** | **~57** |

**Band: 135–190h.** Low end assumes the DBAs approve every extension, their gateway
serves a capable model, and OpenShift accepts the workloads without SCC fights. High end
assumes one of those goes wrong — most likely the extension privileges or `restricted-v2`.

## What the 100 hours does buy

Roughly: everything through M2 validation and the research tickets, plus the Helm chart
authored and the first OpenShift deployment attempted — approximately **hours 1–100 of
the 156**. It stops mid-Phase-4.

That is a defensible place to pause and re-scope with a real measurement of the OpenShift
work in hand, rather than the estimate above.

## Three things that would move this number

1. **CWORK-1113 (DBA extensions).** One conversation. Gates Phase 4 entirely and could
   void the architecture. Blocked on the CWORK-1123 email — this is the reason that email
   matters commercially, not just as a courtesy.
2. **CWORK-1114 (gateway model quality).** If their gateway only serves `gpt-4o`-class
   models, the demo's correctness results do not carry to production and the model
   question reopens.
3. **CWORK-1116 (code interpreter).** Disable-and-document is 6h. Self-hosting a
   replacement sandbox is 20h+ and unscoped. UUH decides which.

## Caveat

These are estimates of **billable engineering hours**, not elapsed calendar time, and not
a quote. Phases 4 and 5 have never been attempted in UUH's environment; Phase 1 is the
only block measured against actuals, and it came in at 2.1× its estimate.
