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

// Two scoped tokens instead of one shared secret -- whichever token a
// caller presents IS its scope (no identity/role lookup layer; see the
// README for why a bearer-capability model is proportionate for a small
// fixed set of known callers). MCP_READ_TOKEN grants read-only tools;
// MCP_PROPOSE_TOKEN grants read + propose tools (a strict superset, not a
// separate disjoint scope). No defaults on purpose -- mcp-server.ts
// refuses to start unless both are set, rather than silently running with
// only one scope available.
export const MCP_READ_TOKEN = process.env.MCP_READ_TOKEN ?? "";
export const MCP_PROPOSE_TOKEN = process.env.MCP_PROPOSE_TOKEN ?? "";

// Where agent.ts reaches the MCP server as a client. Docker service name,
// not localhost -- this crosses a container boundary.
export const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? "http://mcp:4100/mcp";

// How long a proposed action stays approvable before it lazily expires.
export const PENDING_ACTION_TTL_MINUTES = Number(
  process.env.PENDING_ACTION_TTL_MINUTES ?? 30
);

// Separate secret from the MCP tokens on purpose -- this guards a
// different trust boundary (the chat UI's own approve/reject calls, made
// from a browser) rather than an MCP client connection. No default: the
// approve/reject/list endpoints refuse to work without one set, same
// philosophy as the MCP tokens.
export const ACTIONS_AUTH_TOKEN = process.env.ACTIONS_AUTH_TOKEN ?? "";
