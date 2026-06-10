import "dotenv/config";
import cors from "cors";
import express from "express";
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
