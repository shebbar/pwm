"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ProjectionPoint } from "@/lib/api";

function formatLakhs(n: number): string {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1 }).format(
    n
  );
}

export function GrowthChart({
  projection,
}: {
  projection: ProjectionPoint[];
}) {
  const data = projection.map((p) => ({
    age: p.age,
    corpusLakhs: p.endCorpusLakhs,
  }));

  return (
    <div className="h-[420px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
          <CartesianGrid
            strokeDasharray="3 3"
            className="stroke-zinc-200 dark:stroke-zinc-800"
          />
          <XAxis
            dataKey="age"
            tick={{ fontSize: 12 }}
            label={{
              value: "Age",
              position: "insideBottom",
              offset: -4,
              fontSize: 12,
            }}
          />
          <YAxis
            tick={{ fontSize: 12 }}
            tickFormatter={(v) => formatLakhs(Number(v))}
            label={{
              value: "Rs Lakhs",
              angle: -90,
              position: "insideLeft",
              fontSize: 12,
            }}
          />
          <Tooltip
            formatter={(value) => [
              `₹ ${formatLakhs(Number(value ?? 0))} L`,
              "Corpus (end of year)",
            ]}
            labelFormatter={(age) => `Age ${age}`}
            contentStyle={{
              borderRadius: "8px",
              border: "1px solid rgb(228 228 231)",
              fontSize: "13px",
            }}
          />
          <Line
            type="monotone"
            dataKey="corpusLakhs"
            stroke="rgb(5 150 105)"
            strokeWidth={2}
            dot={false}
            name="Corpus"
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
