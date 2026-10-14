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
};

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
