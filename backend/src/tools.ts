import { z } from "zod";
import {
  addExpense,
  loadFlows,
  loadInvestmentBuckets,
  loadLumpSumInflows,
  loadLumpSumOutgoes,
  loadSettings,
  loadSwpPlans,
  updateAssumption,
} from "./data.js";
import {
  buildProjection,
  corpusDepletionAge,
  totalCorpusLakhs,
  weightedReturnPct,
  type InvestmentBucketRow,
  type SwpPlanRow,
} from "./projection.js";

/**
 * The typed tool layer an agent (or an MCP server) calls instead of talking
 * SQL/HTTP directly. Every tool's math still goes through buildProjection --
 * these just assemble inputs for it and shape outputs. "write" tools mutate
 * the database and should go through a user-approval step before the
 * handler is ever invoked by an agent loop.
 */
export type ToolKind = "read" | "write";

export type Tool = {
  name: string;
  description: string;
  kind: ToolKind;
  inputSchema: z.ZodType<any>;
  handler: (input: any) => Promise<unknown>;
};

const emptyInput = z.object({});

const getPortfolioTool = {
  name: "get_portfolio",
  description:
    "Overall plan snapshot: inflation and age-range assumptions, total corpus across all buckets, and the blended nominal return.",
  kind: "read",
  inputSchema: emptyInput,
  handler: async () => {
    const [settings, buckets] = await Promise.all([
      loadSettings(),
      loadInvestmentBuckets(),
    ]);
    return {
      settings,
      total_corpus_lakhs: totalCorpusLakhs(buckets),
      weighted_return_pct: weightedReturnPct(buckets),
    };
  },
} satisfies Tool;

const getBucketsTool = {
  name: "get_buckets",
  description:
    "List of investment buckets: name, current corpus (lakhs), expected nominal return %, and asset_class (equity/debt/cash). Use asset_class, not the bucket name, to decide which buckets a request like 'increase all equity returns' applies to -- a bucket's name (e.g. a family member's name) doesn't reliably indicate its asset class.",
  kind: "read",
  inputSchema: emptyInput,
  handler: async () => loadInvestmentBuckets(),
} satisfies Tool;

const yearRangeSchema = z
  .object({
    start_age: z.number().int().min(0).max(120),
    end_age: z.number().int().min(0).max(120),
  })
  .refine((r) => r.start_age <= r.end_age, {
    message: "start_age must be <= end_age",
    path: ["end_age"],
  });

const getExpensesInput = z.object({ year_range: yearRangeSchema });

const getExpensesTool = {
  name: "get_expenses",
  description:
    "All planned cash flows in an age range: annual inflows/outflows, one-off lump sums (in/out), and SWP withdrawals.",
  kind: "read",
  inputSchema: getExpensesInput,
  handler: async ({ year_range }: z.infer<typeof getExpensesInput>) => {
    const inRange = <T extends { age: number }>(rows: T[]) =>
      rows.filter(
        (r) => r.age >= year_range.start_age && r.age <= year_range.end_age
      );
    const overlaps = (p: { start_age: number; end_age: number }) =>
      p.start_age <= year_range.end_age && p.end_age >= year_range.start_age;

    const [flows, lumpOut, lumpIn, swp] = await Promise.all([
      loadFlows(),
      loadLumpSumOutgoes(),
      loadLumpSumInflows(),
      loadSwpPlans(),
    ]);

    return {
      flows: inRange(flows),
      lump_sum_outgoes: inRange(lumpOut),
      lump_sum_inflows: inRange(lumpIn),
      swp_plans: swp.filter(overlaps),
    };
  },
} satisfies Tool;

const bucketOverrideSchema = z.object({
  name: z.string(),
  corpus_lakhs: z.number().finite().nonnegative().optional(),
  return_pct: z.number().finite().optional(),
});

const swpOverrideEntrySchema = z
  .object({
    start_age: z.number().int().min(0).max(120),
    end_age: z.number().int().min(0).max(120),
    monthly_amount_lakhs: z
      .number()
      .finite()
      .nonnegative()
      .describe(
        "Already in lakhs, same scale as every other amount in this app -- " +
          "e.g. Rs 1,00,000/month = 1, Rs 2,00,000/month = 2, Rs 50,000/month = 0.5. " +
          "Do not apply any further conversion."
      ),
  })
  .refine((p) => p.start_age <= p.end_age, {
    message: "start_age must be <= end_age",
    path: ["end_age"],
  });

const assumptionsSchema = z
  .object({
    inflation_pct: z.number().finite().optional(),
    start_age: z.number().int().min(0).max(120).optional(),
    end_age: z.number().int().min(0).max(120).optional(),
    bucket_overrides: z.array(bucketOverrideSchema).optional(),
    // If provided, REPLACES the saved SWP schedule entirely for this call
    // (not merged) -- include every band you want active, e.g. two entries
    // for "X/month for 20 years, then Y/month until 90".
    swp_override: z.array(swpOverrideEntrySchema).optional(),
  })
  .default({});

const runProjectionInput = z.object({
  assumptions: assumptionsSchema,
  // Number of years from start_age; overrides assumptions.end_age if given.
  horizon: z.number().int().positive().max(100).optional(),
});

const runProjectionTool = {
  name: "run_projection",
  description:
    "Runs the deterministic year-by-year corpus projection with optional hypothetical overrides (inflation, age range, per-bucket corpus/return, and/or a full replacement SWP withdrawal schedule via swp_override -- e.g. different monthly amounts over different age bands, not limited to the saved bands). Does not write anything -- this is the tool for what-if questions. Returns { points, depletion_age }: depletion_age is the first age where corpus reaches zero or below (null if it never does) -- always read this field instead of scanning points yourself.",
  kind: "read",
  inputSchema: runProjectionInput,
  handler: async ({
    assumptions,
    horizon,
  }: z.infer<typeof runProjectionInput>) => {
    const [settings, buckets, flows, lumpOut, lumpIn, swp] =
      await Promise.all([
        loadSettings(),
        loadInvestmentBuckets(),
        loadFlows(),
        loadLumpSumOutgoes(),
        loadLumpSumInflows(),
        loadSwpPlans(),
      ]);

    const startAge = assumptions.start_age ?? settings.start_age;
    const endAge = horizon
      ? startAge + horizon - 1
      : assumptions.end_age ?? settings.end_age;

    const effectiveSettings = {
      inflation_pct: String(assumptions.inflation_pct ?? settings.inflation_pct),
      start_age: startAge,
      end_age: endAge,
    };

    const overrideByName = new Map(
      (assumptions.bucket_overrides ?? []).map((o) => [o.name, o])
    );
    const effectiveBuckets: InvestmentBucketRow[] = buckets.map((b) => {
      const o = overrideByName.get(b.name);
      if (!o) return b;
      return {
        name: b.name,
        corpus_lakhs: String(o.corpus_lakhs ?? b.corpus_lakhs),
        return_pct: String(o.return_pct ?? b.return_pct),
        asset_class: b.asset_class,
      };
    });

    const effectiveSwp: SwpPlanRow[] = assumptions.swp_override
      ? assumptions.swp_override.map((p) => ({
          start_age: p.start_age,
          end_age: p.end_age,
          monthly_amount_lakhs: String(p.monthly_amount_lakhs),
        }))
      : swp;

    const points = buildProjection(
      effectiveSettings,
      effectiveBuckets,
      flows,
      lumpOut,
      lumpIn,
      effectiveSwp
    );
    return { points, depletion_age: corpusDepletionAge(points) };
  },
} satisfies Tool;

const updateAssumptionInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("settings"),
    field: z.enum(["inflation_pct", "start_age", "end_age"]),
    value: z.number().finite(),
  }),
  z.object({
    kind: z.literal("bucket"),
    bucket_name: z.string(),
    field: z.enum(["corpus_lakhs", "return_pct"]),
    value: z.number().finite(),
  }),
]);

const updateAssumptionTool = {
  name: "update_assumption",
  description:
    "WRITE: persists a single assumption change -- an app_settings field (inflation_pct/start_age/end_age) or one bucket's corpus_lakhs/return_pct. Requires user approval before being called.",
  kind: "write",
  inputSchema: updateAssumptionInput,
  handler: async (input: z.infer<typeof updateAssumptionInput>) => {
    await updateAssumption(input);
    return { ok: true };
  },
} satisfies Tool;

const addExpenseInput = z.object({
  age: z.number().int().min(0).max(120),
  amount_lakhs: z.number().finite().positive(),
});

const addExpenseTool = {
  name: "add_expense",
  description:
    "WRITE: adds a one-off expense (lump sum outgo) at a given age. Only affects the projection if the age falls within the current start_age/end_age range. Requires user approval before being called.",
  kind: "write",
  inputSchema: addExpenseInput,
  handler: async (input: z.infer<typeof addExpenseInput>) => {
    await addExpense(input);
    return { ok: true };
  },
} satisfies Tool;

export const tools: Tool[] = [
  getPortfolioTool,
  getBucketsTool,
  getExpensesTool,
  runProjectionTool,
  updateAssumptionTool,
  addExpenseTool,
];

export function getTool(name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}
