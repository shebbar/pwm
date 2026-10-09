/**
 * Manual smoke test for the tool layer (tsx src/tools.smoke.ts). Exercises
 * every read tool against the live DB, then round-trips each write tool
 * with a value that has no real effect (an inert out-of-range expense, an
 * assumption set back to its current value) so nothing is left changed.
 */
import "dotenv/config";
import { initDatabase, pool } from "./db.js";
import { getTool } from "./tools.js";

async function call(name: string, args: unknown) {
  const tool = getTool(name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  const parsed = tool.inputSchema.parse(args);
  return tool.handler(parsed);
}

async function main() {
  await initDatabase();

  console.log("get_portfolio ->", await call("get_portfolio", {}));
  console.log("get_buckets ->", await call("get_buckets", {}));

  const portfolio = (await call("get_portfolio", {})) as {
    settings: { inflation_pct: string; start_age: number; end_age: number };
  };
  const { start_age, end_age, inflation_pct } = portfolio.settings;

  console.log(
    "get_expenses ->",
    await call("get_expenses", {
      year_range: { start_age, end_age: Math.min(end_age, start_age + 9) },
    })
  );

  const baseline = (await call("run_projection", { assumptions: {} })) as {
    points: unknown[];
    depletion_age: number | null;
  };
  console.log(
    `run_projection (baseline) -> ${baseline.points.length} points, depletion_age: ${baseline.depletion_age}, first:`,
    baseline.points[0]
  );

  console.log(
    "run_projection (inflation=7, horizon=5) ->",
    await call("run_projection", { assumptions: { inflation_pct: 7 }, horizon: 5 })
  );

  console.log(
    "run_projection (swp_override: 1L/month for 20yrs then 3L/month to 90) ->",
    await call("run_projection", {
      assumptions: {
        swp_override: [
          { start_age, end_age: start_age + 19, monthly_amount_lakhs: 1 },
          { start_age: start_age + 20, end_age: 90, monthly_amount_lakhs: 3 },
        ],
      },
    })
  );

  // Write tools: round-trip with no real effect.
  console.log(
    "update_assumption (no-op: inflation set to its current value) ->",
    await call("update_assumption", {
      kind: "settings",
      field: "inflation_pct",
      value: Number(inflation_pct),
    })
  );

  console.log(
    "add_expense (inert: age 120, trivial amount) ->",
    await call("add_expense", { age: 120, amount_lakhs: 0.0001 })
  );
  await pool.query(
    `DELETE FROM lump_sum_outgoes WHERE age = 120 AND amount_lakhs = 0.0001`
  );
  console.log("cleaned up the test expense row");

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
