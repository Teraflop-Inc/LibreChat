#!/usr/bin/env python3
"""Load the UUH corpus and measure retrieval against the CWORK-1108 questions.

CWORK-1109's done-when is "the CWORK-1108 questions each retrieve their target
document", and it deliberately leaves chunking to be chosen *empirically from
measured retrieval performance* rather than hand-designed. This is the thing
that measures it.

Two modes:

  load    embed every corpus document into pgvector via the RAG API sidecar
  test    run each question through /query_multiple and check whether the
          documents that question depends on actually come back

Chunking is env-level on the rag_api container (the /embed endpoint takes no
per-request override), so a sweep restarts rag_api per configuration. See
chunk_sweep.sh.

Run:
  uv run --with pyyaml,requests deploy/uuh/demo/rag_harness.py load
  uv run --with pyyaml,requests deploy/uuh/demo/rag_harness.py test
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import subprocess
import sys
import time
from pathlib import Path

import requests
import yaml

HERE = Path(__file__).parent
CORPUS = HERE / "corpus"
QUERY_SET = HERE / "query-set.yaml"
REPO = HERE.parent.parent.parent
ENV = REPO / ".env"

RAG = "http://127.0.0.1:8000"          # inside the rag_api container
CONTAINER = "rag_api"


# ── auth ──────────────────────────────────────────────────────────────
def jwt_for(user_id: str = "uuh-harness") -> str:
    """RAG API authenticates with a JWT signed by the shared JWT_SECRET."""
    secret = ""
    for line in ENV.read_text().splitlines():
        if line.startswith("JWT_SECRET="):
            secret = line.split("=", 1)[1].strip()
            break
    if not secret:
        sys.exit("JWT_SECRET not found in .env")

    def b64(d: bytes) -> bytes:
        return base64.urlsafe_b64encode(d).rstrip(b"=")

    head = b64(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = b64(
        json.dumps({"id": user_id, "exp": int(time.time()) + 3600}, separators=(",", ":")).encode()
    )
    sig = b64(hmac.new(secret.encode(), head + b"." + payload, hashlib.sha256).digest())
    return (head + b"." + payload + b"." + sig).decode()


def in_container(script: str, env: dict[str, str] | None = None) -> str:
    """Run python inside rag_api — it is not published to the host."""
    cmd = ["docker", "exec"]
    for k, v in (env or {}).items():
        cmd += ["-e", f"{k}={v}"]
    cmd += [CONTAINER, "python3", "-c", script]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"docker exec failed:\n{r.stderr}")
    return r.stdout


# ── corpus ────────────────────────────────────────────────────────────
def corpus_files() -> list[Path]:
    return sorted(CORPUS.glob("*.md"))


def doc_id(p: Path) -> str:
    """DN-04417.md -> DN-04417. file_id in the vector store is the doc id."""
    return p.stem


def load() -> int:
    files = corpus_files()
    if not files:
        print(f"FAIL: no corpus documents in {CORPUS}")
        return 1

    token = jwt_for()

    # Clear prior embeddings so a sweep measures this config, not an accumulation.
    ids = [doc_id(p) for p in files]
    in_container(
        "import requests,os,json;"
        "r=requests.delete('%s/documents',"
        "headers={'Authorization':'Bearer '+os.environ['TOK'],"
        "'Content-Type':'application/json'},json=json.loads(os.environ['IDS']));"
        "print(r.status_code)" % RAG,
        {"TOK": token, "IDS": json.dumps(ids)},
    )

    ok = 0
    for p in files:
        subprocess.run(
            ["docker", "cp", str(p), f"{CONTAINER}:/tmp/{p.name}"],
            capture_output=True,
            check=True,
        )
        out = in_container(
            "import requests,os;"
            "f=open('/tmp/'+os.environ['NAME'],'rb');"
            "r=requests.post('%s/embed',headers={'Authorization':'Bearer '+os.environ['TOK']},"
            "files={'file':(os.environ['NAME'],f,'text/markdown')},"
            "data={'file_id':os.environ['FID']});"
            "print(r.status_code)" % RAG,
            {"TOK": token, "NAME": p.name, "FID": doc_id(p)},
        ).strip()
        if out == "200":
            ok += 1
        else:
            print(f"  ! {doc_id(p)} embed returned {out}")

    print(f"loaded {ok}/{len(files)} documents")
    return 0 if ok == len(files) else 1


# ── retrieval measurement ─────────────────────────────────────────────
def query(token: str, q: str, file_ids: list[str], k: int) -> list[str]:
    """Return the doc ids retrieved, best-first, deduped."""
    out = in_container(
        "import requests,os,json;"
        "r=requests.post('%s/query_multiple',"
        "headers={'Authorization':'Bearer '+os.environ['TOK'],'Content-Type':'application/json'},"
        "json={'query':os.environ['Q'],'file_ids':json.loads(os.environ['IDS']),"
        "'k':int(os.environ['K'])});"
        "print(json.dumps(r.json()))" % RAG,
        {"TOK": token, "Q": q, "IDS": json.dumps(file_ids), "K": str(k)},
    )
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        return []

    seen: list[str] = []
    # Response shape is a list of [document, score] pairs.
    for item in data:
        doc = item[0] if isinstance(item, list) and item else item
        if not isinstance(doc, dict):
            continue
        fid = (doc.get("metadata") or {}).get("file_id")
        if fid and fid not in seen:
            seen.append(fid)
    return seen


def test(k: int = 8, agentic: bool = False) -> int:
    """Measure retrieval.

    single-shot (default): one embedding of the question as a user would type
    it. This is the honest baseline and it does NOT pass for the hero — see
    the retrieval_probes note in query-set.yaml.

    agentic: issue the question's retrieval_probes and union the results,
    modelling what an agent on the file_search path does. This is what the
    demo actually runs on.
    """
    if not corpus_files():
        print(f"FAIL: no corpus documents in {CORPUS} — nothing to retrieve")
        return 1

    spec = yaml.safe_load(QUERY_SET.read_text())
    token = jwt_for()
    all_ids = [doc_id(p) for p in corpus_files()]

    results = []
    failures = 0
    exempt = 0

    for q in spec["questions"]:
        targets = q.get("source_documents") or []

        if q.get("retrieval_exempt"):
            results.append((q["id"], None, "exempt — success is refusal, a generation "
                                           "property; verified in chat at CWORK-1110", []))
            exempt += 1
            continue

        probes = q.get("retrieval_probes") or []
        if agentic and probes:
            retrieved: list[str] = []
            for p in probes:
                for fid in query(token, p, all_ids, k):
                    if fid not in retrieved:
                        retrieved.append(fid)
            mode = f"{len(probes)} probes"
        else:
            retrieved = query(token, q["question"], all_ids, k)
            mode = "single-shot"

        # Q2 spans the whole corpus; scoring it on "did all 12 come back" would
        # measure k, not retrieval. Judge it on its top few instead.
        if len(targets) > 4:
            hit = sum(1 for t in targets if t in retrieved)
            passed = hit >= 3
            detail = f"{mode}: {hit}/{len(targets)} of a broad set (need >=3)"
        else:
            missing = [t for t in targets if t not in retrieved]
            passed = not missing
            detail = (f"{mode}: all targets retrieved" if passed
                      else f"{mode}: MISSING {missing}")

        results.append((q["id"], passed, detail, retrieved[:5]))
        if not passed:
            failures += 1

    label = "AGENTIC (multi-probe)" if agentic else "SINGLE-SHOT"
    print(f"retrieval @ k={k}  [{label}]  ({len(all_ids)} documents)\n")
    for qid, passed, detail, top in results:
        mark = "EXEMPT" if passed is None else ("PASS" if passed else "FAIL")
        print(f"  {mark:6s} {qid}")
        print(f"        {detail}")
        if top:
            print(f"        top: {', '.join(top)}")
    scored = len(results) - exempt
    print(f"\n{scored - failures}/{scored} scored questions retrieve their targets "
          f"({exempt} exempt)")
    return 1 if failures else 0


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "test"
    if mode == "load":
        return load()
    if mode in ("test", "test-agentic"):
        k = int(sys.argv[2]) if len(sys.argv) > 2 else 8
        return test(k, agentic=(mode == "test-agentic"))
    sys.exit("usage: rag_harness.py [load|test|test-agentic] [k]")


if __name__ == "__main__":
    sys.exit(main())
