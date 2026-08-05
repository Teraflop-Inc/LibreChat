# FerretDB verification — CWORK-1112

**Verdict: GREEN, with one open risk that is not yet characterised.**

The ticket asked for "green or red, in writing." This is green: every compatibility
concern it named was tested and passed. The one thing that did *not* pass is a
defect found during CWORK-1110 that is not in the ticket's test plan and that I
could not reproduce synthetically — it is stated as an open risk rather than
buried.

## The ticket's five steps

| Step | Result |
|---|---|
| **1.** Run the in-repo FerretDB jest suite | **96 / 97 pass.** The single failure is a stale assertion in LibreChat's own test, not a FerretDB defect — proof below |
| **2.** Boot and watch for `Index build failed` | **Pass**, but the naive check is vacuous — see the `autoIndex` finding below. Index creation across all 29 models, sequential *and* concurrent, passes inside the suite |
| **3.** Two OAuth registrations → 4 partial unique indexes | **Pass.** Proven directly rather than via OAuth (no provider credentials): all 8 OAuth partial+unique indexes create, report accurately, and **enforce** |
| **4.** Share an agent → `$bit` ACL write path | **Pass.** All four bit operations correct, including the combined or+and path |
| **5.** Upload a file, send a message, reload history | **Pass** — exercised continuously throughout M1 (CWORK-1107 → 1110) |

## Step 1 — the jest suite

```
FERRETDB_URI="mongodb://ferretdb:ferretdb@127.0.0.1:27020/test_db" \
PG_CONTAINER=ferretdb-postgres \
  npx jest --config misc/ferretdb/jest.ferretdb.config.mjs --testTimeout=300000 --runInBand

Test Suites: 1 failed, 8 passed, 9 total
Tests:       1 failed, 96 passed, 97 total
```

Getting there required separating four layers of noise from actual results:

1. **Missing babel plugin** (`babel-plugin-replace-ts-export-assignment`) — 9 suites
   failed to load, 0 tests ran. Toolchain.
2. **`librechat-data-provider` not built** — 4 suites could not resolve it. Built it.
3. **`PG_CONTAINER` mismatch** — the spec hardcodes `librechat-ferretdb-postgres-1`;
   ours is `ferretdb-postgres`. The `psql()` helper **swallows the error and returns
   `''`**, so `parseInt('') || 0` made every DocumentDB-catalog assertion read zero.
   Four tests failed looking exactly like FerretDB returning no data. It is an
   env var, documented in the spec's own header.
4. **Stale `projectSchema` import** — see below.

None of those four were FerretDB. A less careful run would have reported red.

### The 3 suites that could not run: an upstream bug, not FerretDB

`multiTenancy`, `orgOperations`, and `sharding` all import `projectSchema` and
register it as `Project`. That schema **does not exist** — `git log -S` shows PR
**#11773 "Remove Deprecated Project Model and Associated Fields"** deleted it, and
these three specs were never updated. `conn.model('Project', undefined)` throws
`MissingSchemaError`. **They fail identically against real MongoDB.**

Temporarily removing the two stale lines took the suite from 69/97 to **92/97**,
and fixing `PG_CONTAINER` took it to **96/97**. (The spec edits were reverted; this
repo has zero drift outside `deploy/uuh/`.)

### The 1 remaining failure: a stale number, not a defect

```
● Phase 2: Index Initialization › verifies sparse, partial, and TTL index types
  expect(sparseCount).toBeGreaterThanOrEqual(8)
  Expected: >= 8    Received: 1
```

The User schema declares exactly **one** `sparse: true` index (`idOnTheSource`).
The magic number 8 matches the **8 OAuth id fields** — `googleId`, `facebookId`,
`openidId`, `samlId`, `ldapId`, `githubId`, `discordId`, `appleId` — which upstream
migrated from `sparse` to `partialFilterExpression` without updating the assertion.

FerretDB reporting 1 sparse index is **correct**. Verified by building the real
schema's indexes directly:

```
created:          8 partial+unique OAuth indexes + 1 sparse
FerretDB reports: partial=8 unique=8 sparse=1 total=10
```

## Step 3 — partial unique indexes, the ticket's #1 risk

The ticket flags these as the top risk because failures are *silent* — uniqueness
quietly unenforced with no trace. Tested end to end:

```
1. CREATE partial+unique index : OK
2. reported back              : unique=true partial={"googleId":{"$exists":true}}
3. ENFORCE uniqueness         : OK (duplicate rejected)
4. partial filter exempts nulls: OK (two docs without googleId allowed)
```

Creates, reports accurately, **enforces**, and correctly exempts documents lacking
the field. The #1 risk does not reproduce.

## Step 4 — the `$bit` ACL write path

`aclEntry.ts:464` issues `$bit: { permBits: { or: addBits } }`, and `and: ~removeBits`
to revoke. Against FerretDB:

```
1. $bit OR  0b0101 -> 5   ✓
2. $bit OR  0b1010 -> 15  ✓
3. $bit AND ~0b0100 -> 11 ✓
4. combined or+and -> 14  ✓
```

## ⚠️ Deployment gap (not FerretDB, but blocks production)

**LibreChat runs with `autoIndex: false` and `autoCreate: false`.** No index build is
ever attempted at startup — which is *why* the `Index build failed` listener never
fires, and why step 2's naive check is vacuous.

Our entire M1 demo ran with `users` holding exactly one index (`_id_`): **zero unique
constraints, zero performance indexes**. Uniqueness was unenforced the whole time.

This is engine-independent — it would be equally true on MongoDB — but it means
**something must create indexes at deploy time**. That belongs in CWORK-1115 (Helm
chart), and it should be verified there rather than assumed.

## ⚠️ OPEN RISK — document bloat, observed but not characterised

Found in CWORK-1110, **not covered by this ticket's five steps**, and I could not
reproduce it synthetically.

What is certain, because it was measured on the live demo agent:

| | |
|---|---|
| logical document | 9,252 B |
| physical row (`pg_column_size`) | **189,725 B** — 20× |
| size documentdb computed for the update | **32,517,923 B** — 3,500× |

`findAndModify` on that document failed permanently until the document was
rewritten; rewriting identical content collapsed the row to **3,082 B** and
unblocked it immediately.

**What I could not do is reproduce it.** Aging a document 40–60 rounds with
faithfully growing version snapshots produced *healthy* rows on FerretDB —
1,957 B physical for a 58,168 B logical document, i.e. TOAST compressing normally
— and stock MongoDB behaved identically. So:

- the trigger is **more specific than update count**, and involves something in
  LibreChat's real update path that synthetic replay does not capture;
- **I cannot yet say this is FerretDB-specific.** The earlier A/B on an identical
  document and update passed on both engines, and so does aged synthetic replay;
- consequently **nothing here predicts which documents are at risk**, which is the
  part that matters operationally.

⚠️ Any further investigation must reproduce through the **application**, not by
replaying statements. Every statement-level reproduction attempted so far — single
update, aged replay, both engines — has come back clean and would wrongly exonerate.

## Recommendation

**Proceed with FerretDB.** Every compatibility risk this ticket named is closed:
partial unique indexes enforce, `$bit` works, index creation across all 29 models
succeeds sequentially and concurrently, and 96/97 of upstream's own FerretDB suite
passes with the single failure proven stale. The licensing and domicile argument
that made FerretDB attractive is untouched — Apache-2.0, data in their own Postgres,
Postgres ops skills they already have.

Two items must not be dropped:

1. **Index creation at deploy time** (CWORK-1115) — currently nothing creates them.
2. **The bloat risk** — real and observed, but unpredictable until someone
   reproduces it through the app. It should be raised with UUH as a known
   operational unknown with a known remedy (document rewrite), not presented as
   solved.

## Reproducing

```bash
cd packages/data-schemas
npm install --no-audit --no-fund --legacy-peer-deps
( cd ../data-provider && npm install --legacy-peer-deps && npm run build )
FERRETDB_URI="mongodb://ferretdb:ferretdb@127.0.0.1:27020/test_db" \
PG_CONTAINER=ferretdb-postgres \
  npx jest --config misc/ferretdb/jest.ferretdb.config.mjs --testTimeout=300000 --runInBand
```

Expect 96/97, the failure being the stale `sparseCount >= 8` assertion.
