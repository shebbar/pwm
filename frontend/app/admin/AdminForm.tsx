"use client";

import { useCallback, useEffect, useState } from "react";
import {
  activateCriticLlmModel,
  activateLlmModel,
  addLlmModel,
  fetchFullState,
  fetchLlmModels,
  removeLlmModel,
  saveSettings,
  type FullState,
  type InvestmentBucket,
  type LlmModel,
  type LumpSum,
  type SavePayload,
  type SwpPlan,
} from "@/lib/api";

type AssetClass = "equity" | "debt" | "cash";

type BucketRow = {
  name: string;
  corpus: string;
  returnPct: string;
  assetClass: AssetClass;
};

function bucketsToRows(buckets: InvestmentBucket[]): BucketRow[] {
  return buckets.map((b) => ({
    name: b.name ?? "",
    corpus: String(Number(b.corpus_lakhs)),
    returnPct: String(Number(b.return_pct)),
    assetClass: b.asset_class ?? "equity",
  }));
}

type LumpRow = {
  age: number;
  amount: string;
};

function lumpsToRows(lumps: LumpSum[]): LumpRow[] {
  return lumps.map((l) => ({
    age: l.age,
    amount: String(Number(l.amount_lakhs)),
  }));
}

type SwpRow = {
  startAge: number;
  endAge: number;
  monthly: string;
};

function swpToRows(plans: SwpPlan[]): SwpRow[] {
  return plans.map((p) => ({
    startAge: p.start_age,
    endAge: p.end_age,
    monthly: String(Number(p.monthly_amount_lakhs)),
  }));
}

export function AdminForm() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [bucketRows, setBucketRows] = useState<BucketRow[]>([]);
  const [inflation, setInflation] = useState("");
  const [savingBuckets, setSavingBuckets] = useState(false);
  const [startAge, setStartAge] = useState("51");
  const [endAge, setEndAge] = useState("90");
  const [lumpOutRows, setLumpOutRows] = useState<LumpRow[]>([]);
  const [lumpInRows, setLumpInRows] = useState<LumpRow[]>([]);
  const [swpRows, setSwpRows] = useState<SwpRow[]>([]);
  const [savingLumpOuts, setSavingLumpOuts] = useState(false);
  const [savingLumpIns, setSavingLumpIns] = useState(false);
  const [savingSwp, setSavingSwp] = useState(false);

  const [llmModels, setLlmModels] = useState<LlmModel[]>([]);
  const [availableVendors, setAvailableVendors] = useState<string[]>([]);
  const [llmModelsLoading, setLlmModelsLoading] = useState(true);
  const [llmModelsError, setLlmModelsError] = useState<string | null>(null);
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [activatingCriticId, setActivatingCriticId] = useState<string | null>(null);
  const [addingModel, setAddingModel] = useState(false);
  const [newModelId, setNewModelId] = useState("");
  const [newModelLabel, setNewModelLabel] = useState("");
  const [newModelVendor, setNewModelVendor] = useState("");
  const [newModelModelId, setNewModelModelId] = useState("");

  const applyState = useCallback((s: FullState) => {
    const buckets = bucketsToRows(s.investment_buckets ?? []);
    setBucketRows(
      buckets.length
        ? buckets
        : [{ name: "", corpus: "0", returnPct: "8", assetClass: "equity" }]
    );
    setInflation(String(Number(s.settings.inflation_pct)));
    setStartAge(String(s.settings.start_age));
    setEndAge(String(s.settings.end_age));
    setLumpOutRows(lumpsToRows(s.lump_sum_outgoes ?? []));
    setLumpInRows(lumpsToRows(s.lump_sum_inflows ?? []));
    setSwpRows(swpToRows(s.swp_plans ?? []));
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await fetchFullState();
        if (!cancelled) applyState(s);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyState]);

  const loadLlmModels = useCallback(async () => {
    try {
      const { models, available_vendors } = await fetchLlmModels();
      setLlmModels(models);
      setAvailableVendors(available_vendors);
      setNewModelVendor((v) => v || available_vendors[0] || "");
    } catch (e) {
      setLlmModelsError(e instanceof Error ? e.message : "Failed to load models");
    } finally {
      setLlmModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLlmModels();
  }, [loadLlmModels]);

  const handleActivateModel = async (id: string) => {
    setActivatingId(id);
    setLlmModelsError(null);
    try {
      await activateLlmModel(id);
      await loadLlmModels();
    } catch (e) {
      setLlmModelsError(e instanceof Error ? e.message : "Activate failed");
    } finally {
      setActivatingId(null);
    }
  };

  const handleActivateCriticModel = async (id: string) => {
    setActivatingCriticId(id);
    setLlmModelsError(null);
    try {
      await activateCriticLlmModel(id);
      await loadLlmModels();
    } catch (e) {
      setLlmModelsError(e instanceof Error ? e.message : "Set critic model failed");
    } finally {
      setActivatingCriticId(null);
    }
  };

  const handleRemoveModel = async (id: string) => {
    setLlmModelsError(null);
    try {
      await removeLlmModel(id);
      await loadLlmModels();
    } catch (e) {
      setLlmModelsError(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const handleAddModel = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddingModel(true);
    setLlmModelsError(null);
    try {
      await addLlmModel({
        id: newModelId.trim(),
        label: newModelLabel.trim(),
        vendor: newModelVendor,
        model_id: newModelModelId.trim(),
      });
      setNewModelId("");
      setNewModelLabel("");
      setNewModelModelId("");
      await loadLlmModels();
    } catch (e) {
      setLlmModelsError(e instanceof Error ? e.message : "Add failed");
    } finally {
      setAddingModel(false);
    }
  };

  const mapBucketRows = (rows: BucketRow[]) =>
    rows.map((row) => ({
      name: row.name.trim(),
      corpus_lakhs: Number(row.corpus) || 0,
      return_pct: Number(row.returnPct) || 0,
      asset_class: row.assetClass,
    }));

  const mapLumpRows = (lumps: LumpRow[], sa: number, ea: number) =>
    lumps
      .map((row) => ({
        age: Number(row.age),
        amount_lakhs: Number(row.amount) || 0,
      }))
      .filter((l) => !Number.isNaN(l.age) && l.age >= sa && l.age <= ea);

  const mapSwpRows = (plans: SwpRow[]) =>
    plans
      .map((row) => ({
        start_age: Number(row.startAge),
        end_age: Number(row.endAge),
        monthly_amount_lakhs: Number(row.monthly) || 0,
      }))
      .filter(
        (p) =>
          !Number.isNaN(p.start_age) &&
          !Number.isNaN(p.end_age) &&
          p.start_age <= p.end_age
      );

  const buildPayload = useCallback(
    (
      bucketOverride?: BucketRow[],
      lumpOutOverride?: LumpRow[],
      lumpInOverride?: LumpRow[],
      swpOverride?: SwpRow[]
    ): SavePayload => {
      const sa = Number(startAge);
      const ea = Number(endAge);
      const buckets = mapBucketRows(bucketOverride ?? bucketRows);
      return {
        investment_buckets:
          buckets.length > 0
            ? buckets
            : [{ name: "", corpus_lakhs: 0, return_pct: 0, asset_class: "equity" as const }],
        inflation_pct: Number(inflation) || 0,
        start_age: sa,
        end_age: ea,
        flows: [],
        lump_sum_outgoes: mapLumpRows(lumpOutOverride ?? lumpOutRows, sa, ea),
        lump_sum_inflows: mapLumpRows(lumpInOverride ?? lumpInRows, sa, ea),
        swp_plans: mapSwpRows(swpOverride ?? swpRows),
      };
    },
    [inflation, startAge, endAge, bucketRows, lumpOutRows, lumpInRows, swpRows]
  );

  const persistBucketRows = async (next: BucketRow[]) => {
    setSavingBuckets(true);
    setError(null);
    try {
      const state = await saveSettings(buildPayload(next));
      setBucketRows(bucketsToRows(state.investment_buckets ?? []));
      setMessage("Investment buckets saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSavingBuckets(false);
    }
  };

  const addBucketRow = () => {
    const next = [
      ...bucketRows,
      { name: "", corpus: "0", returnPct: "8", assetClass: "equity" as const },
    ];
    setBucketRows(next);
    void persistBucketRows(next);
  };

  const removeBucketRow = (index: number) => {
    if (bucketRows.length <= 1) return;
    const next = bucketRows.filter((_, i) => i !== index);
    setBucketRows(next);
    void persistBucketRows(next);
  };

  const updateBucketRow = (index: number, patch: Partial<BucketRow>) => {
    setBucketRows((r) =>
      r.map((row, i) => (i === index ? { ...row, ...patch } : row))
    );
  };

  const persistLumpOutRows = async (next: LumpRow[]) => {
    setSavingLumpOuts(true);
    setError(null);
    try {
      const state = await saveSettings(buildPayload(undefined, next));
      setLumpOutRows(lumpsToRows(state.lump_sum_outgoes ?? []));
      setMessage("Lump sum outgoes saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSavingLumpOuts(false);
    }
  };

  const persistLumpInRows = async (next: LumpRow[]) => {
    setSavingLumpIns(true);
    setError(null);
    try {
      const state = await saveSettings(buildPayload(undefined, undefined, next));
      setLumpInRows(lumpsToRows(state.lump_sum_inflows ?? []));
      setMessage("Lump sum inflows saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSavingLumpIns(false);
    }
  };

  const nextLumpAge = (lumps: LumpRow[]) => {
    const sa = Number(startAge) || 51;
    const ea = Number(endAge) || 90;
    return lumps.length === 0
      ? sa
      : Math.min(ea, Math.max(sa, lumps[lumps.length - 1].age + 1));
  };

  const addLumpOutRow = () => {
    const next = [...lumpOutRows, { age: nextLumpAge(lumpOutRows), amount: "0" }];
    setLumpOutRows(next);
    void persistLumpOutRows(next);
  };

  const removeLumpOutRow = (index: number) => {
    const next = lumpOutRows.filter((_, i) => i !== index);
    setLumpOutRows(next);
    void persistLumpOutRows(next);
  };

  const updateLumpOutRow = (index: number, patch: Partial<LumpRow>) => {
    setLumpOutRows((r) =>
      r.map((row, i) => (i === index ? { ...row, ...patch } : row))
    );
  };

  const addLumpInRow = () => {
    const next = [...lumpInRows, { age: nextLumpAge(lumpInRows), amount: "0" }];
    setLumpInRows(next);
    void persistLumpInRows(next);
  };

  const removeLumpInRow = (index: number) => {
    const next = lumpInRows.filter((_, i) => i !== index);
    setLumpInRows(next);
    void persistLumpInRows(next);
  };

  const updateLumpInRow = (index: number, patch: Partial<LumpRow>) => {
    setLumpInRows((r) =>
      r.map((row, i) => (i === index ? { ...row, ...patch } : row))
    );
  };

  const persistSwpRows = async (next: SwpRow[]) => {
    setSavingSwp(true);
    setError(null);
    try {
      const state = await saveSettings(
        buildPayload(undefined, undefined, undefined, next)
      );
      setSwpRows(swpToRows(state.swp_plans ?? []));
      setMessage("SWP plans saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSavingSwp(false);
    }
  };

  const defaultSwpRow = (): SwpRow => {
    const sa = Number(startAge) || 60;
    const ea = Number(endAge) || 90;
    const start = Math.min(sa, 60);
    const end = Math.min(ea, Math.max(start, 70));
    return { startAge: start, endAge: end, monthly: "1" };
  };

  const addSwpRow = () => {
    const next = [...swpRows, defaultSwpRow()];
    setSwpRows(next);
    void persistSwpRows(next);
  };

  const removeSwpRow = (index: number) => {
    const next = swpRows.filter((_, i) => i !== index);
    setSwpRows(next);
    void persistSwpRows(next);
  };

  const updateSwpRow = (index: number, patch: Partial<SwpRow>) => {
    setSwpRows((r) =>
      r.map((row, i) => (i === index ? { ...row, ...patch } : row))
    );
  };

  const onSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const state = await saveSettings(buildPayload());
      setBucketRows(bucketsToRows(state.investment_buckets ?? []));
      setLumpOutRows(lumpsToRows(state.lump_sum_outgoes ?? []));
      setLumpInRows(lumpsToRows(state.lump_sum_inflows ?? []));
      setSwpRows(swpToRows(state.swp_plans ?? []));
      setMessage("Saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
    );
  }

  return (
    <div className="space-y-8">
    <form onSubmit={onSave} className="space-y-8">
      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200">
          {error}
        </p>
      )}
      {message && (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100">
          {message}
        </p>
      )}

      <section>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Investment buckets
          </h2>
          <button
            type="button"
            onClick={addBucketRow}
            disabled={savingBuckets}
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-900"
          >
            + Add row
          </button>
        </div>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Each bucket is a slice of your portfolio with its own size and expected
          nominal return. Yearly flows are applied pro-rata by bucket size; each
          bucket then compounds at its own real return after inflation. Adding or
          removing a row saves immediately.
        </p>

        <div className="mt-4 overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
          <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
            <thead className="bg-zinc-50 dark:bg-zinc-900/50">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-zinc-600 dark:text-zinc-400">
                  Name
                </th>
                <th className="px-3 py-2 text-left font-medium text-zinc-600 dark:text-zinc-400">
                  Corpus (Rs Lakhs)
                </th>
                <th className="px-3 py-2 text-left font-medium text-zinc-600 dark:text-zinc-400">
                  Return (% nominal)
                </th>
                <th className="px-3 py-2 text-left font-medium text-zinc-600 dark:text-zinc-400">
                  Asset class
                </th>
                <th className="px-3 py-2 text-right font-medium text-zinc-600 dark:text-zinc-400">
                  {/* remove */}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 bg-white dark:divide-zinc-800 dark:bg-zinc-950">
              {bucketRows.map((row, i) => (
                <tr key={`bucket-${i}`}>
                  <td className="px-3 py-2">
                    <input
                      type="text"
                      placeholder="e.g. Equity MF"
                      className="w-full min-w-[8rem] rounded border border-zinc-200 bg-transparent px-2 py-1 dark:border-zinc-700"
                      value={row.name}
                      onChange={(e) =>
                        updateBucketRow(i, { name: e.target.value })
                      }
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      step="any"
                      min={0}
                      className="w-full min-w-[6rem] rounded border border-zinc-200 bg-transparent px-2 py-1 dark:border-zinc-700"
                      value={row.corpus}
                      onChange={(e) =>
                        updateBucketRow(i, { corpus: e.target.value })
                      }
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      step="any"
                      className="w-full min-w-[6rem] rounded border border-zinc-200 bg-transparent px-2 py-1 dark:border-zinc-700"
                      value={row.returnPct}
                      onChange={(e) =>
                        updateBucketRow(i, { returnPct: e.target.value })
                      }
                    />
                  </td>
                  <td className="px-3 py-2">
                    <select
                      className="w-full min-w-[7rem] rounded border border-zinc-200 bg-transparent px-2 py-1 dark:border-zinc-700"
                      value={row.assetClass}
                      onChange={(e) =>
                        updateBucketRow(i, {
                          assetClass: e.target.value as AssetClass,
                        })
                      }
                    >
                      <option value="equity">Equity</option>
                      <option value="debt">Debt / FD</option>
                      <option value="cash">Cash / Savings</option>
                    </select>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => removeBucketRow(i)}
                      disabled={savingBuckets || bucketRows.length <= 1}
                      className="rounded-md px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-60 dark:text-red-400 dark:hover:bg-red-950/50"
                      aria-label="Remove row"
                    >
                      −
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {savingBuckets && (
          <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
            Saving investment buckets…
          </p>
        )}
      </section>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <label className="block">
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            Inflation (%)
          </span>
          <input
            type="number"
            step="any"
            required
            className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-zinc-900 shadow-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
            value={inflation}
            onChange={(e) => setInflation(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            Start age
          </span>
          <input
            type="number"
            min={18}
            max={100}
            required
            className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-zinc-900 shadow-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
            value={startAge}
            onChange={(e) => setStartAge(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            End age
          </span>
          <input
            type="number"
            min={18}
            max={120}
            required
            className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-zinc-900 shadow-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
            value={endAge}
            onChange={(e) => setEndAge(e.target.value)}
          />
        </label>
      </section>

      <section>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Expected lump sum outgoes (Rs Lakhs)
          </h2>
          <button
            type="button"
            onClick={addLumpOutRow}
            disabled={savingLumpOuts}
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-900"
          >
            + Add row
          </button>
        </div>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          One-time expenses at a given age (e.g. car purchase, son&apos;s
          education). Each amount is deducted from your net worth that year
          before growth. Adding or removing a row saves immediately.
        </p>

        <div className="mt-4 overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
          <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
            <thead className="bg-zinc-50 dark:bg-zinc-900/50">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-zinc-600 dark:text-zinc-400">
                  Age
                </th>
                <th className="px-3 py-2 text-left font-medium text-zinc-600 dark:text-zinc-400">
                  Amount
                </th>
                <th className="px-3 py-2 text-right font-medium text-zinc-600 dark:text-zinc-400">
                  {/* remove */}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 bg-white dark:divide-zinc-800 dark:bg-zinc-950">
              {lumpOutRows.length === 0 ? (
                <tr>
                  <td
                    colSpan={3}
                    className="px-3 py-4 text-center text-zinc-500 dark:text-zinc-400"
                  >
                    No lump sum outgoes yet. Use + to add one.
                  </td>
                </tr>
              ) : (
                lumpOutRows.map((row, i) => (
                  <tr key={`lump-out-${i}-${row.age}`}>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        min={Number(startAge) || 51}
                        max={Number(endAge) || 90}
                        className="w-20 rounded border border-zinc-200 bg-transparent px-2 py-1 dark:border-zinc-700"
                        value={row.age}
                        onChange={(e) =>
                          updateLumpOutRow(i, { age: Number(e.target.value) })
                        }
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        step="any"
                        min={0}
                        className="w-full min-w-[6rem] rounded border border-zinc-200 bg-transparent px-2 py-1 dark:border-zinc-700"
                        value={row.amount}
                        onChange={(e) =>
                          updateLumpOutRow(i, { amount: e.target.value })
                        }
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => removeLumpOutRow(i)}
                        disabled={savingLumpOuts}
                        className="rounded-md px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-60 dark:text-red-400 dark:hover:bg-red-950/50"
                        aria-label="Remove row"
                      >
                        −
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {savingLumpOuts && (
          <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
            Saving lump sum outgoes…
          </p>
        )}
      </section>

      <section>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Expected lump sum inflows (Rs Lakhs)
          </h2>
          <button
            type="button"
            onClick={addLumpInRow}
            disabled={savingLumpIns}
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-900"
          >
            + Add row
          </button>
        </div>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          One-time receipts at a given age (e.g. inheritance, property sale).
          Each amount is added to your net worth that year before growth.
          Adding or removing a row saves immediately.
        </p>

        <div className="mt-4 overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
          <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
            <thead className="bg-zinc-50 dark:bg-zinc-900/50">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-zinc-600 dark:text-zinc-400">
                  Age
                </th>
                <th className="px-3 py-2 text-left font-medium text-zinc-600 dark:text-zinc-400">
                  Amount
                </th>
                <th className="px-3 py-2 text-right font-medium text-zinc-600 dark:text-zinc-400">
                  {/* remove */}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 bg-white dark:divide-zinc-800 dark:bg-zinc-950">
              {lumpInRows.length === 0 ? (
                <tr>
                  <td
                    colSpan={3}
                    className="px-3 py-4 text-center text-zinc-500 dark:text-zinc-400"
                  >
                    No lump sum inflows yet. Use + to add one.
                  </td>
                </tr>
              ) : (
                lumpInRows.map((row, i) => (
                  <tr key={`lump-in-${i}-${row.age}`}>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        min={Number(startAge) || 51}
                        max={Number(endAge) || 90}
                        className="w-20 rounded border border-zinc-200 bg-transparent px-2 py-1 dark:border-zinc-700"
                        value={row.age}
                        onChange={(e) =>
                          updateLumpInRow(i, { age: Number(e.target.value) })
                        }
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        step="any"
                        min={0}
                        className="w-full min-w-[6rem] rounded border border-zinc-200 bg-transparent px-2 py-1 dark:border-zinc-700"
                        value={row.amount}
                        onChange={(e) =>
                          updateLumpInRow(i, { amount: e.target.value })
                        }
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => removeLumpInRow(i)}
                        disabled={savingLumpIns}
                        className="rounded-md px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-60 dark:text-red-400 dark:hover:bg-red-950/50"
                        aria-label="Remove row"
                      >
                        −
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {savingLumpIns && (
          <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
            Saving lump sum inflows…
          </p>
        )}
      </section>

      <section>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Systematic withdrawal plan (SWP)
          </h2>
          <button
            type="button"
            onClick={addSwpRow}
            disabled={savingSwp}
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-900"
          >
            + Add row
          </button>
        </div>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Fixed monthly withdrawal between start and end age (inclusive). Each
          year in that range, 12 × monthly amount is deducted from corpus before
          growth (e.g. ages 60–70 at 1 lakh/month, ages 81–85 at 2 lakhs/month).
          Adding or removing a row saves immediately.
        </p>

        <div className="mt-4 overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
          <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
            <thead className="bg-zinc-50 dark:bg-zinc-900/50">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-zinc-600 dark:text-zinc-400">
                  Start age
                </th>
                <th className="px-3 py-2 text-left font-medium text-zinc-600 dark:text-zinc-400">
                  End age
                </th>
                <th className="px-3 py-2 text-left font-medium text-zinc-600 dark:text-zinc-400">
                  Monthly (Rs Lakhs)
                </th>
                <th className="px-3 py-2 text-right font-medium text-zinc-600 dark:text-zinc-400">
                  {/* remove */}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 bg-white dark:divide-zinc-800 dark:bg-zinc-950">
              {swpRows.length === 0 ? (
                <tr>
                  <td
                    colSpan={4}
                    className="px-3 py-4 text-center text-zinc-500 dark:text-zinc-400"
                  >
                    No SWP plans yet. Use + to add one.
                  </td>
                </tr>
              ) : (
                swpRows.map((row, i) => (
                  <tr key={`swp-${i}-${row.startAge}-${row.endAge}`}>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        min={0}
                        max={120}
                        className="w-20 rounded border border-zinc-200 bg-transparent px-2 py-1 dark:border-zinc-700"
                        value={row.startAge}
                        onChange={(e) =>
                          updateSwpRow(i, {
                            startAge: Number(e.target.value),
                          })
                        }
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        min={0}
                        max={120}
                        className="w-20 rounded border border-zinc-200 bg-transparent px-2 py-1 dark:border-zinc-700"
                        value={row.endAge}
                        onChange={(e) =>
                          updateSwpRow(i, { endAge: Number(e.target.value) })
                        }
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        step="any"
                        min={0}
                        className="w-full min-w-[6rem] rounded border border-zinc-200 bg-transparent px-2 py-1 dark:border-zinc-700"
                        value={row.monthly}
                        onChange={(e) =>
                          updateSwpRow(i, { monthly: e.target.value })
                        }
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => removeSwpRow(i)}
                        disabled={savingSwp}
                        className="rounded-md px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-60 dark:text-red-400 dark:hover:bg-red-950/50"
                        aria-label="Remove row"
                      >
                        −
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {savingSwp && (
          <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
            Saving SWP plans…
          </p>
        )}
      </section>

      <div>
        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>

    <section>
      <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
        AI model
      </h2>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        Which model answers what-if questions in chat. Switching here takes
        effect immediately, no restart needed. Adding a model here only sets
        up routing/labeling -- it still needs a tested token-budget entry in
        code (llm/anthropic/models.ts) before it&apos;s safe to activate.
      </p>

      {llmModelsError && (
        <p className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200">
          {llmModelsError}
        </p>
      )}

      {llmModelsLoading ? (
        <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
          Loading…
        </p>
      ) : (
        <>
          <label className="mt-4 block max-w-sm">
            <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              Active model
            </span>
            <select
              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-zinc-900 shadow-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
              value={llmModels.find((m) => m.is_active)?.id ?? ""}
              disabled={activatingId !== null}
              onChange={(e) => void handleActivateModel(e.target.value)}
            >
              {llmModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>

          {(() => {
            const active = llmModels.find((m) => m.is_active);
            const otherModels = llmModels.filter((m) => m.id !== active?.id);
            if (otherModels.length === 0) {
              return (
                <p className="mt-4 max-w-sm text-xs text-zinc-500 dark:text-zinc-400">
                  <span className="font-medium uppercase tracking-wide">Critic model:</span>{" "}
                  sharing the primary model -- add another model above to give the critic a
                  dedicated one.
                </p>
              );
            }
            const explicitCritic = otherModels.find((m) => m.is_critic);
            const criticValue = explicitCritic?.id ?? otherModels[0]?.id ?? "";
            return (
              <label className="mt-4 block max-w-sm">
                <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                  Critic model
                </span>
                <select
                  className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-zinc-900 shadow-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                  value={criticValue}
                  disabled={activatingCriticId !== null}
                  onChange={(e) => void handleActivateCriticModel(e.target.value)}
                >
                  {otherModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <span className="mt-1 block text-xs text-zinc-500 dark:text-zinc-400">
                  Which model answers &quot;Get a second opinion&quot; in chat -- always a
                  different model than the active one above.
                </span>
              </label>
            );
          })()}

          <div className="mt-4 overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
            <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
              <thead className="bg-zinc-50 dark:bg-zinc-900/50">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-zinc-600 dark:text-zinc-400">
                    Label
                  </th>
                  <th className="px-3 py-2 text-left font-medium text-zinc-600 dark:text-zinc-400">
                    Vendor
                  </th>
                  <th className="px-3 py-2 text-left font-medium text-zinc-600 dark:text-zinc-400">
                    Model ID
                  </th>
                  <th className="px-3 py-2 text-left font-medium text-zinc-600 dark:text-zinc-400">
                    Active
                  </th>
                  <th className="px-3 py-2 text-left font-medium text-zinc-600 dark:text-zinc-400">
                    Critic
                  </th>
                  <th className="px-3 py-2 text-right font-medium text-zinc-600 dark:text-zinc-400">
                    {/* remove */}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 bg-white dark:divide-zinc-800 dark:bg-zinc-950">
                {llmModels.map((m) => (
                  <tr key={m.id}>
                    <td className="px-3 py-2">{m.label}</td>
                    <td className="px-3 py-2 text-zinc-500 dark:text-zinc-400">
                      {m.vendor}
                    </td>
                    <td className="px-3 py-2 text-zinc-500 dark:text-zinc-400">
                      {m.model_id}
                    </td>
                    <td className="px-3 py-2">{m.is_active ? "✓" : ""}</td>
                    <td className="px-3 py-2">{m.is_critic ? "✓" : ""}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => void handleRemoveModel(m.id)}
                        disabled={m.is_active || m.is_critic}
                        title={
                          m.is_active
                            ? "Activate a different model first"
                            : m.is_critic
                              ? "Set a different critic model first"
                              : "Remove"
                        }
                        className="rounded-md px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-40 dark:text-red-400 dark:hover:bg-red-950/50"
                        aria-label="Remove model"
                      >
                        −
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <form
            onSubmit={handleAddModel}
            className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5 lg:items-end"
          >
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                Id (slug)
              </span>
              <input
                type="text"
                required
                placeholder="e.g. claude-opus"
                pattern="[a-z0-9-]+"
                className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                value={newModelId}
                onChange={(e) => setNewModelId(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                Label
              </span>
              <input
                type="text"
                required
                placeholder="e.g. Claude Opus"
                className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                value={newModelLabel}
                onChange={(e) => setNewModelLabel(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                Vendor
              </span>
              <select
                required
                className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                value={newModelVendor}
                onChange={(e) => setNewModelVendor(e.target.value)}
              >
                {availableVendors.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                Model ID
              </span>
              <input
                type="text"
                required
                placeholder="e.g. claude-opus-4-8"
                className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
                value={newModelModelId}
                onChange={(e) => setNewModelModelId(e.target.value)}
              />
            </label>
            <button
              type="submit"
              disabled={addingModel}
              className="rounded-lg border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-900"
            >
              {addingModel ? "Adding…" : "+ Add model"}
            </button>
          </form>
        </>
      )}
    </section>
    </div>
  );
}
