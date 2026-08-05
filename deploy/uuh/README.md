# UUH LibreChat — local stack (CWORK-1107)

Local LibreChat for the University of Utah Health demo: **FerretDB** (not MongoDB)
for app metadata, **pgvector** for embeddings, **RAG API** sidecar, **OpenAI direct**.

## Why this directory exists

This is a **fork** of `danny-avila/LibreChat` and we need to keep pulling upstream.
Every customization therefore lives in `deploy/uuh/` — a directory upstream does not
ship — so `git rebase upstream/main` can never conflict on our changes.

Nothing in this repo's upstream-tracked files is modified. Verify anytime with:

```bash
git diff upstream/main --stat -- . ':!deploy/uuh'   # should be empty
```

## Run it

```bash
make -C deploy/uuh up        # or the raw command below
docker compose -f docker-compose.yml -f deploy/uuh/docker-compose.uuh.yml up -d
```

LibreChat: <http://localhost:3080> · Admin panel: <http://localhost:3000>

## Pulling from upstream

```bash
git fetch upstream
git rebase upstream/main
```

Watch for two things after a rebase — they are the only places upstream can break us:

1. **`api.environment.MONGO_URI` in `docker-compose.yml`.** Upstream hardcodes
   `mongodb://mongodb:27017/LibreChat` there. Container env beats the bind-mounted
   `.env`, so our overlay must keep overriding it or the app silently reverts to
   stock Mongo. (This is not hypothetical — it bit during CWORK-1107.)
2. **New required env vars** in `.env.example`. Diff it against `.env`:
   `diff <(grep -oE '^[A-Z_]+=' .env.example | sort -u) <(grep -oE '^[A-Z_]+=' .env | sort -u)`

## Architecture notes

**FerretDB, not MongoDB.** LibreChat needs a Mongo-wire-protocol datastore. FerretDB
is Apache-2.0 and stores everything in PostgreSQL, so UUH gets no MongoDB Inc. vendor,
no SSPL-licensed software, and no Mongo binary in their environment. Image pins mirror
upstream's own FerretDB test compose (`packages/data-schemas/misc/ferretdb/`).

Upstream ships ~10 dedicated `*.ferretdb.spec.ts` suites (multi-tenancy, sharding,
migration anti-join, ACL bitops), so Mongo-compatibility is actively tested upstream —
this is better supported than "community workaround" territory. See CWORK-1112.

**FerretDB requires auth.** The backing Postgres role doubles as the Mongo credential:
`mongodb://ferretdb:ferretdb@ferretdb:27017/LibreChat`. Without credentials LibreChat
connects successfully and *then* dies on the first query with
`Command find requires authentication` — a confusing failure worth recognizing.

**Two Postgres instances, deliberately.** `ferretdb-postgres` (documentdb extension,
app metadata) and `vectordb` (pgvector, embeddings). The ticket's "one Postgres serves
both" is the *production* target; locally they are separate because FerretDB's image
bundles its own tuned Postgres. Consolidation is a CWORK-1113 question (extension
privileges with UUH DBAs).

## Gotchas

- **Do NOT change `EMBEDDINGS_DIMENSIONS` on an existing collection.** pgvector requires
  uniform dimensionality; changing it corrupts the collection. Currently 1536
  (`text-embedding-3-small`).
- **The RAG API image is the `-lite` build** — remote embeddings only, no local models.
- **RAG API requires a JWT** signed with the shared `JWT_SECRET` from `.env`.
- `.env` is gitignored. Secrets in `.env.example` are **publicly known defaults** —
  `CREDS_KEY`, `CREDS_IV`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `MEILI_MASTER_KEY` are
  all rotated at setup. Never ship the example values.

## ⚠️ Before this becomes the OpenShift hand-off (CWORK-1115)

`docker-compose.uuh.yml` hardcodes `ferretdb:ferretdb` as the FerretDB/Postgres
credential. That is deliberate for a local demo and matches upstream's test compose —
it is **not** acceptable in a UUH environment. Anything derived from this file must:

- source the FerretDB Postgres credential from a Secret, not the compose literal;
- source `.env`'s rotated `CREDS_KEY` / `CREDS_IV` / `JWT_SECRET` /
  `JWT_REFRESH_SECRET` / `MEILI_MASTER_KEY` from a Secret too;
- not expose FerretDB's `27020` outside the namespace (it is published locally only
  for `mongosh`/test access).

## M2 swap points (no code change)

- **AI gateway** (CWORK-1114): `endpoints.custom` in `deploy/uuh/librechat.uuh.yaml` for
  chat; `RAG_OPENAI_BASEURL` in `.env` for embeddings.
- **Chunking**: `CHUNK_SIZE=1500`, `CHUNK_OVERLAP=100` in `.env`.
