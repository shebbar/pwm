import "dotenv/config";
import cors from "cors";
import express from "express";
import { ACTIONS_AUTH_TOKEN } from "./config.js";
import { initDatabase, pool } from "./db.js";
import { apiRouter } from "./routes/api.js";

const app = express();
const port = Number(process.env.PORT) || 4000;

app.use(cors({ origin: true }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api", apiRouter);

app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
);

async function main() {
  await initDatabase();
  if (!ACTIONS_AUTH_TOKEN) {
    // Not fatal (unlike mcp-server.ts's MCP_AUTH_TOKEN check) -- the rest
    // of the app works fine without it, only /api/actions/* 500s.
    console.warn(
      "ACTIONS_AUTH_TOKEN is not set -- /api/actions/* (approve/reject proposals) will return 500."
    );
  }
  app.listen(port, () => {
    console.log(`PWM API listening on http://localhost:${port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

process.on("SIGTERM", () => {
  void pool?.end();
});
