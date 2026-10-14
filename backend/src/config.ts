/**
 * Deliberately NOT named ANTHROPIC_API_KEY: Claude Code reads that variable
 * from the shell and would bill this app's usage against your Pro login
 * instead of using Pro. Keep it namespaced to this app and backend-only.
 */
export const LLM_API_KEY = process.env.PORTFOLIO_LLM_API_KEY ?? "";

// Which model is active lives entirely in the llm_models DB table now (see
// llm/registry.ts), not an env var -- editable live via
// PUT /api/llm-models/:id/activate, no redeploy needed.

export const AGENT_MAX_ITERATIONS = Number(process.env.AGENT_MAX_ITERATIONS ?? 6);

// Per-model max_tokens defaults live in code (llm/anthropic/models.ts,
// etc.) as tested facts, not env-configurable -- see that file for why.

// No default on purpose -- mcp-server.ts refuses to start without this set,
// rather than silently running unauthenticated.
export const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN ?? "";

// Where agent.ts reaches the MCP server as a client. Docker service name,
// not localhost -- this crosses a container boundary.
export const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? "http://mcp:4100/mcp";
