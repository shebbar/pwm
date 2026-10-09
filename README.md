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
- [backend/src/tools.ts](backend/src/tools.ts) — a typed tool layer (zod schemas + handlers) wrapping the engine: `get_portfolio`, `get_buckets`, `get_expenses`, `run_projection` (read), `update_assumption`, `add_expense` (write). Framework-agnostic — it's what the agent calls today, and what an MCP server would import if built later.
- [backend/src/agent.ts](backend/src/agent.ts) — the reason→act→observe loop: streams Claude's response, executes tool calls through `tools.ts`, re-validates every argument against the tool's own schema, loops until a final answer. Only read-only tools are offered to the model — writes require an approval UI that doesn't exist yet, so they're not reachable from chat at all, not just discouraged.
- `agent_runs` table — one row per chat request: model, full tool-call trace, token usage, success/error. The audit log used throughout development to diagnose agent behavior.

## Project structure

```
backend/
  src/
    routes/api.ts       REST + chat endpoints
    data.ts              DB access
    projection.ts         projection engine (pure functions)
    tools.ts               agent tool layer
    agent.ts                 Claude tool-calling loop
    config.ts                  env-driven config (model, token/iteration caps)
    migrations/                 numbered SQL migrations, re-run idempotently on boot
    tools.smoke.ts                manual smoke test for the tool layer
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
docker network create pwm-net || true
docker compose -f ~/systems/postgres/docker-compose.yml up -d   # or however you run Postgres
docker compose up --build
```

Dashboard: http://localhost:3000 — API: http://localhost:4000

### Environment variables

Set these in a repo-root `.env` (gitignored; `docker compose` reads it automatically) and/or `backend/.env` if running the backend outside Docker:

| Variable | Where | Purpose |
|---|---|---|
| `DATABASE_URL` | root `.env` | Overrides the default Postgres connection string in `docker-compose.yml` |
| `PORTFOLIO_LLM_API_KEY` | root `.env` | Claude Platform API key for the chat agent. **Not** `ANTHROPIC_API_KEY` — that name gets picked up by Claude Code itself and bills against the wrong account. |
| `PORTFOLIO_LLM_MODEL` | root `.env` | Defaults to `claude-haiku-4-5-20251001`. Swap to `claude-sonnet-5` for harder questions — costs more and needs a larger `AGENT_MAX_TOKENS_PER_CALL` since thinking tokens share the same budget. |
| `AGENT_MAX_ITERATIONS` | optional | Caps tool-calling loop rounds (default 6). |
| `AGENT_MAX_TOKENS_PER_CALL` | optional | Per-API-call token budget (default 4096). |

The API key stays backend-only — the frontend never sees it; chat requests go through the Express server.

### Useful commands

```bash
cd backend && npm run migrate       # apply migrations without starting the server
cd backend && npm run tools:smoke   # exercise every agent tool against live data (read tools + a safe write round-trip)
```

## Status

Working: projection engine, admin screen, dashboard, a what-if chat agent (read-only tools, audit-logged, SSE-streamed). Not yet built: a write-tool approval UI (so the agent could eventually update assumptions or add expenses directly), evals (golden questions with known answers, run on every prompt/model change), scheduled/unattended agents, and multi-agent patterns (e.g. an assumption critic that verifies the first agent's claims).

## License

MIT — see [LICENSE](LICENSE).
