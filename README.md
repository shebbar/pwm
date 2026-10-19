# PWM — Personal Wealth Management

A retirement/net-worth projection app for the owner's own finances (amounts in ₹ Lakhs). You enter investment buckets, inflation, and planned cash flows; a deterministic engine projects your corpus year by year and tells you whether — and when — it runs out. A chat-based agent sits on top of the same engine so you can ask what-if questions in plain English instead of editing the plan directly.

## Stack

- **Backend**: Express + TypeScript + Postgres (`pg`), zod for validation
- **Frontend**: Next.js (App Router) + Tailwind
- **Agent**: `@anthropic-ai/sdk`, calling Claude with a typed tool layer over the same projection engine the dashboard uses
- **Infra**: Docker Compose, Postgres in its own container (`pgdb`) on an external `pwm-net` network

## How it works

- [backend/src/projection.ts](backend/src/projection.ts) — the only place that does math. `buildProjection` walks year by year, nets out flows/lump sums/SWP withdrawals, compounds each investment bucket at its own real (inflation-adjusted) return. Pure, deterministic, no I/O.
- [backend/src/data.ts](backend/src/data.ts) — all Postgres reads/writes.
- [backend/src/routes/api.ts](backend/src/routes/api.ts) — REST API the dashboard/admin screen use (`GET/PUT /api/settings`, `GET /api/projection`) plus the chat endpoint (`POST /api/chat`, streamed over SSE).
- [backend/src/tools.ts](backend/src/tools.ts) — a typed tool layer (zod schemas + handlers) wrapping the engine: `get_portfolio`, `get_buckets`, `get_expenses`, `run_projection` (read), `update_assumption`, `add_expense` (write). Only [backend/src/mcp-server.ts](backend/src/mcp-server.ts) imports this directly anymore — it's the single place that owns which tools exist and which ones are exposed.
- [backend/src/mcp-server.ts](backend/src/mcp-server.ts) — an MCP server over Streamable HTTP (bearer-token auth), exposing the read-only tools to any MCP client: Claude Desktop, this app's own in-house chat agent, or anything else that speaks MCP. A separate deployable service on purpose — different trust boundary than a trusted internal caller, own scaling/latency profile.
- [backend/src/agent.ts](backend/src/agent.ts) — the reason→act→observe loop for the in-app chat: gets an `LlmProvider` from `llm/registry.ts`, calls tools via an MCP *client* connection to `mcp-server.ts` (not a direct import), loops until a final answer. It knows nothing about Postgres, the projection engine, or any specific LLM vendor's SDK — only the canonical types in `llm/types.ts` and how to talk to an MCP server.
- [backend/src/llm/](backend/src/llm/) — the model-choice abstraction, one subdirectory per vendor. `types.ts` defines a vendor-agnostic `LlmProvider` interface (canonical message/tool/content types, with an `"opaque"` block type so vendor-specific extras like Anthropic's extended-thinking blocks can round-trip without leaking into the interface); `registry.ts` resolves the active model entirely from the `llm_models` DB table (no env var) and dispatches to a `vendor → factory` map. `llm/anthropic/provider.ts` is the one implementation (two `llm_models` rows use it, deliberately treated as separate vendors); `llm/anthropic/models.ts` holds tested `max_tokens` defaults per model ID **in code, not the DB** — that number is a tested fact (e.g. Sonnet's extended thinking silently exhausted a too-small budget during development), not something a catalog entry should let someone guess at. A real second vendor (OpenAI, etc.) means one new `llm/<vendor>/` directory and one registry entry — `agent.ts` doesn't change either way.
- `llm_models` table + `GET/POST /api/llm-models`, `PUT /api/llm-models/:id/activate`, `DELETE /api/llm-models/:id` — the catalog of available models and which one is active, editable live (admin screen has a dropdown + add/remove list) with zero redeploy, e.g. to fail over during a vendor outage. Adding a model here only wires up routing/labeling; it still needs a tested entry in `llm/anthropic/models.ts` before it's safe to activate (activating one without that entry fails loudly, not silently).
- `agent_runs` table — one row per chat request: which provider actually served it (dynamic, not a fixed config value), full tool-call trace, token usage, success/error. The audit log used throughout development to diagnose agent behavior.

## Project structure

```
backend/
  src/
    routes/api.ts       REST + chat endpoints
    data.ts              DB access
    projection.ts         projection engine (pure functions)
    tools.ts               agent tool layer
    agent.ts                 tool-calling loop (in-app chat), vendor-agnostic
    llm/                        model-choice abstraction
      types.ts                     canonical provider interface
      registry.ts                  DB-driven model resolution (vendor -> factory)
      anthropic/                   one subdir per vendor
        provider.ts                   LlmProvider impl
        models.ts                     tested max_tokens defaults (code, not DB)
    mcp-server.ts                  MCP server over Streamable HTTP (external clients)
    config.ts                         env-driven config (iteration cap, secrets)
    migrations/                    numbered SQL migrations, re-run idempotently on boot
    tools.smoke.ts                   manual smoke test for the tool layer
    evals.ts                           golden-question regression suite for the agent
frontend/
  app/
    page.tsx              dashboard
    admin/                 edit buckets, flows, lump sums, SWP, assumptions
    growth/                  projection chart
    ChatPanel.tsx              what-if chat UI
  lib/api.ts                    typed API client
docker-compose.yml
```

## Running locally

This expects a Postgres container named `pgdb` already running on an external `pwm-net` Docker network (see the comment block at the top of `docker-compose.yml`):

```bash
cp .env.example .env   # fill in PORTFOLIO_LLM_API_KEY and MCP_AUTH_TOKEN
docker network create pwm-net || true
docker compose -f ~/systems/postgres/docker-compose.yml up -d   # or however you run Postgres
docker compose up --build
cd backend && npm run seed:demo   # loads a fictional portfolio so there's data to look at
```

Dashboard: http://localhost:3000 — API: http://localhost:4000 — MCP server: http://localhost:4100/mcp

### Environment variables

Set these in a repo-root `.env` (gitignored; `docker compose` reads it automatically) and/or `backend/.env` if running the backend outside Docker:

| Variable | Where | Purpose |
|---|---|---|
| `DATABASE_URL` | root `.env` | Overrides the default Postgres connection string in `docker-compose.yml` |
| `PORTFOLIO_LLM_API_KEY` | root `.env` | Claude Platform API key for the chat agent. **Not** `ANTHROPIC_API_KEY` — that name gets picked up by Claude Code itself and bills against the wrong account. |
| `AGENT_MAX_ITERATIONS` | optional | Caps tool-calling loop rounds (default 6). |
| `MCP_PORT` | optional | Port the MCP server listens on (default 4100). |
| `MCP_AUTH_TOKEN` | root `.env` | Shared secret for the MCP server. Required — it refuses to start without one. Generate with `openssl rand -hex 32`. Both `mcp-server.ts` (checks it) and `agent.ts` (sends it as a client) need this same value. |
| `MCP_SERVER_URL` | optional | Where `agent.ts` reaches the MCP server (default `http://mcp:4100/mcp`, the Docker service name — not `localhost`, since this crosses a container boundary). |

The API key stays backend-only — the frontend never sees it; chat requests go through the Express server, which in turn reaches the MCP server as a client of its own (not a direct import) — see "How it works" above.

There's deliberately no env var for which model is active — that's entirely DB-driven via the `llm_models` table, editable from the admin screen or `PUT /api/llm-models/:id/activate`, so it can change with zero redeploy.

### Useful commands

```bash
cd backend && npm run migrate       # apply migrations without starting the server
cd backend && npm run seed:demo     # wipe the portfolio tables and load a fictional demo portfolio
cd backend && npm run tools:smoke   # exercise every agent tool against live data (read tools + a safe write round-trip)
cd backend && npm run evals         # golden-question regression suite against the real Claude API (costs credits)
cd backend && npm run mcp           # run the MCP server standalone, outside Docker (dev mode)
```

## Status

Working: projection engine, admin screen, dashboard, a what-if chat agent (read-only tools via an MCP client connection, audit-logged, SSE-streamed), an eval suite (golden questions tied to real regressions, run manually against the live API), a bearer-token-authenticated MCP server over Streamable HTTP that both the in-app agent and external clients (Claude Desktop) call into, a model-choice abstraction (`llm/`) with a DB-driven catalog of available models, editable from the admin screen with zero redeploy to switch, and a demo seed (`npm run seed:demo`) so a fresh clone has a fictional portfolio to run the app/evals against without any real financial data in the repo. Not yet built: a write-tool approval UI (so the MCP server could expose `update_assumption`/`add_expense` to a client that can handle per-call confirmation), a real second LLM vendor (the abstraction currently has two configs of the same vendor, deliberately treated as separate ones to prove the interface), scheduled/unattended agents, and multi-agent patterns (e.g. an assumption critic that verifies the first agent's claims).

## License

MIT — see [LICENSE](LICENSE).
