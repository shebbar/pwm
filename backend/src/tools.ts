import { z } from "zod";
import {
  addExpense,
  insertPendingAction,
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
  type SettingsRow,
  type SwpPlanRow,
  type YearPoint,
} from "./projection.js";

/**
 * The typed tool layer an agent (or an MCP server) calls instead of talking
 * SQL/HTTP directly. Every tool's math still goes through buildProjection --
 * these just assemble inputs for it and shape outputs. "write" tools mutate
 * the database directly and are never exposed to an agent (kept only for
 * tools.smoke.ts and reuse by the approval endpoint); "propose" tools are
 * what an agent actually calls -- they stage a pending_actions row and
 * return its impact, never writing the real tables themselves. See
 * routes/api.ts's /api/actions endpoints for the approve/reject step that
 * turns a proposal into an actual write.
 */
export type ToolKind = "read" | "write" | "propose";

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
    // Plain rupees, NOT this app's internal lakhs scale -- deliberately, so
    // the model never has to convert a user's "Rs 1 lakh/month" into a
    // lakhs-denominated number itself. That conversion is arithmetic
    // ("the LLM never does the math"), and asking the model to do it
    // in its head was a real, recurring eval failure (monthly_amount_lakhs
    // coming back as 0.1 instead of 1). The handler below does the one
    // division, in code, every time.
    monthly_amount_rupees: z
      .number()
      .finite()
      .nonnegative()
      .describe(
        "Monthly withdrawal in plain INR rupees -- e.g. Rs 1,00,000/month = 100000, " +
          "Rs 50,000/month = 50000. Do not convert this to lakhs yourself."
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
          monthly_amount_lakhs: String(p.monthly_amount_rupees / 100_000),
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

// Guardrail bounds for proposals specifically -- the agent-reachable path.
// Deliberately not applied to update_assumption/add_expense themselves,
// since those are also used by the admin screen's own save path (via
// routes/api.ts's PUT /settings, with its own bounds) and tools.smoke.ts.
const INFLATION_PCT_RANGE = { min: 2, max: 12 };
const BUCKET_RETURN_PCT_RANGE = { min: -5, max: 30 };
const BUCKET_CORPUS_CAP_LAKHS = 100_000; // sanity ceiling (~Rs 1000 Cr), not a realistic plan size
const EXPENSE_AMOUNT_CAP_LAKHS = 500; // ~Rs 5 Cr

type ImpactSummary = { depletion_age: number | null; end_corpus_lakhs: number };

function summarize(points: YearPoint[]): ImpactSummary {
  return {
    depletion_age: corpusDepletionAge(points),
    end_corpus_lakhs: points[points.length - 1]?.endCorpusLakhs ?? 0,
  };
}

/** Loads current data once, runs buildProjection twice (as-is, then with
 *  the proposed change applied to an in-memory copy) -- never writes. */
async function computeAssumptionImpact(
  input: ProposeUpdateAssumptionInput
): Promise<{ before: ImpactSummary; after: ImpactSummary }> {
  const [settings, buckets, flows, lumpOut, lumpIn, swp] = await Promise.all([
    loadSettings(),
    loadInvestmentBuckets(),
    loadFlows(),
    loadLumpSumOutgoes(),
    loadLumpSumInflows(),
    loadSwpPlans(),
  ]);

  const before = summarize(buildProjection(settings, buckets, flows, lumpOut, lumpIn, swp));

  let afterSettings: SettingsRow = settings;
  let afterBuckets: InvestmentBucketRow[] = buckets;

  if (input.kind === "settings") {
    afterSettings = { ...settings };
    if (input.field === "inflation_pct") afterSettings.inflation_pct = String(input.value);
    else if (input.field === "start_age") afterSettings.start_age = input.value;
    else afterSettings.end_age = input.value;
  } else {
    // validateProposeUpdateAssumption already required this for kind
    // "bucket" -- this check is defense in depth, not the primary guard.
    const bucketName = input.bucket_name;
    if (!bucketName) throw new Error('bucket_name is required when kind is "bucket"');
    if (!buckets.some((b) => b.name === bucketName)) {
      throw new Error(`No investment bucket named "${bucketName}"`);
    }
    afterBuckets = buckets.map((b) => {
      if (b.name !== bucketName) return b;
      const updated = { ...b };
      if (input.field === "corpus_lakhs") updated.corpus_lakhs = String(input.value);
      else updated.return_pct = String(input.value);
      return updated;
    });
  }

  const after = summarize(
    buildProjection(afterSettings, afterBuckets, flows, lumpOut, lumpIn, swp)
  );
  return { before, after };
}

async function computeExpenseImpact(
  input: z.infer<typeof proposeAddExpenseInput>
): Promise<{ before: ImpactSummary; after: ImpactSummary }> {
  const [settings, buckets, flows, lumpOut, lumpIn, swp] = await Promise.all([
    loadSettings(),
    loadInvestmentBuckets(),
    loadFlows(),
    loadLumpSumOutgoes(),
    loadLumpSumInflows(),
    loadSwpPlans(),
  ]);

  const before = summarize(buildProjection(settings, buckets, flows, lumpOut, lumpIn, swp));
  const afterLumpOut = [...lumpOut, { age: input.age, amount_lakhs: String(input.amount_lakhs) }];
  const after = summarize(
    buildProjection(settings, buckets, flows, afterLumpOut, lumpIn, swp)
  );
  return { before, after };
}

// Deliberately a flat object, NOT z.discriminatedUnion(...) -- the MCP SDK
// advertises a tool's parameters by reading inputSchema.shape, which only
// ZodObject has. A discriminated union (or a flat object wrapped in
// .superRefine(), which also returns a non-ZodObject ZodEffects) has no
// .shape, so the tool gets advertised with zero parameters even though
// runtime validation still works -- confirmed live: Claude Desktop could
// call this tool, but only by guessing the argument shape from error
// messages, since `tools/list` showed `{}`. Guardrail bounds are therefore
// checked in validateProposeUpdateAssumption() below, as plain code, not
// zod refinement.
const proposeUpdateAssumptionInput = z.object({
  kind: z.enum(["settings", "bucket"]),
  field: z.enum(["inflation_pct", "start_age", "end_age", "corpus_lakhs", "return_pct"]),
  value: z.number().finite(),
  bucket_name: z
    .string()
    .optional()
    .describe('Required when kind is "bucket" -- ignored when kind is "settings".'),
});

type ProposeUpdateAssumptionInput = z.infer<typeof proposeUpdateAssumptionInput>;

function validateProposeUpdateAssumption(input: ProposeUpdateAssumptionInput): void {
  if (input.kind === "settings") {
    if (!["inflation_pct", "start_age", "end_age"].includes(input.field)) {
      throw new Error('field must be one of inflation_pct/start_age/end_age when kind is "settings"');
    }
    if (
      input.field === "inflation_pct" &&
      (input.value < INFLATION_PCT_RANGE.min || input.value > INFLATION_PCT_RANGE.max)
    ) {
      throw new Error(
        `inflation_pct must be between ${INFLATION_PCT_RANGE.min} and ${INFLATION_PCT_RANGE.max}`
      );
    }
    if (input.field === "start_age" && (input.value < 18 || input.value > 100)) {
      throw new Error("start_age must be between 18 and 100");
    }
    if (input.field === "end_age" && (input.value < 18 || input.value > 120)) {
      throw new Error("end_age must be between 18 and 120");
    }
    return;
  }

  if (!["corpus_lakhs", "return_pct"].includes(input.field)) {
    throw new Error('field must be one of corpus_lakhs/return_pct when kind is "bucket"');
  }
  if (!input.bucket_name) {
    throw new Error('bucket_name is required when kind is "bucket"');
  }
  if (
    input.field === "return_pct" &&
    (input.value < BUCKET_RETURN_PCT_RANGE.min || input.value > BUCKET_RETURN_PCT_RANGE.max)
  ) {
    throw new Error(
      `return_pct must be between ${BUCKET_RETURN_PCT_RANGE.min} and ${BUCKET_RETURN_PCT_RANGE.max}`
    );
  }
  if (input.field === "corpus_lakhs" && (input.value < 0 || input.value > BUCKET_CORPUS_CAP_LAKHS)) {
    throw new Error(`corpus_lakhs must be between 0 and ${BUCKET_CORPUS_CAP_LAKHS}`);
  }
}

const proposeUpdateAssumptionTool = {
  name: "propose_update_assumption",
  description:
    "PROPOSE: stages an app_settings field (inflation_pct/start_age/end_age) or a bucket's corpus_lakhs/return_pct change for human approval -- does NOT write anything. Returns pending_action_id plus the before/after projection impact (depletion_age, end_corpus_lakhs); relay both to the user and tell them it needs approval before it takes effect. Guardrails: inflation_pct 2-12, bucket return_pct -5 to 30, bucket corpus_lakhs 0-100000 lakhs -- out-of-range values are rejected before a proposal is even created.",
  kind: "propose",
  inputSchema: proposeUpdateAssumptionInput,
  handler: async (input: ProposeUpdateAssumptionInput) => {
    validateProposeUpdateAssumption(input);
    const { before, after } = await computeAssumptionImpact(input);
    const pending_action_id = await insertPendingAction({
      toolName: "propose_update_assumption",
      proposedInput: input,
      beforeSummary: before,
      afterSummary: after,
    });
    return { pending_action_id, status: "pending", before, after };
  },
} satisfies Tool;

const proposeAddExpenseInput = z.object({
  age: z.number().int().min(0).max(120),
  amount_lakhs: z.number().finite().positive().max(EXPENSE_AMOUNT_CAP_LAKHS),
});

const proposeAddExpenseTool = {
  name: "propose_add_expense",
  description:
    "PROPOSE: stages a one-off expense (lump sum outgo) at a given age for human approval -- does NOT write anything. Returns pending_action_id plus the before/after projection impact (depletion_age, end_corpus_lakhs); relay both to the user and tell them it needs approval before it takes effect. Guardrail: amount capped at 500 lakhs -- larger amounts are rejected before a proposal is even created.",
  kind: "propose",
  inputSchema: proposeAddExpenseInput,
  handler: async (input: z.infer<typeof proposeAddExpenseInput>) => {
    const { before, after } = await computeExpenseImpact(input);
    const pending_action_id = await insertPendingAction({
      toolName: "propose_add_expense",
      proposedInput: input,
      beforeSummary: before,
      afterSummary: after,
    });
    return { pending_action_id, status: "pending", before, after };
  },
} satisfies Tool;

export const tools: Tool[] = [
  getPortfolioTool,
  getBucketsTool,
  getExpensesTool,
  runProjectionTool,
  updateAssumptionTool,
  addExpenseTool,
  proposeUpdateAssumptionTool,
  proposeAddExpenseTool,
];

export function getTool(name: string): Tool | undefined {
  return tools.find((t) => t.name === name);
}
