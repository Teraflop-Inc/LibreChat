# Helm + OpenShift — CWORK-1115

The hand-off artifact. Reproduce every claim here with
`bash deploy/uuh/helm/verify.sh` (docker only, no cluster needed).

> ## Headline: the stock chart and stock image **do not run** on OpenShift.
>
> Not "may need tuning" — a **crashloop at startup**, from two independent
> causes, both measured. Both are fixed by `values-openshift.yaml`, and
> **neither needs a fork.**

## The ticket's questions, answered

| Question | Answer |
|---|---|
| Is there an official/community Helm chart? | **Yes, several.** The official one is upstream's, already in this repo at `helm/librechat` (v2.0.7). It is also **published** — `helm repo add librechat https://danny-avila.github.io/LibreChat`. There are three community forks, including **an OpenShift-specific one**. See the survey below. |
| What does it deploy? | LibreChat itself (Deployment, Service, Ingress, PVC, HPA, ServiceAccount) plus an optional Langfuse-fanout collector. Datastores come from **chart dependencies**: MongoDB + Redis (Bitnami), MeiliSearch, and a local `librechat-rag-api` subchart. |
| Which pieces do we supply? | **Postgres + pgvector, and FerretDB.** Neither is a chart dependency. The chart's bundled MongoDB is disabled — UUH's architecture is FerretDB on PostgreSQL (CWORK-1112). |
| Does the Helm path require a fork? | **No.** The chart exposes `volumes` / `volumeMounts` passthroughs and renders both security contexts from values, so everything needed is a values overlay. `helm/` is untouched. |
| How does branding interact? | It doesn't. Branding is CSS applied at runtime (CWORK-1111), not an image change, so **no custom image build and no registry question** for branding specifically. |
| What registries are needed? | `registry.librechat.ai` for the app image, and **Docker Hub** — Bitnami chart dependencies now resolve to `registry-1.docker.io/bitnamicharts/*`. Worth confirming against UUH's allowlist. |

## Survey of published charts

| Chart | Publisher | Chart / appVersion | Verified | Verdict |
|---|---|---|---|---|
| `librechat/librechat` | **danny-avila (official)** | 2.0.7 / v0.8.7 | ✅ official | **Use this.** It is what `helm/librechat` in this repo already is. Published to Artifact Hub + GitHub Pages. |
| `openshift/librechat` | joaquinito2051 | 1.8.17 / **v0.8.5-rc1** | ❌ unverified | **Don't adopt — but borrow from.** See below. |
| `blue-atlas/librechat` | blue-atlas | 0.2.0 | ❌ | Community fork, no OpenShift specialisation. |
| `AstralJaeger/librechat-chart` | AstralJaeger | 1.9.1 | ❌ | Community fork. |

### The OpenShift chart independently confirms this work — and improves it

`charts.openshift.io` carries a LibreChat chart built specifically for OpenShift.
Worth taking seriously, so it was pulled and read rather than judged by its
listing. Two conclusions.

**First: it reaches the same fix, independently.** Its `values.yaml` sets
`securityContext: {}` and `podSecurityContext: {}` — no hardcoded UIDs — and
mounts `emptyDir` volumes over the write paths, including `/app/uploads` and
`/app/logs`, plus `/app/client/public/images` in its deployment template. That
is the same diagnosis and the same remedy arrived at here from the Dockerfile
and a container test. Two independent parties converging is good corroboration
that the failure is real and the fix is the conventional one.

**Second: don't adopt it.** It targets **appVersion `v0.8.5-rc1`** — two minor
versions behind the `v0.8.7` this fork runs, and a release candidate. Publisher
is an individual, unverified, no stars, last updated 2026-04-10. Adopting it
would mean taking a stale third-party chart as the deployment substrate for a
multi-year health-system commitment, and inheriting its upgrade cadence rather
than upstream's. The values-overlay approach keeps us on the official chart.

**What was taken from it:** the **Route template**. `route.yaml` here is modelled
on theirs. There was no reason to reinvent a correct twelve-line object, and it
converts "Routes vs Ingress is a Jason conversation" into a concrete artifact.

**What was deliberately not taken:** it also mounts `/app/data` and
`/app/api/logs`. Checked against the v0.8.7 image — **neither directory exists,
and neither appears anywhere in the source.** They are almost certainly
vestigial from the older version it targets. Harmless (an `emptyDir` just
creates the path) but they would be cargo-cult, so the overlay stays at the
three paths that are actually written to.

It also ships LiteLLM templates (`litellm-deployment.yaml`, `litellm-route.yaml`).
Not relevant here — UUH has their own AI gateway (CWORK-1114) — but worth
knowing it exists as a reference if that path is ever wanted.

## Failure 1 — the image cannot write under an arbitrary UID

`USER node` in the Dockerfile is **uid 1000**, and the directories LibreChat
writes to are mode 755 owned by `node:node`:

```
drwxr-xr-x  node  node  /app
drwxr-xr-x  node  node  /app/uploads
drwxr-xr-x  node  node  /app/client/public/images
```

OpenShift `restricted-v2` runs the container as an **arbitrary high UID in group
0**. That UID is neither the owner (1000) nor in group 1000, so it falls through
to *other* — `r-x`, no write bit. Measured:

```
$ docker run --user 1000670000:0 … registry.librechat.ai/danny-avila/librechat-dev
uid=1000670000 gid=0(root) groups=0(root)
READONLY /app
READONLY /app/uploads
READONLY /app/client/public/images
```

The result is not a degradation. The process **dies at startup**, before serving
anything, when the logger opens its first file:

```
status: exited  exit=1
error: There was an uncaught error:
       EACCES: permission denied, open '/app/logs/error-2026-08-06.log'
```

The Dockerfile uses `chown node:node`. The OpenShift-compatible idiom is
`chgrp 0 && chmod g=u`, which would let *any* assigned UID write via the root
group. That is an upstream image fix; we work around it in the chart instead.

### Fix — back the three write paths with volumes

Same image, same arbitrary UID, writable volumes mounted:

```
status: running  exit=0
Connected to MongoDB
Server listening on all interfaces at port 3080
/health → HTTP 200
```

The three paths are not guesses. They are exactly the three the upstream
maintainers bind-mount in `docker-compose.yml`:

```yaml
- ./images:/app/client/public/images
- ./uploads:/app/uploads
- ./logs:/app/logs
```

`/app/client/public/images` is handled by the chart's own `imageVolume` PVC
flag; the other two get `emptyDir`.

⚠️ **One open decision for Jason: should `/app/uploads` be durable?** `emptyDir`
loses staged uploads on pod restart. That is fine if uploads are transient
(staged, then embedded into pgvector or pushed to object storage) and wrong if
users expect to re-download what they uploaded. This needs an answer before
production, and it is a product question, not an infrastructure one.

## Failure 2 — the chart hardcodes UIDs that admission rejects

```yaml
# helm/librechat/values.yaml
podSecurityContext:
  fsGroup: 2000        # line 168
securityContext:
  runAsUser: 1000      # line 176
```

`restricted-v2` allocates a **per-namespace UID/GID range** and requires values
inside it. A pod requesting a specific UID or fsGroup is refused **before it ever
runs** — this failure is at admission, so it produces no container logs to debug.

Credit where due: `runAsNonRoot: true` and `capabilities.drop: [ALL]` are already
correct.

### ⚠️ The trap: `{}` does not delete an inherited value

The first draft of the overlay set `podSecurityContext: {}` and simply omitted
`runAsUser`. **Both hardcoded values survived into the rendered manifest.** Helm
*merges* values maps rather than replacing them, so an empty map changes nothing
and an omitted key inherits the base.

Only an explicit `null` deletes a key:

```yaml
podSecurityContext:
  fsGroup: null
securityContext:
  runAsUser: null
```

This was caught by asserting against the *rendered* output rather than trusting
the overlay to do what it looked like it did. It is the single easiest way to
ship a chart that fails admission while appearing correct in review — the values
file reads exactly as intended and is silently a no-op. `verify.sh` asserts it
permanently.

## What is deliberately disabled, and why

| Dependency | State | Reason |
|---|---|---|
| `mongodb` | **off** | UUH deploys **FerretDB on PostgreSQL**. No MongoDB, no MongoDB Inc. relationship, no SSPL software (CWORK-1112). |
| `meilisearch` | off for now | Bitnami-family; SCC posture unverified. Enable and re-test one at a time. |
| `redis` | off for now | Same. |
| `librechat-rag-api` | off for now | Local subchart; needs the same arbitrary-UID test the main image got. |

Starting with the smallest surface is deliberate: with four untested dependencies
enabled at once, an admission failure gives you four suspects and no logs.

## Ingress vs Route

OpenShift materialises a Route from a plain `Ingress` automatically, so the
stock template would work. But a native Route is the idiomatic object and the
only way to declare edge TLS and an HTTP→HTTPS redirect, so `route.yaml` ships
here as a standalone manifest — a values overlay cannot add a template to a
chart, and `helm/` stays untouched.

`ingress.enabled: false` in the overlay so the two do not both claim the
hostname.

⚠️ Two fields need UUH input before this is production-ready: the **hostname**
(left blank, so OpenShift generates one — fine for a first deployment) and
whether the certificate is cluster-default or UUH-supplied. Both are Jason
conversations. If encryption is required all the way to the pod rather than
terminating at the router, `termination: edge` becomes `reencrypt` and the pod
needs a serving certificate.

## How to deploy

```bash
helm dependency build ./helm/librechat
helm upgrade --install librechat ./helm/librechat \
  -f deploy/uuh/helm/values-openshift.yaml \
  --namespace <uuh-namespace>

# Native Route (optional — OpenShift would generate one from an Ingress)
oc apply -f deploy/uuh/helm/route.yaml -n <uuh-namespace>
```

Nothing under `helm/` is modified, so upstream chart updates merge cleanly.
(`helm/**/charts/` is gitignored, so `dependency build` creates no drift.)

## Limits of this verification

**This is a container-level simulation, not a cluster test.** Running
`--user <high-uid>:0 --cap-drop ALL --security-opt no-new-privileges`
faithfully reproduces what `restricted-v2` does *to a container*, and it is how
both failures were found. It does **not** cover:

- **SCC admission itself** — the `runAsUser`/`fsGroup` rejection is *inferred*
  from the restricted-v2 policy, not observed. The rendered manifest is asserted
  clean; whether admission accepts the whole pod is unproven.
- SELinux labelling, `fsGroup` volume-ownership behaviour, NetworkPolicy,
  Routes, or storage classes.
- The four disabled dependencies, all still untested.

A real cluster remains required, and it is the largest single unknown in the
CWORK-1124 estimate's 66h production phase. What this work removes is the
*discovery* cost: two failures that would each have cost a debugging cycle
against a real cluster are now found, explained, and fixed in advance.
