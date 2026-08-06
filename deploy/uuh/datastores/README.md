# Datastores — CWORK-1115

The pieces UUH has to run that **no chart supplies**. LibreChat's upstream chart
depends on MongoDB, Redis and MeiliSearch — none of which this architecture uses.
FerretDB, documentdb PostgreSQL and pgvector had existed only as compose services
until now.

```
oc apply -f deploy/uuh/datastores/pgvector.yaml -n <namespace>
oc apply -f deploy/uuh/datastores/ferretdb.yaml -n <namespace>
```

Plain Kubernetes manifests rather than a chart, deliberately: the
umbrella-vs-separate-releases question is still open (it turns on whether UUH
runs ArgoCD/Flux or plain Helm), and these are needed identically under every
option. They drop into a chart's `templates/` unchanged if the umbrella route is
taken.

## Verified under the OpenShift `restricted-v2` shape

Every image run as an arbitrary high UID in group 0, all capabilities dropped,
no privilege escalation — then exercised, not merely started:

| Component | Result |
|---|---|
| `pgvector` | ✅ ready · `CREATE EXTENSION vector` → **0.8.0** · distance query correct |
| `postgres-documentdb` | ✅ ready · all 8 extensions present · `pg_isready` accepting |
| `ferretdb` | ❌ **crashed** → ✅ fixed with a writable `/state` |
| **End to end** | ✅ **Mongo-protocol insert + count round-tripped: `inserted, docs=1`** |

## 🔴 The finding that matters most — CWORK-1113's ask is much bigger than written

CWORK-1113 plans to ask UUH's DBAs about `pgvector`, `documentdb` and
`uuid-ossp`. **That understates it substantially.** documentdb's own control file
declares:

```
requires = 'documentdb_core, pg_cron, tsm_system_rows, vector, postgis, rum'
```

Six extensions, including **PostGIS** and **pg_cron**. And the server itself must
be started with:

```
shared_preload_libraries = pg_cron, pg_documentdb_core, pg_documentdb
```

That last line is the hard part. `shared_preload_libraries` is not a
`CREATE EXTENSION` a DBA can grant on request — **it is a postgresql.conf change
requiring a full server restart**, and on hardened or managed PostgreSQL it is
routinely refused outright. Managed services (RDS, Azure Database, Cloud SQL)
allow only an allow-listed subset, and `pg_documentdb` is not on any of them.

**Consequences worth being blunt about:**

- If UUH expects to point this at an existing shared PostgreSQL cluster, that
  will almost certainly be refused. documentdb effectively requires a
  **dedicated PostgreSQL instance UUH controls** — which is what the StatefulSet
  here provides, and is the reason to run it in-namespace rather than asking for
  a database from a central DBA team.
- This raises the risk on CWORK-1113, and CWORK-1113 gates the entire 66h
  production phase in the CWORK-1124 estimate. Worth asking early and specifically:
  not "can we have pgvector?" but "can we run our own PostgreSQL pod with
  `shared_preload_libraries` set, in our namespace?"
- If the answer is no, FerretDB is out and the datastore re-plans — the single
  highest-leverage unknown on the engagement.

## Two non-obvious things encoded in the manifests

**1. `PGDATA` must be a subdirectory of the mount, not the mount itself.**
A mounted volume root frequently contains `lost+found`, and `initdb` refuses to
initialise a non-empty directory — the pod crashloops with *"directory exists but
is not empty"*. Both StatefulSets set `PGDATA=/var/lib/postgresql/data/pgdata`
against a mount at `/var/lib/postgresql/data`.

**2. FerretDB needs a writable `/state`.** The image declares `USER ferretdb`, so
`/state` is owned by that user and is unwritable by OpenShift's arbitrary UID.
Measured without the volume:

```
Failed to set up state provider: failed to persist state:
open /state/state.json: permission denied      (exit 1)
```

`emptyDir` is correct — that is process state, not data. The data is in Postgres.

## Why there is no pod-level `securityContext`

Its absence is the point. OpenShift's `restricted-v2` admission injects
`runAsUser` and `fsGroup` from the namespace's allocated range, and **specifying
either is rejected before the pod starts** — a failure that produces no container
logs. `fsGroup` is also what makes the PVC group-writable by the assigned UID, so
letting OpenShift set it is what makes Postgres able to write at all.

Container-level `runAsNonRoot`, `allowPrivilegeEscalation: false` and
`capabilities.drop: [ALL]` are stated explicitly — all three are what
`restricted-v2` wants anyway, and stating them keeps the manifests correct on a
vanilla cluster with no SCC controller.

## ⚠️ Before this is production-ready

| Item | Status |
|---|---|
| **Secrets** | Both files carry `CHANGEME` placeholders. Replace with SealedSecrets or External Secrets — **do not commit real credentials.** |
| **Storage classes** | `storageClassName` commented out in both; needs UUH's classes. |
| **Sizes** | 20Gi each, a guess. Needs a corpus-size estimate. |
| **Backups** | Nothing here. documentdb PostgreSQL holds all conversations and is not rebuildable. |
| **HA** | Single replica each. Fine for a pilot, not for production. |
| **Resources** | Requests/limits are starting points, not measured. |

## One open architectural decision

**The documentdb image already ships pgvector 0.8.1** — newer than the dedicated
pgvector image's 0.8.0 — because documentdb requires it. A vector distance query
was confirmed working in that database.

So **one PostgreSQL could serve both** FerretDB and RAG, removing a stateful
component. Kept separate here for blast radius (a runaway embedding job should
not degrade the application database), differing backup requirements (the vector
store is rebuildable, conversations are not), and because separate is the shape
upstream tests. If UUH's storage quota or DBA capacity makes two instances a
problem, collapsing is viable and now known to work — a Jason conversation.
