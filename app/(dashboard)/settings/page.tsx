export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Settings</h1>
      <p className="text-sm text-black/60 dark:text-white/60">
        Admin settings, n8n configuration, and integration keys live here
        (Build Phase 5). For now, configuration is managed via{" "}
        <code className="rounded bg-black/10 px-1 dark:bg-white/10">.env.local</code>.
      </p>
    </div>
  );
}
