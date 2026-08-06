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
| Is there an official/community Helm chart? | **Yes — upstream ships one**, in this repo at `helm/librechat` (chart v2.0.7). No third-party chart needed. |
| What does it deploy? | LibreChat itself (Deployment, Service, Ingress, PVC, HPA, ServiceAccount) plus an optional Langfuse-fanout collector. Datastores come from **chart dependencies**: MongoDB + Redis (Bitnami), MeiliSearch, and a local `librechat-rag-api` subchart. |
| Which pieces do we supply? | **Postgres + pgvector, and FerretDB.** Neither is a chart dependency. The chart's bundled MongoDB is disabled — UUH's architecture is FerretDB on PostgreSQL (CWORK-1112). |
| Does the Helm path require a fork? | **No.** The chart exposes `volumes` / `volumeMounts` passthroughs and renders both security contexts from values, so everything needed is a values overlay. `helm/` is untouched. |
| How does branding interact? | It doesn't. Branding is CSS applied at runtime (CWORK-1111), not an image change, so **no custom image build and no registry question** for branding specifically. |
| What registries are needed? | `registry.librechat.ai` for the app image, and **Docker Hub** — Bitnami chart dependencies now resolve to `registry-1.docker.io/bitnamicharts/*`. Worth confirming against UUH's allowlist. |

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

OpenShift accepts standard `Ingress` and materialises a Route from it
automatically, so the stock template works. A **native Route with edge TLS
termination** and UUH's certificate is more idiomatic and is a Jason
conversation. `ingress.enabled: false` for now rather than shipping a guess at
their hostname and TLS setup.

## How to deploy

```bash
helm dependency build ./helm/librechat
helm upgrade --install librechat ./helm/librechat \
  -f deploy/uuh/helm/values-openshift.yaml \
  --namespace <uuh-namespace>
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
