import { AdminForm } from "./AdminForm";

export default function AdminPage() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
        Admin
      </h1>
      <p className="mt-2 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
        Set your investment buckets (corpus and return per bucket), inflation,
        lump sum inflows and outflows by age, and systematic withdrawal plans.
        All amounts are Rs Lakhs.
      </p>
      <div className="mt-8">
        <AdminForm />
      </div>
    </main>
  );
}
