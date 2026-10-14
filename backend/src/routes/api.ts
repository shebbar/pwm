import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { runAgent } from "../agent.js";
import {
  activateLlmModel,
  addLlmModel,
  filterLumps,
  listLlmModels,
  loadFlows,
  loadInvestmentBuckets,
  loadLumpSumInflows,
  loadLumpSumOutgoes,
  loadSettings,
  loadSwpPlans,
  removeLlmModel,
} from "../data.js";
import { pool } from "../db.js";
import { listVendors } from "../llm/registry.js";
import { buildProjection } from "../projection.js";

const flowSchema = z.object({
  age: z.number().int().min(0).max(120),
  inflow_lakhs: z.number().finite().nonnegative(),
  outflow_lakhs: z.number().finite().nonnegative(),
});

const lumpSumSchema = z.object({
  age: z.number().int().min(0).max(120),
  amount_lakhs: z.number().finite().nonnegative(),
});

const swpPlanSchema = z
  .object({
    start_age: z.number().int().min(0).max(120),
    end_age: z.number().int().min(0).max(120),
    monthly_amount_lakhs: z.number().finite().nonnegative(),
  })
  .refine((p) => p.start_age <= p.end_age, {
    message: "start_age must be <= end_age",
    path: ["end_age"],
  });

const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

const chatRequestSchema = z.object({
  message: z.string().min(1),
  history: z.array(chatMessageSchema).default([]),
});

const addLlmModelSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/, "lowercase letters, numbers, hyphens only"),
  label: z.string().min(1).max(200),
  vendor: z.string().min(1),
  model_id: z.string().min(1),
});

const bucketSchema = z.object({
  name: z.string().max(200),
  corpus_lakhs: z.number().finite().nonnegative(),
  return_pct: z.number().finite(),
  asset_class: z.enum(["equity", "debt", "cash"]).default("equity"),
});

const putBodySchema = z.object({
  investment_buckets: z.array(bucketSchema).min(1),
  inflation_pct: z.number().finite(),
  start_age: z.number().int().min(18).max(100),
  end_age: z.number().int().min(18).max(120),
  flows: z.array(flowSchema),
  lump_sum_outgoes: z.array(lumpSumSchema).default([]),
  lump_sum_inflows: z.array(lumpSumSchema).default([]),
  swp_plans: z.array(swpPlanSchema).default([]),
});

export const apiRouter = Router();

// Each request spends LLM credits, so cap it even for a single-user app.
const chatLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

apiRouter.get("/settings", async (_req, res, next) => {
  try {
    const settings = await loadSettings();
    const investment_buckets = await loadInvestmentBuckets();
    const flows = await loadFlows();
    const lump_sum_outgoes = await loadLumpSumOutgoes();
    const lump_sum_inflows = await loadLumpSumInflows();
    const swp_plans = await loadSwpPlans();
    const projection = buildProjection(
      settings,
      investment_buckets,
      flows,
      lump_sum_outgoes,
      lump_sum_inflows,
      swp_plans
    );
    res.json({
      settings,
      investment_buckets,
      flows,
      lump_sum_outgoes,
      lump_sum_inflows,
      swp_plans,
      projection,
    });
  } catch (e) {
    next(e);
  }
});

apiRouter.put("/settings", async (req, res, next) => {
  const parsed = putBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const b = parsed.data;
  if (b.end_age < b.start_age) {
    res.status(400).json({ error: "end_age must be >= start_age" });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE app_settings SET
        inflation_pct = $1,
        start_age = $2,
        end_age = $3,
        updated_at = NOW()
       WHERE id = 1`,
      [b.inflation_pct, b.start_age, b.end_age]
    );
    await client.query(`DELETE FROM investment_buckets`);
    for (const bucket of b.investment_buckets) {
      await client.query(
        `INSERT INTO investment_buckets (name, corpus_lakhs, return_pct, asset_class) VALUES ($1, $2, $3, $4)`,
        [bucket.name, bucket.corpus_lakhs, bucket.return_pct, bucket.asset_class]
      );
    }
    await client.query(`DELETE FROM annual_flows`);
    const byAge = new Map<
      number,
      { inflow_lakhs: number; outflow_lakhs: number }
    >();
    for (const f of b.flows) {
      if (f.age < b.start_age || f.age > b.end_age) continue;
      byAge.set(f.age, {
        inflow_lakhs: f.inflow_lakhs,
        outflow_lakhs: f.outflow_lakhs,
      });
    }
    for (const [age, v] of byAge) {
      await client.query(
        `INSERT INTO annual_flows (age, inflow_lakhs, outflow_lakhs)
         VALUES ($1, $2, $3)`,
        [age, v.inflow_lakhs, v.outflow_lakhs]
      );
    }
    await client.query(`DELETE FROM lump_sum_outgoes`);
    for (const l of filterLumps(b.lump_sum_outgoes, b.start_age, b.end_age)) {
      await client.query(
        `INSERT INTO lump_sum_outgoes (age, amount_lakhs) VALUES ($1, $2)`,
        [l.age, l.amount_lakhs]
      );
    }
    await client.query(`DELETE FROM lump_sum_inflows`);
    for (const l of filterLumps(b.lump_sum_inflows, b.start_age, b.end_age)) {
      await client.query(
        `INSERT INTO lump_sum_inflows (age, amount_lakhs) VALUES ($1, $2)`,
        [l.age, l.amount_lakhs]
      );
    }
    await client.query(`DELETE FROM swp_plans`);
    for (const p of b.swp_plans) {
      await client.query(
        `INSERT INTO swp_plans (start_age, end_age, monthly_amount_lakhs)
         VALUES ($1, $2, $3)`,
        [p.start_age, p.end_age, p.monthly_amount_lakhs]
      );
    }
    await client.query("COMMIT");

    const settings = await loadSettings();
    const investment_buckets = await loadInvestmentBuckets();
    const flows = await loadFlows();
    const lump_sum_outgoes = await loadLumpSumOutgoes();
    const lump_sum_inflows = await loadLumpSumInflows();
    const swp_plans = await loadSwpPlans();
    const projection = buildProjection(
      settings,
      investment_buckets,
      flows,
      lump_sum_outgoes,
      lump_sum_inflows,
      swp_plans
    );
    res.json({
      settings,
      investment_buckets,
      flows,
      lump_sum_outgoes,
      lump_sum_inflows,
      swp_plans,
      projection,
    });
  } catch (e) {
    await client.query("ROLLBACK");
    next(e);
  } finally {
    client.release();
  }
});

// Streams the agent's reply over SSE and logs every run to agent_runs,
// including each tool call made along the way. The agent calls tools over
// MCP (see mcp-server.ts/tools.ts); buildProjection stays the only place
// that does the math. AGENT_MAX_ITERATIONS in ../config.ts caps the loop so
// a confused agent can't spin. Which model answers is resolved per-request
// from the llm_models table (see llm/registry.ts), not a fixed config
// value -- see result.provider below.
apiRouter.post("/chat", chatLimiter, async (req, res) => {
  const parsed = chatRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { message, history } = parsed.data;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  function send(event: string, data: unknown) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  try {
    const result = await runAgent(message, history, (event) => {
      if (event.type === "delta") {
        send("delta", { text: event.text });
      } else if (event.type === "tool_call") {
        send("tool_call", { name: event.name, input: event.input });
      } else {
        send("tool_result", { name: event.name, output: event.output });
      }
    });

    const usage = {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      model: result.provider,
    };
    await pool.query(
      `INSERT INTO agent_runs (model, user_message, reply, tool_calls, input_tokens, output_tokens, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'ok')`,
      [
        result.provider,
        message,
        result.reply,
        JSON.stringify(result.toolCalls),
        usage.inputTokens,
        usage.outputTokens,
      ]
    );
    send("done", usage);
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : "Chat failed";
    // If this threw before a provider was even resolved (e.g. an unknown
    // DB-override value), there's no result.provider to log -- 'unknown'
    // is a placeholder, not a guess at which model almost ran.
    await pool.query(
      `INSERT INTO agent_runs (model, user_message, status, error)
       VALUES ($1, $2, 'error', $3)`,
      ["unknown", message, errorMessage]
    );
    send("error", { message: errorMessage });
  } finally {
    res.end();
  }
});

// The LLM model catalog: which models are available (data) and which one
// is active (data) -- see llm/registry.ts. Editable live, no redeploy, e.g.
// to fail over during a vendor outage. max_tokens is NOT managed here --
// it's a tested, code-level fact per model (llm/anthropic/models.ts).
apiRouter.get("/llm-models", async (_req, res, next) => {
  try {
    const models = await listLlmModels();
    res.json({ models, available_vendors: listVendors() });
  } catch (e) {
    next(e);
  }
});

apiRouter.post("/llm-models", async (req, res, next) => {
  const parsed = addLlmModelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  if (!listVendors().includes(parsed.data.vendor)) {
    res.status(400).json({
      error: `Unknown vendor "${parsed.data.vendor}". Known: ${listVendors().join(", ")}`,
    });
    return;
  }
  try {
    await addLlmModel(parsed.data);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

apiRouter.put("/llm-models/:id/activate", async (req, res) => {
  try {
    await activateLlmModel(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "Failed to activate model" });
  }
});

apiRouter.delete("/llm-models/:id", async (req, res) => {
  try {
    await removeLlmModel(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "Failed to delete model" });
  }
});

apiRouter.get("/projection", async (_req, res, next) => {
  try {
    const settings = await loadSettings();
    const investment_buckets = await loadInvestmentBuckets();
    const flows = await loadFlows();
    const lump_sum_outgoes = await loadLumpSumOutgoes();
    const lump_sum_inflows = await loadLumpSumInflows();
    const swp_plans = await loadSwpPlans();
    res.json({
      projection: buildProjection(
        settings,
        investment_buckets,
        flows,
        lump_sum_outgoes,
        lump_sum_inflows,
        swp_plans
      ),
    });
  } catch (e) {
    next(e);
  }
});
