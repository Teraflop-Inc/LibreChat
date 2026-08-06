# Observability — CWORK-1119

The 4 Aug desk research compared Purview, Langfuse, Langtrace, and Phoenix and
recommended Phoenix. This closes the remaining work with hands-on measurement,
and **two of the desk conclusions do not survive contact with the code.**

Reproduce everything here with `bash deploy/uuh/observability/verify.sh`.

## The question the ticket asked, answered

> *"Where's the right integration point — LiteLLM vs the AI gateway vs LibreChat
> directly?"* … *"Does LibreChat emit OpenTelemetry natively, or does
> instrumentation have to happen at the gateway/LiteLLM?"*

**Neither. It's the OTel collector, and LibreChat already ships one.**

LibreChat is already a first-class OTLP producer:

| Component | Where | What it emits |
|---|---|---|
| OTel Node SDK | `packages/api/src/telemetry/` | Auto-instrumentation — http, express, mongodb, mongoose, undici, ioredis — **plus two LibreChat-authored application spans**: `librechat.agent.startup` (startup milestone timing) and `librechat.sse.stream` (bytes, chunks, time-to-first-chunk, end reason). **No LLM content, tokens, cost, or model name on any of them.** |
| Langfuse v5 SDK | `packages/api/src/langfuse/` + `@librechat/agents` | **All LLM telemetry** — prompts, completions, model, tokens, cost |
| OTel collector | `otel/langfuse-fanout/` + `helm/librechat/templates/langfuse-fanout-*` | fan-out, routing, filtering |

The distinction matters and an earlier draft of this document got it wrong. LibreChat
*does* author its own spans — `grep startSpan` finds them — so "infrastructure only" is
inaccurate. What holds is the substantive point: those spans carry request and stream
performance, never LLM payload. Verified by enumerating every attribute key set in
`packages/api/src/telemetry/` and `agents/startup.ts`; the only `setCompletionAttributes`
in the tree is **HTTP** completion (`http.route`, `http.response.status_code`), not LLM
completion.

⚠️ One thing those spans *do* carry: **`enduser.id`** — the authenticated user id is
attached to every request span (`setIdentityAttributes`), alongside
`librechat.tenant.id`. Not a name or PHI, but it is user-identifying, and it means the
generic OTel stream is not anonymous. Worth knowing before choosing where those spans
land.

Two consequences that matter more than the platform choice:

1. **Pointing an OTLP backend at LibreChat's generic OTel gets you nothing
   useful.** Those instrumentations are all infrastructure. Every prompt, token,
   and cost figure travels the *Langfuse* path.
2. **The Helm chart already ships `otel/opentelemetry-collector-contrib`** as a
   sidecar (`values.yaml: langfuseFanout.otelCollector`, pinned 0.143.0). The
   integration point exists and is deployed; it only needs configuring.

## ❌ Correction 1 — Phoenix cannot read LibreChat's traces

The desk research recommended Phoenix without checking whether it can interpret
what LibreChat emits. **It cannot.** Measured, by sending both span flavours to
a live Phoenix and reading back its own GraphQL API:

| span sent | Phoenix `spanKind` | tokens (total/prompt/completion) |
|---|---|---|
| Langfuse-flavoured — **what LibreChat emits** | `unknown` | **0 / null / null** |
| OpenInference — Phoenix's native convention | `llm` | 59 / 42 / 17 |

LibreChat's LLM payload lives under `langfuse.observation.*` (`.input`,
`.output`, `.model.name`, `.usage_details`, `.cost_details`). Phoenix reads
OpenInference (`openinference.span.kind`, `llm.token_count.*`, `input.value`).
The spans arrive and are stored — they are simply opaque. **No token accounting,
no cost, no prompt/completion panes, and no LLM-as-judge evals**, which is the
main reason to want Phoenix at all.

### The fix, written and verified

`otelcol.yaml` transforms the attributes in flight. Same span, through this
collector:

| span sent | Phoenix `spanKind` | tokens |
|---|---|---|
| Langfuse-flavoured, **via `otelcol.yaml`** | `llm` | **59 / 42 / 17** |

Identical to a natively-instrumented span. **Zero LibreChat code change** — it is
collector config, so it adds no fork drift.

## ❌ Correction 2 — Phoenix does not tolerate an arbitrary UID out of the box

The ticket said: *"non-root is certain, arbitrary-UID is inferred."* The
inference was wrong. Run under OpenShift's `restricted-v2` shape — random high
UID, GID 0, no privilege escalation, all capabilities dropped — Phoenix **exits 1
at import time**:

```
💥 Failed to initialize the working directory at /.phoenix
PermissionError: [Errno 13] Permission denied: '/.phoenix'
  File ".../phoenix/config.py", line 3155, in <module>
    ensure_working_dir_if_needed()
```

The image declares `User=0`. OpenShift overrides that; `HOME` becomes `/`, so
`~/.phoenix` resolves to `/.phoenix`, which the arbitrary UID cannot write. This
happens during module import, before any server logic — so it is a hard crashloop,
not a degraded mode.

**Fix (verified): set `PHOENIX_WORKING_DIR` to a writable path** and mount a
volume there. With it, Phoenix runs healthy at `uid=1000670000 gid=0 HOME=/`.

This is worth knowing beyond Phoenix: **it is the exact failure mode to expect
from every container in this stack under `restricted-v2`**, and it directly
informs the 10h SCC line in the CWORK-1124 estimate.

## 🚨 PHI landmine — the Langfuse base URL defaults to a public cloud

`packages/api/src/langfuse/config.ts`:

```ts
const DEFAULT_BASE_URL = 'https://cloud.langfuse.com';
```

Set `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` but forget
`LANGFUSE_BASE_URL`, and **every prompt and completion is exported to a
third-party cloud in the EU.** No warning, no failure — tracing simply works, at
the wrong destination.

**It is not only the env var.** The Helm chart carries the same default:

```yaml
# helm/librechat/values.yaml
langfuseFanout:
  central:
    baseUrl: https://cloud.langfuse.com
```

So both the application default and the deployment default point off-premises. Two
independent places to get this wrong, neither of which fails loudly.

For a health system this is the same class of finding as CWORK-1116's hosted code
interpreter. It belongs in the deployment checklist as a hard gate, not a note.

Fail-safe behaviour is otherwise good: with no keys set, nothing exports at all
(`hasLangfuseEnvCredentials()` gates it). The danger is exclusively the
half-configured state.

## ⚠️ LibreChat does not expose Langfuse's masking hook

The Langfuse SDK supports client-side redaction — a `MaskFunction` applied
*before the span leaves the process* (`@langfuse/otel`, `MaskFunction`). This is
the same architecture the desk research credited to Phoenix's OpenInference
`TraceConfig`, and it is equally available here in principle.

**LibreChat does not wire it up.** No `mask`, `redact`, or `sanitize` anywhere in
`packages/api/src/langfuse/`. Prompts and completions are exported verbatim.

Three ways out, in ascending cost:

1. **Self-host Langfuse inside the trust boundary** and accept verbatim export —
   nothing leaves UUH. Adequate if the Langfuse instance is in-cluster and
   in-scope for their BAA. **Recommended default.**
2. **Redact at the collector** with a `transform` processor — no fork drift,
   coarse (attribute-level, same limitation the ticket noted for Phoenix).
3. **Wire the mask through `buildLangfuseConfig`** — small, contained, and
   plausibly upstreamable, but it is fork drift in `packages/api/`.

## Purview — unchanged, and still correct

Nothing found here contradicts the desk research. Purview has no read API, so it
cannot be the engineering-observability plane; it remains the compliance/DLP
plane, already deployed, already under BAA. **Keep it. It is not competing with
any of this.**

Its three operational constraints stand and are still unverified with UUH:
mandatory pay-as-you-go metering, `evaluateInline` blocking the chat hot path,
and prompts landing in users' Exchange Online mailboxes.

## Recommendation

**Run one collector; fan out to both. Do not treat this as Phoenix *vs* Langfuse.**

```
LibreChat ──OTLP──▶ collector ──┬──▶ Langfuse   (native attrs, untouched)
  LANGFUSE_BASE_URL              └──▶ Phoenix    (transformed to OpenInference)
  points here
```

- **Langfuse is the lower-friction primary.** LibreChat speaks it natively,
  feedback scores are already wired (`packages/api/src/langfuse/feedback.ts`),
  and it needs no transform. The desk research's objection — four required
  datastores against a procurement clock — is real and unchanged.
- **Phoenix is the analysis/eval plane**, and its integration cost is now
  ~zero because the transform is written and verified. Its OSS advantages from
  the desk research (no feature gates, free OIDC SSO, MCP server, single
  datastore) all stand.
- **The decision is now cheap and reversible**, which is the actual result here.
  Start with whichever UUH's procurement clears first; adding the other later is
  a collector config change, not a migration.

### Deployment gates

| Gate | Setting |
|---|---|
| 🔴 Langfuse must be self-hosted | `LANGFUSE_BASE_URL` — **never leave unset** |
| 🔴 Phoenix arbitrary UID | `PHOENIX_WORKING_DIR=/var/phoenix` + writable volume |
| 🟡 Phoenix phone-home | `PHOENIX_TELEMETRY_ENABLED=false`, `PHOENIX_ALLOW_EXTERNAL_RESOURCES=false` |
| 🟡 Phoenix sandbox providers | `PHOENIX_ALLOWED_SANDBOX_PROVIDERS=NONE`, `PHOENIX_ALLOWED_PROVIDERS=NONE` |
| 🟡 Langfuse phone-home | `TELEMETRY_ENABLED=false` — **set it explicitly**; the schema in `web/src/env.mjs` declares it optional with **no default**, so unset means `undefined` and the consuming code decides. Not verified which way. |
| 🟡 Langfuse UTC | ClickHouse and Postgres must both run UTC or queries silently return wrong results |
| 🟡 Phoenix licence | ELv2 + patents US 11,315,043 / 11,615,345 — legal review |

## Still open

- **Purview metering cost** at LibreChat's expected volume — needs UUH's
  Microsoft account team. Blocked on the CWORK-1123 email.
- **Which platform procurement clears.** Technical work no longer gates this.
- **Whether to upstream the mask hook.** Only matters if option 1 above is
  rejected.
- The transform covers `generation` and `span` observation types. Other Langfuse
  observation types (`event`, `agent`, `tool`, `retriever`) will land in Phoenix
  as `unknown` until added — trivial, but it needs real LibreChat traffic to
  enumerate which types actually appear.

## What was verified, and how far it goes

Every claim above is either read from source in this tree or measured against
running containers. Two limits are worth stating plainly rather than leaving for
someone to discover:

**The transform is verified against a synthetic span, not live LibreChat
traffic.** `verify.sh` constructs a span by hand and asserts Phoenix reads it.
That is a real end-to-end test of the collector, the transform, and Phoenix — but
the span is one I wrote. Guarding against the obvious circularity (inventing both
the attribute names and the parser), the keys were checked against the SDK itself:

| what | verified where |
|---|---|
| `langfuse.observation.{type,input,output,model.name,usage_details}` | attribute constants in `@langfuse/core` |
| `usage_details` inner keys `input` / `output` / `total` | population code in `@langfuse/*` — also emits prefixed variants (`input_cache_read`, …) |
| ingest path `/api/public/otel/v1/traces` | `@langfuse/otel`, and it matches the shipped fanout collector's `traces_url_path` |

The remaining gap is real traffic: which observation types LibreChat actually
produces in practice, and whether `total` is always present. Both are cheap to
close once the stack runs with tracing on, and neither changes the architecture.

**The OpenShift claim is a container-level simulation, not a cluster test.**
Running `--user 1000670000:0 --cap-drop ALL --security-opt no-new-privileges`
reproduces what `restricted-v2` does to a container, and it is how the Phoenix
crash was found. It does **not** cover SCC admission, SELinux labelling, volume
`fsGroup` behaviour, or NetworkPolicy. A real cluster test remains part of
CWORK-1115.
