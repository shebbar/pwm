/**
 * Loads a fictional portfolio into an empty-ish DB so anyone who clones this
 * repo can run the app and the eval suite without needing real financial
 * data. Run manually: npm run seed:demo (backend/).
 *
 * Wipes and replaces the portfolio tables (buckets/flows/lump
 * sums/SWP/settings) -- NOT agent_runs or llm_models, which are operational
 * history/config rather than "your financial plan". Refuses to run against
 * a production database as a guard against wiping a real deployment by
 * mistake; this is meant for a fresh local/demo DB.
 */
import "dotenv/config";
import { initDatabase, pool } from "./db.js";

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to run seed:demo with NODE_ENV=production -- this truncates your portfolio data."
    );
  }

  await initDatabase();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query("DELETE FROM swp_plans");
    await client.query("DELETE FROM lump_sum_inflows");
    await client.query("DELETE FROM lump_sum_outgoes");
    await client.query("DELETE FROM annual_flows");
    await client.query("DELETE FROM investment_buckets");

    await client.query(
      `UPDATE app_settings SET inflation_pct = $1, start_age = $2, end_age = $3, updated_at = NOW() WHERE id = 1`,
      [5, 55, 90]
    );

    // Two buckets each for equity and debt -- deliberately, so evals that
    // check "did every bucket of this asset_class get touched" (not just
    // the first/only one) are actually exercised on a fresh clone.
    await client.query(
      `INSERT INTO investment_buckets (name, corpus_lakhs, return_pct, asset_class) VALUES
         ('Growth Equity', 150, 12, 'equity'),
         ('Horizon MF', 60, 11, 'equity'),
         ('Core Debt', 80, 7, 'debt'),
         ('Bond Ladder', 40, 6, 'debt'),
         ('Cash Buffer', 20, 4, 'cash')`
    );

    // One-off bump in outgoings around a fictional home renovation.
    await client.query(
      `INSERT INTO annual_flows (age, inflow_lakhs, outflow_lakhs) VALUES ($1, $2, $3)`,
      [60, 0, 10]
    );

    // Fictional one-off events: a lump sum inflow (matured FD) and a lump
    // sum outgo (a child's wedding) a few years apart.
    await client.query(
      `INSERT INTO lump_sum_inflows (age, amount_lakhs) VALUES ($1, $2)`,
      [58, 25]
    );
    await client.query(
      `INSERT INTO lump_sum_outgoes (age, amount_lakhs) VALUES ($1, $2)`,
      [65, 15]
    );

    // A flat monthly withdrawal for the whole retirement horizon.
    await client.query(
      `INSERT INTO swp_plans (start_age, end_age, monthly_amount_lakhs) VALUES ($1, $2, $3)`,
      [55, 90, 1]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  console.log(
    "Seeded demo portfolio: 5 buckets (2 equity, 2 debt, 1 cash), a lump sum inflow/outgo, and an SWP plan, ages 55-90."
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
