/**
 * MCP server over Streamable HTTP (stateless -- each request gets its own
 * short-lived McpServer + transport pair, per the SDK's own recommended
 * pattern for stateless servers).
 *
 * This is a separate deployable unit from the Express API/chat agent on
 * purpose: it has a different trust boundary (meant for external MCP
 * clients like Claude Desktop, not just our own frontend) and a different
 * scaling/latency profile. It imports the same tools.ts/data.ts the chat
 * agent uses -- no business logic is duplicated, only the transport differs.
 *
 * Bearer-token auth with two scoped tokens (MCP_READ_TOKEN,
 * MCP_PROPOSE_TOKEN), checked with a timing-safe comparison. Whichever
 * token a caller presents IS its scope -- there's no identity/role lookup
 * layer, since there's no concept of distinct users here, just a small
 * fixed set of known callers (this app's own agent, Claude Desktop). Not
 * OAuth -- OAuth 2.1 is MCP's own recommended mechanism, but it's real
 * infrastructure (authorization server, client registration, token
 * issuance, per-user revocation) built for many-user servers. This one
 * has at most a handful of callers, so static scoped secrets give the
 * same practical protection without standing up machinery for a problem
 * that doesn't exist here.
 */
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { safeTokenEqual } from "./auth.js";
import { MCP_PROPOSE_TOKEN, MCP_READ_TOKEN } from "./config.js";
import { initDatabase } from "./db.js";
import { tools, type ToolKind } from "./tools.js";

type McpScope = "read" | "read+propose";

// read+propose is a strict superset of read, not a separate disjoint set --
// mirrors the tokens themselves (MCP_PROPOSE_TOKEN grants everything
// MCP_READ_TOKEN does, plus propose tools). "write" tools
// (update_assumption/add_expense) are never exposed over MCP at all, at
// any scope -- not even to this app's own agent, which only reaches them
// indirectly via the approval endpoint.
const SCOPE_TOOL_KINDS: Record<McpScope, ToolKind[]> = {
  read: ["read"],
  "read+propose": ["read", "propose"],
};

function toolsForScope(scope: McpScope) {
  const kinds = SCOPE_TOOL_KINDS[scope];
  return tools.filter((t) => kinds.includes(t.kind));
}

// Scoping a tool out of a given request's server means it's absent from
// BOTH tools/list (can't be seen) and tools/call (calling it by name gets
// the SDK's own "unknown tool" error, indistinguishable from it not
// existing) -- one mechanism satisfies both halves of "a read token
// cannot list or call proposal tools."
function buildServer(scope: McpScope): McpServer {
  const server = new McpServer({ name: "pwm", version: "1.0.0" });

  for (const tool of toolsForScope(scope)) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (parsedInput: unknown) => {
        try {
          const output = await tool.handler(parsedInput);
          console.log(`[mcp] scope=${scope} tool=${tool.name} -> ok`);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(output) }],
          };
        } catch (err) {
          console.log(`[mcp] scope=${scope} tool=${tool.name} -> error`);
          return {
            content: [
              {
                type: "text" as const,
                text: err instanceof Error ? err.message : "Tool failed",
              },
            ],
            isError: true,
          };
        }
      }
    );
  }

  return server;
}

const PORT = Number(process.env.MCP_PORT ?? 4100);

function jsonRpcError(code: number, message: string) {
  return { jsonrpc: "2.0" as const, error: { code, message }, id: null };
}

async function main(): Promise<void> {
  if (!MCP_READ_TOKEN || !MCP_PROPOSE_TOKEN) {
    throw new Error(
      "MCP_READ_TOKEN and MCP_PROPOSE_TOKEN must both be set -- refusing to start " +
        "unauthenticated or with only one scope available. Generate each with " +
        "`openssl rand -hex 32` and set them in your .env."
    );
  }

  await initDatabase();

  // Binding 0.0.0.0 so other containers on pwm-net can reach it -- this
  // disables the SDK's automatic localhost DNS-rebinding protection (it
  // only applies for 127.0.0.1/localhost/::1). Acceptable since this stays
  // inside the Docker network (not exposed to the internet) and is now
  // behind the bearer-token check below as well.
  const app = createMcpExpressApp({ host: "0.0.0.0" });

  app.use("/mcp", (req, res, next) => {
    const header = req.header("authorization") ?? "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    // Checked in this order so a propose-scoped caller resolves to the
    // wider scope rather than accidentally matching as read-only -- not
    // that both could ever match at once (they're different random
    // strings), just keeps the resolution order explicit.
    if (safeTokenEqual(token, MCP_PROPOSE_TOKEN)) {
      res.locals.mcpScope = "read+propose" satisfies McpScope;
    } else if (safeTokenEqual(token, MCP_READ_TOKEN)) {
      res.locals.mcpScope = "read" satisfies McpScope;
    } else {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  });

  app.post("/mcp", async (req, res) => {
    const scope = res.locals.mcpScope as McpScope;
    const server = buildServer(scope);
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        transport.close();
        server.close();
      });
    } catch (err) {
      console.error("Error handling MCP request:", err);
      if (!res.headersSent) {
        res.status(500).json(jsonRpcError(-32603, "Internal server error"));
      }
    }
  });

  app.get("/mcp", (_req, res) => {
    res.writeHead(405).end(JSON.stringify(jsonRpcError(-32000, "Method not allowed.")));
  });

  app.delete("/mcp", (_req, res) => {
    res.writeHead(405).end(JSON.stringify(jsonRpcError(-32000, "Method not allowed.")));
  });

  app.listen(PORT, () => {
    console.log(`MCP server (Streamable HTTP) listening on http://0.0.0.0:${PORT}/mcp`);
    console.log(`read scope tools: ${toolsForScope("read").map((t) => t.name).join(", ")}`);
    console.log(
      `read+propose scope tools: ${toolsForScope("read+propose").map((t) => t.name).join(", ")}`
    );
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
