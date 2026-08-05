# UUH LibreChat stack (CWORK-1107)
# Run from anywhere: make -C deploy/uuh <target>

ROOT := $(shell git rev-parse --show-toplevel)
COMPOSE := docker compose -f $(ROOT)/docker-compose.yml -f $(ROOT)/deploy/uuh/docker-compose.uuh.yml

.PHONY: up down restart ps logs verify upstream-drift query-set test

up:
	cd $(ROOT) && $(COMPOSE) up -d

down:
	cd $(ROOT) && $(COMPOSE) down

restart:
	cd $(ROOT) && $(COMPOSE) up -d --force-recreate

ps:
	cd $(ROOT) && $(COMPOSE) ps

logs:
	cd $(ROOT) && $(COMPOSE) logs -f --tail=100

## verify — the CWORK-1107 acceptance checks, re-runnable
verify:
	@echo "── services ──"
	@cd $(ROOT) && $(COMPOSE) ps --format '{{.Name}}\t{{.Status}}'
	@echo "── stock mongo must be absent ──"
	@docker ps -a --filter name=chat-mongodb --format '{{.Names}}' | grep -q . \
		&& echo "FAIL: stock mongodb is present" || echo "ok: no mongodb container"
	@echo "── librechat http ──"
	@curl -s -o /dev/null -w "  GET / -> %{http_code}\n" http://localhost:3080/
	@echo "── ferretdb -> postgres ──"
	@docker exec ferretdb-postgres psql -U ferretdb -d postgres -tAc \
		"SELECT 'collections in LibreChat: '||count(*) FROM documentdb_api_catalog.collections WHERE database_name='LibreChat';"
	@echo "── pgvector ──"
	@docker exec vectordb psql -U myuser -d mydatabase -tAc \
		"SELECT 'pgvector '||extversion FROM pg_extension WHERE extname='vector';"

## query-set — validate the CWORK-1108 demo query set contract
query-set:
	@uv run --quiet --with pyyaml $(ROOT)/deploy/uuh/demo/validate_query_set.py

## test — query-set contract + proof the validator actually has teeth
test: query-set
	@bash $(ROOT)/deploy/uuh/demo/mutation_test.sh

## upstream-drift — our changes must stay confined to deploy/uuh
upstream-drift:
	@git -C $(ROOT) fetch upstream --quiet
	@echo "Files we changed outside deploy/uuh (should be none):"
	@git -C $(ROOT) diff upstream/main --name-only -- . ':!deploy/uuh' || true
