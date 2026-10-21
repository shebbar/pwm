/** Browser calls the host-published API port; Next.js SSR in Docker must use the service name. */
function apiBase(): string {
  const strip = (u: string) => u.replace(/\/$/, "");
  if (typeof window === "undefined") {
    const internal = process.env.API_INTERNAL_URL;
    if (internal) return strip(internal);
  }
  return strip(
    process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000"
  );
}

export type Settings = {
  inflation_pct: string;
  start_age: number;
  end_age: number;
};

export type InvestmentBucket = {
  name: string;
  corpus_lakhs: string;
  return_pct: string;
  asset_class: "equity" | "debt" | "cash";
};

export type Flow = {
  age: number;
  inflow_lakhs: string;
  outflow_lakhs: string;
};

export type LumpSum = {
  age: number;
  amount_lakhs: string;
};

export type SwpPlan = {
  start_age: number;
  end_age: number;
  monthly_amount_lakhs: string;
};

export type ProjectionPoint = {
  age: number;
  startCorpusLakhs: number;
  netFlowLakhs: number;
  endCorpusLakhs: number;
};

export type FullState = {
  settings: Settings;
  investment_buckets: InvestmentBucket[];
  flows: Flow[];
  lump_sum_outgoes: LumpSum[];
  lump_sum_inflows: LumpSum[];
  swp_plans: SwpPlan[];
  projection: ProjectionPoint[];
};

export function totalCorpusLakhs(buckets: InvestmentBucket[]): number {
  return buckets.reduce((sum, b) => sum + Number(b.corpus_lakhs), 0);
}

export function weightedReturnPct(buckets: InvestmentBucket[]): number {
  const total = totalCorpusLakhs(buckets);
  if (total <= 0) return 0;
  return (
    buckets.reduce(
      (sum, b) => sum + Number(b.corpus_lakhs) * Number(b.return_pct),
      0
    ) / total
  );
}

/** First age (year-end) where corpus is zero or negative; null if it never runs out. */
export function corpusDepletionAge(
  projection: ProjectionPoint[]
): number | null {
  for (const p of projection) {
    if (p.endCorpusLakhs <= 0) return p.age;
  }
  return null;
}

export async function fetchFullState(): Promise<FullState> {
  const res = await fetch(`${apiBase()}/api/settings`, { cache: "no-store" });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

export type SavePayload = {
  investment_buckets: {
    name: string;
    corpus_lakhs: number;
    return_pct: number;
    asset_class: "equity" | "debt" | "cash";
  }[];
  inflation_pct: number;
  start_age: number;
  end_age: number;
  flows: { age: number; inflow_lakhs: number; outflow_lakhs: number }[];
  lump_sum_outgoes: { age: number; amount_lakhs: number }[];
  lump_sum_inflows: { age: number; amount_lakhs: number }[];
  swp_plans: {
    start_age: number;
    end_age: number;
    monthly_amount_lakhs: number;
  }[];
};

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type ChatUsage = {
  inputTokens: number;
  outputTokens: number;
  model: string;
  /** The agent_runs row id this turn was logged as -- lets the UI request
   *  a second opinion scoped to this specific turn. */
  runId: number;
};

export type ToolEvent = {
  name: string;
  phase: "call" | "result";
  data: unknown;
};

/** Consumes the /api/chat SSE stream, calling onDelta for each text chunk
 *  and onToolEvent for each tool call/result the agent makes along the way. */
export async function streamChatMessage(
  message: string,
  history: ChatMessage[],
  onDelta: (text: string) => void,
  onToolEvent?: (event: ToolEvent) => void
): Promise<ChatUsage> {
  const res = await fetch(`${apiBase()}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, history }),
  });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      typeof err?.error === "string" ? err.error : `Chat failed (${res.status})`
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: ChatUsage | null = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sepIndex;
    while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);

      const eventMatch = rawEvent.match(/^event: (.+)$/m);
      const dataMatch = rawEvent.match(/^data: (.+)$/m);
      if (!dataMatch) continue;

      const event = eventMatch?.[1] ?? "message";
      const data = JSON.parse(dataMatch[1]);

      if (event === "delta") {
        onDelta(data.text as string);
      } else if (event === "tool_call") {
        onToolEvent?.({ name: data.name, phase: "call", data: data.input });
      } else if (event === "tool_result") {
        onToolEvent?.({ name: data.name, phase: "result", data: data.output });
      } else if (event === "done") {
        usage = data as ChatUsage;
      } else if (event === "error") {
        throw new Error(data.message ?? "Chat stream error");
      }
    }
  }

  if (!usage) throw new Error("Stream ended without a completion event");
  return usage;
}

export type LlmModel = {
  id: string;
  label: string;
  vendor: string;
  model_id: string;
  is_active: boolean;
  /** Which model runCritic (the "second opinion" agent) uses -- a separate
   *  choice from is_active, never allowed to match it unless it's the only
   *  model in the catalog (enforced server-side). */
  is_critic: boolean;
};

export type ImpactSummary = { depletion_age: number | null; end_corpus_lakhs: number };

export type PendingAction = {
  id: number;
  agent_run_id: number | null;
  tool_name: string;
  proposed_input: unknown;
  before_summary: ImpactSummary;
  after_summary: ImpactSummary;
  status: "pending" | "approved" | "rejected" | "expired";
  reason: string | null;
  decided_at: string | null;
  decided_by: string | null;
  created_at: string;
  expires_at: string;
};

// Baked into the JS bundle at build time (see docker-compose.yml /
// frontend/Dockerfile) -- not a real secret once it's shipped to the
// browser, just enough to stop a blind/automated request from hitting
// /api/actions/*. See backend/src/routes/api.ts's requireActionsAuth.
function actionsAuthHeaders(): Record<string, string> {
  const token = process.env.NEXT_PUBLIC_ACTIONS_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function fetchPendingActions(
  status?: PendingAction["status"]
): Promise<PendingAction[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  const res = await fetch(`${apiBase()}/api/actions${qs}`, {
    cache: "no-store",
    headers: actionsAuthHeaders(),
  });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  const data = (await res.json()) as { actions: PendingAction[] };
  return data.actions;
}

async function decideAction(
  id: number,
  decision: "approve" | "reject",
  reason?: string
): Promise<PendingAction> {
  const res = await fetch(`${apiBase()}/api/actions/${id}/${decision}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...actionsAuthHeaders() },
    body: JSON.stringify(reason ? { reason } : {}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      typeof err?.error === "string" ? err.error : `${decision} failed (${res.status})`
    );
  }
  const data = (await res.json()) as { action: PendingAction };
  return data.action;
}

export function approveAction(id: number): Promise<PendingAction> {
  return decideAction(id, "approve");
}

export function rejectAction(id: number, reason?: string): Promise<PendingAction> {
  return decideAction(id, "reject", reason);
}

export async function fetchLlmModels(): Promise<{
  models: LlmModel[];
  available_vendors: string[];
}> {
  const res = await fetch(`${apiBase()}/api/llm-models`, { cache: "no-store" });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

export async function addLlmModel(input: {
  id: string;
  label: string;
  vendor: string;
  model_id: string;
}): Promise<void> {
  const res = await fetch(`${apiBase()}/api/llm-models`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      typeof err?.error === "string" ? err.error : `Add model failed (${res.status})`
    );
  }
}

export async function activateLlmModel(id: string): Promise<void> {
  const res = await fetch(`${apiBase()}/api/llm-models/${encodeURIComponent(id)}/activate`, {
    method: "PUT",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      typeof err?.error === "string" ? err.error : `Activate failed (${res.status})`
    );
  }
}

export async function activateCriticLlmModel(id: string): Promise<void> {
  const res = await fetch(
    `${apiBase()}/api/llm-models/${encodeURIComponent(id)}/activate-critic`,
    { method: "PUT" }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      typeof err?.error === "string" ? err.error : `Set critic model failed (${res.status})`
    );
  }
}

export async function removeLlmModel(id: string): Promise<void> {
  const res = await fetch(`${apiBase()}/api/llm-models/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      typeof err?.error === "string" ? err.error : `Delete failed (${res.status})`
    );
  }
}

export async function saveSettings(body: SavePayload): Promise<FullState> {
  const res = await fetch(`${apiBase()}/api/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      typeof err?.error === "string" ? err.error : `Save failed (${res.status})`
    );
  }
  return res.json();
}

export type AgentRunStopReason = "answered" | "iteration_cap" | "error" | "awaiting_approval";

export type AgentRunSummary = {
  id: number;
  created_at: string;
  model: string;
  user_message: string;
  reply: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  status: string;
  error: string | null;
  total_latency_ms: number | null;
  iteration_count: number | null;
  retry_count: number;
  stop_reason: AgentRunStopReason | null;
  cost_usd: string | null;
  /** 'chat' for ordinary turns, 'critique' for a second opinion on another
   *  run (see parent_run_id). */
  kind: "chat" | "critique";
  parent_run_id: number | null;
};

export type ToolCallEntry = {
  name: string;
  input: unknown;
  output: unknown;
  latencyMs: number;
  sequence: number;
};

export type LlmCallEntry = {
  sequence: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
  retries: number;
};

export type AgentRunDetail = AgentRunSummary & {
  tool_calls: ToolCallEntry[];
  llm_calls: LlmCallEntry[];
};

export type AgentRunFilters = {
  status?: string;
  stopReason?: string;
  model?: string;
  fromDate?: string;
  toDate?: string;
  page?: number;
  pageSize?: number;
};

export type AgentRunStats = {
  runsPerDay: { day: string; count: number }[];
  failureRate: number;
  avgCostUsd: number | null;
  p95LatencyMs: number | null;
  topTools: { name: string; count: number }[];
};

export async function fetchAgentRuns(
  filters: AgentRunFilters = {}
): Promise<{ runs: AgentRunSummary[]; total: number }> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const qs = params.toString();
  const res = await fetch(`${apiBase()}/api/agent-runs${qs ? `?${qs}` : ""}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

export async function fetchAgentRun(
  id: number
): Promise<{ run: AgentRunDetail; critiques: AgentRunSummary[] }> {
  const res = await fetch(`${apiBase()}/api/agent-runs/${id}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

export async function fetchAgentRunStats(): Promise<AgentRunStats> {
  const res = await fetch(`${apiBase()}/api/agent-runs/stats`, { cache: "no-store" });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

/** Triggered only by the "Get a second opinion" button in the chat UI.
 *  Returns the new critique run (its `reply` is the critique text itself,
 *  ready to render as its own card). */
export async function fetchSecondOpinion(runId: number): Promise<AgentRunDetail> {
  const res = await fetch(`${apiBase()}/api/agent-runs/${runId}/second-opinion`, {
    method: "POST",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      typeof err?.error === "string" ? err.error : `Second opinion failed (${res.status})`
    );
  }
  const data = (await res.json()) as { run: AgentRunDetail };
  return data.run;
}
