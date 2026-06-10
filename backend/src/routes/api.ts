import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import {
  buildProjection,
  type FlowRow,
  type InvestmentBucketRow,
  type LumpSumRow,
  type SettingsRow,
  type SwpPlanRow,
} from "../projection.js";

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

const bucketSchema = z.object({
  name: z.string().max(200),
  corpus_lakhs: z.number().finite().nonnegative(),
  return_pct: z.number().finite(),
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

async function loadSettings(): Promise<SettingsRow> {
  const { rows } = await pool.query<SettingsRow>(
    `SELECT inflation_pct, start_age, end_age FROM app_settings WHERE id = 1`
  );
  if (!rows[0]) throw new Error("Missing app_settings row");
  return rows[0];
}

async function loadInvestmentBuckets(): Promise<InvestmentBucketRow[]> {
  const { rows } = await pool.query<InvestmentBucketRow>(
    `SELECT name, corpus_lakhs, return_pct FROM investment_buckets ORDER BY id`
  );
  return rows;
}

async function loadFlows(): Promise<FlowRow[]> {
  const { rows } = await pool.query<FlowRow>(
    `SELECT age, inflow_lakhs, outflow_lakhs FROM annual_flows ORDER BY age`
  );
  return rows;
}

async function loadLumpSumOutgoes(): Promise<LumpSumRow[]> {
  const { rows } = await pool.query<LumpSumRow>(
    `SELECT age, amount_lakhs FROM lump_sum_outgoes ORDER BY age, id`
  );
  return rows;
}

async function loadLumpSumInflows(): Promise<LumpSumRow[]> {
  const { rows } = await pool.query<LumpSumRow>(
    `SELECT age, amount_lakhs FROM lump_sum_inflows ORDER BY age, id`
  );
  return rows;
}

async function loadSwpPlans(): Promise<SwpPlanRow[]> {
  const { rows } = await pool.query<SwpPlanRow>(
    `SELECT start_age, end_age, monthly_amount_lakhs
     FROM swp_plans ORDER BY start_age, id`
  );
  return rows;
}

function filterLumps(
  lumps: { age: number; amount_lakhs: number }[],
  startAge: number,
  endAge: number
) {
  return lumps.filter((l) => l.age >= startAge && l.age <= endAge);
}

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
        `INSERT INTO investment_buckets (name, corpus_lakhs, return_pct) VALUES ($1, $2, $3)`,
        [bucket.name, bucket.corpus_lakhs, bucket.return_pct]
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
