/**
 * Manual test for MCP server scope enforcement (tsx src/mcp-server.smoke.ts).
 * Assumes the MCP server is already running and reachable at
 * MCP_SERVER_URL (dev: npm run mcp, or the mcp Docker service) -- connects
 * as different callers and asserts what each one can and can't do.
 *
 * Unlike tools.smoke.ts (diagnostic output only), this exits non-zero on
 * any failure -- these are security-boundary assertions (can a read token
 * reach a propose tool?), not just a sanity check, so a silent failure
 * here would be worse than a loud one.
 *
 * Run manually: npm run mcp:smoke (backend/)
 */
import "dotenv/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_PROPOSE_TOKEN, MCP_READ_TOKEN, MCP_SERVER_URL } from "./config.js";

type CheckResult = { name: string; pass: boolean; detail: string };
const results: CheckResult[] = [];

function record(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

async function connectWithToken(token: string | null): Promise<Client> {
  const client = new Client({ name: "mcp-scope-smoke-test", version: "1.0.0" });
  const headers: Record<string, string> = {};
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const transport = new StreamableHTTPClientTransport(new URL(MCP_SERVER_URL), {
    requestInit: { headers },
  });
  await client.connect(transport);
  return client;
}

async function expectConnectToFail(name: string, token: string | null): Promise<void> {
  try {
    const client = await connectWithToken(token);
    await client.close();
    record(name, false, "connect() succeeded, expected a 401");
  } catch (err) {
    record(name, true, `connect() rejected as expected: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  if (!MCP_READ_TOKEN || !MCP_PROPOSE_TOKEN) {
    throw new Error("MCP_READ_TOKEN and MCP_PROPOSE_TOKEN must both be set to run this test.");
  }

  await expectConnectToFail("no token at all is rejected", null);
  await expectConnectToFail("a garbage token is rejected", "not-a-real-token");

  const readClient = await connectWithToken(MCP_READ_TOKEN);
  try {
    const { tools: readTools } = await readClient.listTools();
    const names = readTools.map((t) => t.name);
    record(
      "read token's tools/list has read tools, no propose tools",
      names.includes("get_portfolio") && !names.some((n) => n.startsWith("propose_")),
      `tools: ${JSON.stringify(names)}`
    );

    try {
      const result = await readClient.callTool({
        name: "propose_update_assumption",
        arguments: { kind: "settings", field: "inflation_pct", value: 5 },
      });
      // A propose tool isn't registered at all on a read-scoped server.
      // The MCP client SDK surfaces that as a normal (non-throwing) result
      // with isError: true and a "Tool ... not found" message -- NOT a
      // thrown error -- so check isError rather than expecting a throw.
      // Either way, what matters is that the handler never ran (no
      // pending_actions row got created), not the exact delivery mechanism.
      record(
        "read token cannot call a propose tool",
        result.isError === true,
        `callTool result: ${JSON.stringify(result)}`
      );
    } catch (err) {
      record(
        "read token cannot call a propose tool",
        true,
        `callTool rejected as expected: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } finally {
    await readClient.close();
  }

  const proposeClient = await connectWithToken(MCP_PROPOSE_TOKEN);
  try {
    const { tools: proposeTools } = await proposeClient.listTools();
    const names = proposeTools.map((t) => t.name);
    record(
      "propose token's tools/list has both read and propose tools",
      names.includes("get_portfolio") && names.includes("propose_update_assumption"),
      `tools: ${JSON.stringify(names)}`
    );
  } finally {
    await proposeClient.close();
  }

  console.log("\nMCP scope enforcement checks:\n");
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}\n      ${r.detail}\n`);
  }
  const failed = results.filter((r) => !r.pass);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
