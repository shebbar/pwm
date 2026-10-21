import type { ToolCallLog } from "../agent.js";
import { replyContainsNumberNear } from "./text.js";
import type { EvalCase } from "./types.js";

export type GroundTruth = {
  startAge: number;
  equityBucketNames: string[];
  debtBucketNames: string[];
};

function findCalls(toolCalls: ToolCallLog[], name: string): ToolCallLog[] {
  return toolCalls.filter((t) => t.name === name);
}

/** A propose_* call's output is `{ pending_action_id, ... }` on success, or
 *  a plain error string when the handler's guardrail throws (see
 *  tools.ts). Checking for this field is how the guardrail cases tell
 *  "rejected" from "silently applied" without parsing error text. */
function wasAccepted(output: unknown): boolean {
  return typeof output === "object" && output !== null && "pending_action_id" in output;
}

// A round target (e.g. 5%) previously collided with the real debt buckets'
// actual saved rate (itself a round number, set by an earlier manual
// approval), making the model's "nothing to change, it's already there"
// response look like a false failure. A rate nobody would realistically
// set by hand in the admin screen keeps the proposal_tools case's premise
// (there IS a change to propose) true regardless of prior runs.
const PROPOSAL_TARGET_RETURN_PCT = 4.33;

export function buildCases(groundTruth: GroundTruth): EvalCase[] {
  const { startAge, equityBucketNames, debtBucketNames } = groundTruth;

  return [
    // Regression: nothing enforced the agent actually look up real data
    // instead of answering from its own training-data assumptions.
    {
      name: "reads total corpus from get_portfolio instead of guessing",
      category: "data_lookup",
      message: "What's my current total corpus and weighted average return?",
      check: (toolCalls) => {
        const calls = findCalls(toolCalls, "get_portfolio");
        return {
          pass: calls.length > 0,
          detail: calls.length > 0 ? `called get_portfolio ${calls.length}x` : "never called get_portfolio",
        };
      },
    },

    {
      name: "lists buckets with asset class, not just names",
      category: "data_lookup",
      message: "What investment buckets do I have, and which asset class is each one?",
      check: (toolCalls) => {
        const calls = findCalls(toolCalls, "get_buckets");
        return {
          pass: calls.length > 0,
          detail: calls.length > 0 ? `called get_buckets ${calls.length}x` : "never called get_buckets",
        };
      },
    },

    // Regression: "Rs 1 lakh/month" got translated to monthly_amount_lakhs: 0.1
    // (a 10x unit error) instead of 1, since the app's amounts are already in lakhs.
    {
      name: "SWP monthly amount uses the correct scale (lakhs, not rupees/10)",
      category: "unit_scale",
      message: `Ignore my saved SWP plan. If I withdraw a flat Rs 1 lakh per month from age ${startAge} to 90, at what age does my corpus run out?`,
      check: (toolCalls) => {
        const calls = findCalls(toolCalls, "run_projection");
        const withOverride = calls.find((c) => {
          const input = c.input as { assumptions?: { swp_override?: unknown[] } };
          return (input.assumptions?.swp_override?.length ?? 0) > 0;
        });
        if (!withOverride) {
          return { pass: false, detail: "never called run_projection with swp_override" };
        }
        const input = withOverride.input as {
          assumptions: { swp_override: { monthly_amount_lakhs: number }[] };
        };
        const amounts = input.assumptions.swp_override.map((p) => p.monthly_amount_lakhs);
        const badScale = amounts.some((a) => a < 0.5 || a > 2);
        return {
          pass: !badScale,
          detail: `swp_override monthly amounts: ${JSON.stringify(amounts)} (expected ~1)`,
        };
      },
    },

    // Regression: "increase all equity returns" only touched the bucket literally
    // named "Equity MF", missing "Orchid MF" -- a bucket name doesn't reliably
    // indicate asset class, asset_class does.
    {
      name: "equity-return change covers every equity-class bucket (by asset_class, not name)",
      category: "what_if",
      message: "What if I increase all my equity fund returns to 12%?",
      check: (toolCalls, reply) => {
        const calls = findCalls(toolCalls, "run_projection");
        const withOverride = calls.find((c) => {
          const input = c.input as { assumptions?: { bucket_overrides?: unknown[] } };
          return (input.assumptions?.bucket_overrides?.length ?? 0) > 0;
        });
        if (!withOverride) {
          // "What if" is a hypothetical -- it should never reach a propose_*
          // tool at all, only run_projection. Print what actually happened
          // rather than guess why it didn't call run_projection.
          return {
            pass: false,
            detail:
              `never called run_projection with bucket_overrides\n` +
              `      tool calls made: ${JSON.stringify(toolCalls.map((c) => c.name))}\n` +
              `      reply: ${JSON.stringify(reply)}`,
          };
        }
        const input = withOverride.input as {
          assumptions: { bucket_overrides: { name: string; return_pct?: number }[] };
        };
        const touched = new Set(
          input.assumptions.bucket_overrides.filter((o) => o.return_pct === 12).map((o) => o.name)
        );
        const missing = equityBucketNames.filter((n) => !touched.has(n));
        return {
          pass: missing.length === 0,
          detail:
            missing.length === 0
              ? `all equity buckets covered: ${equityBucketNames.join(", ")}`
              : `missing equity buckets: ${missing.join(", ")}`,
        };
      },
    },

    // Core "LLM never does the math" invariant: a what-if must always go
    // through run_projection with the actual override, never be answered
    // from the model's own estimate. Also an answer-correctness check: the
    // reply's claimed depletion age must match what run_projection itself
    // returned, within a 1-year tolerance -- the engine's own output is
    // the ground truth, not a second computation.
    {
      name: "hypothetical inflation change calls run_projection and the reply matches its output",
      category: "what_if",
      message: "If inflation were 7% instead of my current assumption, would my corpus last until 90?",
      check: (toolCalls, reply) => {
        const calls = findCalls(toolCalls, "run_projection");
        const withInflation = calls.find((c) => {
          const input = c.input as { assumptions?: { inflation_pct?: number } };
          return input.assumptions?.inflation_pct === 7;
        });
        if (!withInflation) {
          return {
            pass: false,
            detail: `no run_projection call used inflation_pct: 7 (calls: ${JSON.stringify(
              calls.map((c) => c.input)
            )})`,
          };
        }
        const output = withInflation.output as { depletion_age: number | null } | undefined;
        const depletionAge = output?.depletion_age;
        if (depletionAge === null || depletionAge === undefined) {
          return {
            pass: true,
            detail: "called run_projection with inflation_pct: 7 (never depletes, nothing to check in reply)",
          };
        }
        const mentioned = replyContainsNumberNear(reply, depletionAge, 1);
        return {
          pass: mentioned,
          detail: mentioned
            ? `called run_projection with inflation_pct: 7, reply mentions depletion age ~${depletionAge}`
            : `run_projection returned depletion_age=${depletionAge}, but reply doesn't mention a number near it: ${JSON.stringify(reply)}`,
        };
      },
    },

    {
      name: "extending the horizon to age 95 re-runs the projection with that end age",
      category: "multi_step",
      message: "If I live to 95 instead of 90, does my corpus last the whole time?",
      check: (toolCalls) => {
        const calls = findCalls(toolCalls, "run_projection");
        const withHorizon = calls.find((c) => {
          const input = c.input as { assumptions?: { end_age?: number }; horizon?: number };
          if (input.assumptions?.end_age === 95) return true;
          // horizon is "years from start_age" -- accept either way of expressing age 95.
          return typeof input.horizon === "number" && startAge + input.horizon - 1 === 95;
        });
        return {
          pass: Boolean(withHorizon),
          detail: withHorizon
            ? `called run_projection targeting end age 95: ${JSON.stringify(withHorizon.input)}`
            : `no run_projection call targeted age 95 (calls: ${JSON.stringify(calls.map((c) => c.input))})`,
        };
      },
    },

    // Regression: asked to set two debt buckets to an explicit 5%, one
    // proposal came back as 4.2% (6% * 0.7 -- a post-tax adjustment the
    // model invented on its own, matching a calculation it had made in an
    // unrelated earlier session) while the other correctly used 5%. The
    // guardrail (-5 to 30) didn't catch it since 4.2 is a perfectly sane
    // return_pct on its own -- this is an instruction-fidelity bug, not a
    // guardrail-catchable one. Re-running the identical prompt produced the
    // correct value both times, consistent with multi-tool-call sampling
    // variance rather than a deterministic bug.
    {
      name: "explicit numeric value used exactly across every bucket proposal in a turn",
      category: "proposal_tools",
      message: `Can you propose lowering the return rate on both of my debt buckets to exactly ${PROPOSAL_TARGET_RETURN_PCT}%?`,
      check: (toolCalls, reply) => {
        const calls = findCalls(toolCalls, "propose_update_assumption").filter((c) => {
          const input = c.input as { kind?: string; field?: string };
          return input.kind === "bucket" && input.field === "return_pct";
        });
        const proposedByBucket = new Map(
          calls.map((c) => {
            const input = c.input as { bucket_name: string; value: number };
            return [input.bucket_name, input.value] as const;
          })
        );
        const missing = debtBucketNames.filter((n) => !proposedByBucket.has(n));
        const wrongValue = [...proposedByBucket.entries()].filter(
          ([, v]) => v !== PROPOSAL_TARGET_RETURN_PCT
        );
        const pass = missing.length === 0 && wrongValue.length === 0;
        if (pass) {
          return {
            pass,
            detail: `all debt buckets proposed at exactly ${PROPOSAL_TARGET_RETURN_PCT}%: ${debtBucketNames.join(", ")}`,
          };
        }
        return {
          pass,
          detail:
            `missing proposals: ${JSON.stringify(missing)}, wrong values: ${JSON.stringify(wrongValue)}\n` +
            `      tool calls made: ${JSON.stringify(toolCalls.map((c) => c.name))}\n` +
            `      reply: ${JSON.stringify(reply)}`,
        };
      },
    },

    // Refusing out-of-scope requests: nothing in this app's toolset is
    // relevant to the weather, so calling any financial tool to answer
    // this is a sign the model is contriving a tool call rather than
    // recognizing the request is out of scope.
    {
      name: "off-topic weather question doesn't invoke financial tools",
      category: "out_of_scope",
      message: "What's the weather like in Paris today?",
      check: (toolCalls) => {
        return {
          pass: toolCalls.length === 0,
          detail:
            toolCalls.length === 0
              ? "no tool calls, as expected for an unrelated question"
              : `expected no tool calls, got: ${JSON.stringify(toolCalls.map((c) => c.name))}`,
        };
      },
    },

    // Same category, different shape: a general investment-advice question
    // that isn't about the user's own saved plan. run_projection is the
    // "LLM never does the math" tool for THIS plan -- it shouldn't be
    // reached for generic stock-picking advice.
    {
      name: "general stock-picking question doesn't invoke run_projection",
      category: "out_of_scope",
      message: "What stock should I buy right now?",
      check: (toolCalls) => {
        const calls = findCalls(toolCalls, "run_projection");
        return {
          pass: calls.length === 0,
          detail:
            calls.length === 0
              ? "never called run_projection, as expected for generic stock-picking advice"
              : `expected no run_projection calls, got ${calls.length}`,
        };
      },
    },

    // Guardrail violations: these test that an out-of-range proposal never
    // ends up looking successful, whether the model attempts the call and
    // gets rejected server-side, or declines to attempt it at all having
    // seen the bound in the tool's own description. Either is correct;
    // what's never correct is a pending_action_id for an out-of-range value.
    {
      name: "out-of-range inflation proposal is rejected, not silently applied",
      category: "guardrails",
      message: "Can you propose changing my inflation assumption to 20%?",
      check: (toolCalls) => {
        const calls = findCalls(toolCalls, "propose_update_assumption").filter((c) => {
          const input = c.input as { kind?: string; field?: string };
          return input.kind === "settings" && input.field === "inflation_pct";
        });
        const accepted = calls.filter((c) => wasAccepted(c.output));
        return {
          pass: accepted.length === 0,
          detail:
            accepted.length === 0
              ? `no out-of-range inflation proposal was accepted (${calls.length} attempt(s) made)`
              : `a 20% inflation proposal was accepted: ${JSON.stringify(accepted.map((c) => c.output))}`,
        };
      },
    },

    {
      name: "above-cap expense proposal is rejected, not silently applied",
      category: "guardrails",
      message: "Can you propose adding a one-off expense of 10000 lakhs at age 70?",
      check: (toolCalls) => {
        const calls = findCalls(toolCalls, "propose_add_expense");
        const accepted = calls.filter((c) => wasAccepted(c.output));
        return {
          pass: accepted.length === 0,
          detail:
            accepted.length === 0
              ? `no over-cap expense proposal was accepted (${calls.length} attempt(s) made)`
              : `a 10000-lakh expense proposal was accepted: ${JSON.stringify(accepted.map((c) => c.output))}`,
        };
      },
    },
  ];
}
