"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createBranch,
  updateBranch,
  setBranchActive,
  setDefaultBranch,
  setCampaignEnabled,
  type BranchInput,
} from "@/app/(dashboard)/branches/actions";
import type { BranchView } from "@/lib/branches";

type ManagerOption = { id: string; label: string };
type CampaignOption = { type: string; label: string; description: string };

const inputCls =
  "rounded border border-black/15 bg-background px-2 py-1.5 text-sm dark:border-white/20";

const EMPTY: BranchInput = {
  code: "", name: "", legalName: "", gstin: "", addressLine1: "", addressLine2: "",
  city: "", pincode: "", phone: "", email: "", bankAccountName: "", bankAccountNumber: "",
  bankIfsc: "", bankName: "", upiId: "", managerId: "", quietStartHour: "", quietEndHour: "",
};

function toInput(b: BranchView): BranchInput {
  return {
    code: b.code, name: b.name, legalName: b.legalName ?? "", gstin: b.gstin ?? "",
    addressLine1: b.addressLine1 ?? "", addressLine2: b.addressLine2 ?? "", city: b.city ?? "",
    pincode: b.pincode ?? "", phone: b.phone ?? "", email: b.email ?? "",
    bankAccountName: b.bankAccountName ?? "", bankAccountNumber: b.bankAccountNumber ?? "",
    bankIfsc: b.bankIfsc ?? "", bankName: b.bankName ?? "", upiId: b.upiId ?? "",
    managerId: b.managerId ?? "",
    quietStartHour: b.quietStartHour != null ? String(b.quietStartHour) : "",
    quietEndHour: b.quietEndHour != null ? String(b.quietEndHour) : "",
  };
}

// The full field set, grouped — reused by the create + edit forms.
function BranchFields({
  data,
  set,
  managerOptions,
}: {
  data: BranchInput;
  set: (patch: Partial<BranchInput>) => void;
  managerOptions: ManagerOption[];
}) {
  const F = (
    key: keyof BranchInput,
    placeholder: string,
    opts?: { wide?: boolean },
  ) => (
    <input
      className={`${inputCls} ${opts?.wide ? "min-w-[16rem] flex-1" : "w-44"}`}
      placeholder={placeholder}
      value={(data[key] as string) ?? ""}
      onChange={(e) => set({ [key]: e.target.value })}
    />
  );

  const groupTitle = "text-[11px] font-semibold uppercase tracking-wide text-black/45 dark:text-white/45";
  return (
    <div className="space-y-3">
      <div>
        <div className={groupTitle}>Identity</div>
        <div className="mt-1 flex flex-wrap gap-2">
          <input className={`${inputCls} w-28`} placeholder="Code *" value={data.code}
            onChange={(e) => set({ code: e.target.value.toUpperCase() })} />
          {F("name", "Branch name * (e.g. Cara Juhu)", { wide: true })}
        </div>
      </div>
      <div>
        <div className={groupTitle}>Legal / Tax</div>
        <div className="mt-1 flex flex-wrap gap-2">
          {F("legalName", "Legal entity (e.g. Cara Healthcare Pvt Ltd)", { wide: true })}
          {F("gstin", "GSTIN (15 chars)")}
        </div>
      </div>
      <div>
        <div className={groupTitle}>Location &amp; contact</div>
        <div className="mt-1 flex flex-wrap gap-2">
          {F("addressLine1", "Address line 1", { wide: true })}
          {F("addressLine2", "Address line 2", { wide: true })}
          {F("city", "City")}
          {F("pincode", "Pincode")}
          {F("phone", "Phone")}
          {F("email", "Email")}
        </div>
      </div>
      <div>
        <div className={groupTitle}>Payment (shown on quotes)</div>
        <div className="mt-1 flex flex-wrap gap-2">
          {F("bankAccountName", "Bank account name", { wide: true })}
          {F("bankAccountNumber", "Account number")}
          {F("bankIfsc", "IFSC")}
          {F("bankName", "Bank / branch (e.g. ICICI, Santacruz)", { wide: true })}
          {F("upiId", "UPI ID (optional)")}
        </div>
      </div>
      <div>
        <div className={groupTitle}>Manager</div>
        <select className={`${inputCls} mt-1 min-w-[16rem]`} value={data.managerId ?? ""}
          onChange={(e) => set({ managerId: e.target.value })}>
          <option value="">No manager</option>
          {managerOptions.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      </div>
      <div>
        <div className={groupTitle}>Follow-up quiet hours (IST)</div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-black/55 dark:text-white/55">No campaign messages between</span>
          <input type="number" min={0} max={23} className={`${inputCls} w-20`} placeholder="20"
            value={data.quietStartHour ?? ""} onChange={(e) => set({ quietStartHour: e.target.value })} />
          <span className="text-black/55 dark:text-white/55">:00 and</span>
          <input type="number" min={0} max={23} className={`${inputCls} w-20`} placeholder="9"
            value={data.quietEndHour ?? ""} onChange={(e) => set({ quietEndHour: e.target.value })} />
          <span className="text-black/55 dark:text-white/55">:00</span>
          <span className="text-xs text-black/40 dark:text-white/40">(blank = default 20:00–09:00)</span>
        </div>
      </div>
    </div>
  );
}

export function BranchesAdmin({
  branches,
  managerOptions,
  campaigns,
}: {
  branches: BranchView[];
  managerOptions: ManagerOption[];
  campaigns: CampaignOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const refresh = () => router.refresh();

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    startTransition(async () => {
      const res = await fn();
      if (res.ok) refresh();
      else window.alert(res.error ?? "Action failed");
    });

  const [adding, setAdding] = useState(false);
  const [nb, setNb] = useState<BranchInput>(EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState<BranchInput>(EMPTY);
  const qrInputRef = useRef<HTMLInputElement>(null);
  const [qrForId, setQrForId] = useState<string | null>(null);

  function startEdit(b: BranchView) {
    setEditingId(b.id);
    setEdit(toInput(b));
  }

  async function uploadQr(branchId: string, file: File) {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`/api/branches/${branchId}/qr`, { method: "POST", body: fd });
    if (res.ok) refresh();
    else window.alert((await res.json().catch(() => ({})))?.error ?? "QR upload failed");
  }

  return (
    <div className="space-y-6">
      {/* Hidden file input reused for QR uploads. */}
      <input
        ref={qrInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f && qrForId) startTransition(() => uploadQr(qrForId, f));
          e.target.value = "";
        }}
      />

      {/* ── Create ── */}
      {adding ? (
        <div className="space-y-3 rounded border border-black/10 p-4 dark:border-white/15">
          <h2 className="text-sm font-semibold">New branch</h2>
          <BranchFields data={nb} set={(p) => setNb({ ...nb, ...p })} managerOptions={managerOptions} />
          <p className="text-xs text-black/45 dark:text-white/45">
            The scan-to-pay QR is uploaded after creating (from the branch&apos;s Edit view).
          </p>
          <div className="flex items-center gap-2">
            <button
              disabled={pending || !nb.code.trim() || !nb.name.trim()}
              className="rounded bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
              onClick={() => run(() => createBranch(nb).then((r) => { if (r.ok) { setNb(EMPTY); setAdding(false); } return r; }))}
            >
              Create branch
            </button>
            <button className="text-sm text-black/50 hover:underline dark:text-white/50"
              onClick={() => { setNb(EMPTY); setAdding(false); }}>Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)}
          className="rounded border border-black/15 px-3 py-1.5 text-sm font-medium hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10">
          + New branch
        </button>
      )}

      {/* ── List ── */}
      <div className="space-y-3">
        {branches.length === 0 && (
          <p className="rounded border border-black/10 px-3 py-6 text-center text-sm text-black/50 dark:border-white/15 dark:text-white/50">
            No branches yet. Create the first one — it becomes the default.
          </p>
        )}
        {branches.map((b) => (
          <div key={b.id} className="rounded border border-black/10 p-4 dark:border-white/15">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="rounded bg-black/5 px-2 py-0.5 font-mono text-xs dark:bg-white/10">{b.code}</span>
              <span className="font-medium">{b.name}</span>
              {b.isDefault && <span className="rounded-full bg-blue-500/15 px-2 py-0.5 text-xs text-blue-700 dark:text-blue-400">default</span>}
              {!b.active && <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-xs text-red-700 dark:text-red-400">inactive</span>}
              {b.city && <span className="text-black/50 dark:text-white/50">{b.city}</span>}
              {b.gstin && <span className="text-xs text-black/40 dark:text-white/40">GSTIN {b.gstin}</span>}
              <span className="text-xs text-black/40 dark:text-white/40">{b.hasQr ? "QR set" : "no QR"}</span>
              {b.managerName && <span className="text-xs text-black/40 dark:text-white/40">Mgr: {b.managerName}</span>}
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <button disabled={pending} className="text-xs text-blue-600 hover:underline dark:text-blue-400"
                  onClick={() => (editingId === b.id ? setEditingId(null) : startEdit(b))}>
                  {editingId === b.id ? "Close" : "Edit"}
                </button>
                <button disabled={pending}
                  className="text-xs text-blue-600 hover:underline dark:text-blue-400"
                  onClick={() => { setQrForId(b.id); qrInputRef.current?.click(); }}>
                  {b.hasQr ? "Replace QR" : "Upload QR"}
                </button>
                {!b.isDefault && b.active && (
                  <button disabled={pending} className="text-xs text-blue-600 hover:underline dark:text-blue-400"
                    onClick={() => run(() => setDefaultBranch(b.id))}>Set default</button>
                )}
                <button disabled={pending} className={`text-xs hover:underline ${b.active ? "text-red-600 dark:text-red-400" : "text-green-700 dark:text-green-400"}`}
                  onClick={() => run(() => setBranchActive(b.id, !b.active))}>
                  {b.active ? "Deactivate" : "Activate"}
                </button>
              </div>
            </div>

            {editingId === b.id && (
              <div className="mt-4 space-y-3 border-t border-black/10 pt-4 dark:border-white/15">
                <BranchFields data={edit} set={(p) => setEdit({ ...edit, ...p })} managerOptions={managerOptions} />
                <div className="flex items-center gap-2">
                  <button disabled={pending || !edit.code.trim() || !edit.name.trim()}
                    className="rounded bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
                    onClick={() => run(() => updateBranch(b.id, edit).then((r) => { if (r.ok) setEditingId(null); return r; }))}>
                    Save changes
                  </button>
                  <button className="text-sm text-black/50 hover:underline dark:text-white/50"
                    onClick={() => setEditingId(null)}>Cancel</button>
                </div>

                {/* ── Follow-up campaigns: per-branch on/off (§follow-up) ── */}
                <div className="border-t border-black/10 pt-4 dark:border-white/15">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-black/45 dark:text-white/45">
                    Follow-up campaigns
                  </div>
                  <p className="mt-1 text-xs text-black/45 dark:text-white/45">
                    Turn each campaign on or off for this branch. Hard exclusions (minor / legal /
                    complaint), opt-out, the reply-stop, and the 12-in-30 message ceiling always
                    apply regardless of these switches.
                  </p>
                  <div className="mt-2 space-y-1.5">
                    {campaigns.map((c) => {
                      const enabled = b.campaignSettings[c.type] ?? true;
                      return (
                        <label key={c.type} className="flex items-start gap-2 text-sm">
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={enabled}
                            disabled={pending}
                            onChange={() => run(() => setCampaignEnabled(b.id, c.type, !enabled))}
                          />
                          <span>
                            <span className="font-medium">{c.label}</span>{" "}
                            <span className="text-xs text-black/45 dark:text-white/45">— {c.description}</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
