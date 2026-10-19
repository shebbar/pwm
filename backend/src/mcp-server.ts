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
 * Bearer-token auth: a single shared secret (MCP_AUTH_TOKEN), checked with a
 * timing-safe comparison. Not OAuth -- OAuth 2.1 is MCP's own recommended
 * mechanism, but it's real infrastructure (authorization server, client
 * registration, token issuance) built for multi-client/multi-user servers.
 * This one only ever has one possible caller, so a shared secret gives the
 * same practical protection without standing up machinery for a problem
 * that doesn't exist here.
 */
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { safeTokenEqual } from "./auth.js";
import { MCP_AUTH_TOKEN } from "./config.js";
import { initDatabase } from "./db.js";
import { tools } from "./tools.js";

// Read tools are safe for any MCP client. Propose tools only ever stage a
// pending_actions row (see tools.ts) -- they never write the real tables,
// so they're exposed here too; the actual write happens through this app's
// own /api/actions/:id/approve, not through MCP. "write" tools
// (update_assumption/add_expense) are deliberately never exposed over MCP
// at all -- not even to this app's own agent, which only reaches them
// indirectly via the approval endpoint. Until Phase 2 adds scoped tokens,
// any MCP client with the one shared token (e.g. Claude Desktop) can call
// propose tools same as the in-app agent can.
const MCP_TOOLS = tools.filter((t) => t.kind === "read" || t.kind === "propose");

function buildServer(): McpServer {
  const server = new McpServer({ name: "pwm", version: "1.0.0" });

  for (const tool of MCP_TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (parsedInput: unknown) => {
        try {
          const output = await tool.handler(parsedInput);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(output) }],
          };
        } catch (err) {
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
  if (!MCP_AUTH_TOKEN) {
    throw new Error(
      "MCP_AUTH_TOKEN is not set -- refusing to start unauthenticated. " +
        "Generate one (e.g. `openssl rand -hex 32`) and set it in your .env."
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
    if (scheme !== "Bearer" || !token || !safeTokenEqual(token, MCP_AUTH_TOKEN)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  });

  app.post("/mcp", async (req, res) => {
    const server = buildServer();
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
    console.log(`Tools exposed: ${MCP_TOOLS.map((t) => t.name).join(", ")}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
