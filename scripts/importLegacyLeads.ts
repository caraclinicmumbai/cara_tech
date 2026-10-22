// Import leads exported from the clinic's previous CRM ("Unified_Leads_*_Pipeline.csv")
// into Cara. Writes Prisma rows directly — NOT through ingestLead — so an import never
// triggers the AI first call, round-robin assignment, the follow-up ladder or consent
// audit rows. It also stamps the fields the background sweeps key off, so ~10k old
// leads don't flood Slack (stage SLA), WhatsApp (win-back), follow-up reminders or the
// post-sales overdue scan the first time the worker ticks.
//
// One lead per phone (last 10 digits). Rows sharing a phone, within or across files,
// merge into one lead: the most advanced row (Post > Pre, then latest) sets the stage
// and the others contribute their remarks as comments. Leads carry
// externalId "legacy:<phone>", so a re-run (or a later file) skips phones already
// imported, and phones that already exist as a normal Cara lead are skipped too.
//
// Per lead it creates:
//   - Lead       stage/status/lost tag/interest/source/campaign mapped from the legacy
//                fields, createdAt = legacy creation date, default branch
//   - Comments   one "imported from" summary + every legacy Remark N (author + time)
//   - Follow-up  one pending step at next_followup_date (open leads only)
//   - Quote      "Quotation Sent" → sent; Converted → converted + closed journey
//
// Run:  npm run import:leads -- <file.csv> [more.csv …]            (dry run, no writes)
//       npm run import:leads -- <file.csv> … --apply                (write)
//       npm run import:leads -- <file.csv> … --rep-map reps.json    (assign owners)
//   reps.json maps a legacy assigned_to value to a SalesRep name, e.g.
//   { "Kamal": "Kamal Shah", "Anita Cara": "Anita" } — unmapped leads stay unassigned.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { dialablePhone } from "@/lib/phone";
import type { LeadStage, LostTag } from "@/lib/leadStages";

type Row = Record<string, string>;

/// Minimal CSV parser: quoted fields, commas/newlines inside quotes, "" escapes.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      record.push(field);
      field = "";
    } else if (c === "\n") {
      record.push(field);
      rows.push(record);
      record = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field || record.length) {
    record.push(field);
    rows.push(record);
  }
  return rows;
}

/// The legacy export writes some column names with raw (unquoted) line breaks in them,
/// which splits the header across several physical lines. Glue header lines back
/// together until the header is as wide as the data rows.
function readRows(path: string): Row[] {
  const raw = parseCsv(readFileSync(path, "utf8").replace(/^﻿/, ""));
  const widths = new Map<number, number>();
  for (const r of raw.slice(1, 200)) widths.set(r.length, (widths.get(r.length) ?? 0) + 1);
  const width = [...widths.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  const header = raw.shift() ?? [];
  while (header.length < width && raw.length) {
    const next = raw.shift()!;
    header[header.length - 1] += " " + next[0];
    header.push(...next.slice(1));
  }
  if (header.length !== width) throw new Error(`${path}: header has ${header.length} columns, rows have ${width}`);
  const names = header.map((h) => h.trim());
  return raw
    .filter((r) => r.length === width)
    .map((r) => Object.fromEntries(names.map((n, i) => [n, (r[i] ?? "").trim()])));
}

/// "2026-10-19 14:37:00" (IST wall clock) → Date.
function parseIsoIst(v: string): Date | null {
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}+05:30`);
}

/// "19-10-2026, 4:23 pm" (IST) → Date.
function parseRemarkTime(v: string): Date | null {
  const m = v.match(/^(\d{1,2})-(\d{1,2})-(\d{4}),?\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (!m) return null;
  let h = Number(m[4]);
  const ap = m[6]?.toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  const p = (n: number | string) => String(n).padStart(2, "0");
  return new Date(`${m[3]}-${p(m[2])}-${p(m[1])}T${p(h)}:${m[5]}:00+05:30`);
}

function phoneKey(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 6) return null;
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function money(v: string | undefined): number | null {
  const n = Number((v ?? "").replace(/[₹,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

// ---------------------------------------------------------------- field mapping

type Outcome = "open" | "quoted" | "converted" | "lost";

function mapStage(r: Row): { stage: LeadStage; outcome: Outcome } {
  const s = r.lead_stage.toLowerCase();
  const st = r.lead_status.toLowerCase();
  if (s === "lost" || (st === "lost" && !s.includes("convert"))) return { stage: "lost", outcome: "lost" };
  if (s.includes("convert") || s.startsWith("existing") || st === "converted")
    return { stage: "consultation_done", outcome: "converted" };
  if (s === "quotation sent") return { stage: "consultation_done", outcome: "quoted" };
  if (
    s === "consultation done" ||
    s.startsWith("follow up") ||
    s.startsWith("negotiation") ||
    s.startsWith("verbal")
  )
    return { stage: "consultation_done", outcome: "open" };
  if (s === "appointment scheduled") return { stage: "appointment_scheduled", outcome: "open" };
  if (s === "in consideration") return { stage: "in_consideration", outcome: "open" };
  if (s === "communication not established") return { stage: "communication_not_established", outcome: "open" };
  return { stage: "ai_contacted", outcome: "open" }; // Fresh Inquiry, Ringing, blank
}

const STAGE_RANK: Record<LeadStage, number> = {
  ai_contacted: 0,
  ai_attempted_unreachable: 1,
  communication_not_established: 2,
  human_callback_pending: 3,
  in_consideration: 4,
  appointment_scheduled: 5,
  consultation_done: 6,
  lost: -1,
};
const OUTCOME_RANK: Record<Outcome, number> = { lost: 0, open: 1, quoted: 2, converted: 3 };

const LOST_TAG_MAP: Record<string, LostTag> = {
  "not interested": "Not interested",
  "did not enquire": "Did not enquire",
  "location issue": "Location issue",
  "invalid number": "Wrong number",
  "wrong number": "Wrong number",
  "chose competitor": "Chose competitor",
  "chose other clinic": "Chose competitor",
  "budget issue": "Pricing issue",
  "pricing issue": "Pricing issue",
  "enquired for different product": "Enquired for different product",
  "enquired for competitor": "Enquired for competitor",
  "clinic staff": "Clinic staff",
  nonsense: "Nonsense",
};

function mapSource(r: Row): string {
  const t = r.source_type.toUpperCase();
  const c = r.campaign_name.toLowerCase();
  if (t === "INSTAGRAM") return "instagram";
  if (t === "FACEBOOK_ADS" || c.startsWith("fb_")) return "facebook";
  if (t.includes("IVR") || t.includes("NEODOVE") || t.includes("INCOMING")) return "inbound_call";
  if (t === "WALK_IN_LEAD") return "walk_in";
  if (t === "CUSTOM_INTEGRATION" || c.includes("website")) return "web_form";
  return "manual";
}

/// Treatment interest from the campaign name (e.g. "FB_HT_Qualified_Campaign", "PRP Post Consult").
function mapInterest(campaign: string): string | null {
  const c = ` ${campaign.toUpperCase().replace(/[_|-]/g, " ")} `;
  if (c.includes(" HT ") || c.includes("HAIR TRANSPLANT")) return "Hair transplant";
  if (c.includes(" PRP ")) return "PRP";
  if (c.includes(" LHR ") || c.includes("LASER")) return "Laser hair reduction";
  if (c.includes(" NSR ")) return "NSR";
  if (c.includes(" BT ")) return "BT";
  if (c.includes("HAIR TREATMENT")) return "Hair treatment";
  if (c.includes("SKIN")) return "Skin treatment";
  return null;
}

// ---------------------------------------------------------------- build

type Src = { row: Row; file: string; pipeline: string; post: boolean; created: Date | null };

function pickPrimary(rows: Src[]): Src {
  return [...rows].sort((a, b) => {
    const ma = mapStage(a.row);
    const mb = mapStage(b.row);
    return (
      OUTCOME_RANK[mb.outcome] - OUTCOME_RANK[ma.outcome] ||
      Number(b.post) - Number(a.post) ||
      STAGE_RANK[mb.stage] - STAGE_RANK[ma.stage] ||
      (b.created?.getTime() ?? 0) - (a.created?.getTime() ?? 0)
    );
  })[0];
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const mapIdx = args.indexOf("--rep-map");
  const repMapPath = mapIdx >= 0 ? args[mapIdx + 1] : null;
  const files = args.filter((a, i) => !a.startsWith("--") && !(mapIdx >= 0 && i === mapIdx + 1));
  if (!files.length) throw new Error("Usage: npm run import:leads -- <file.csv> [...] [--apply] [--rep-map reps.json]");

  const now = new Date();
  const branch =
    (await prisma.branch.findFirst({ where: { isDefault: true } })) ?? (await prisma.branch.findFirst());
  if (!branch) throw new Error("No branch configured");

  const reps = await prisma.salesRep.findMany({ select: { id: true, name: true } });
  const repMap: Record<string, string> = repMapPath ? JSON.parse(readFileSync(repMapPath, "utf8")) : {};
  const repIdFor = (legacy: string): string | null => {
    const target = repMap[legacy];
    if (!target) return null;
    const rep = reps.find((r) => r.name.toLowerCase() === target.toLowerCase());
    if (!rep) throw new Error(`--rep-map: no SalesRep named "${target}" (for "${legacy}")`);
    return rep.id;
  };

  // Group every row from every file by phone.
  const groups = new Map<string, Src[]>();
  let rowsRead = 0;
  let noPhone = 0;
  for (const file of files) {
    const rows = readRows(file);
    const name = basename(file);
    const post = /post/i.test(name);
    const pipeline = post ? "Post-Consult" : /pre/i.test(name) ? "Pre-Consult" : name;
    console.log(`${name}: ${rows.length} rows (${pipeline})`);
    for (const row of rows) {
      rowsRead++;
      const key = phoneKey(row.contact_number);
      if (!key) {
        noPhone++;
        continue;
      }
      const list = groups.get(key) ?? [];
      list.push({ row, file: name, pipeline, post, created: parseIsoIst(row.creation_date) });
      groups.set(key, list);
    }
  }

  // Skip phones Cara already has (earlier import, or a lead entered in Cara itself).
  const existing = await prisma.lead.findMany({
    where: { deletedAt: null },
    select: { phone: true, externalId: true },
  });
  const known = new Map<string, "legacy" | "cara">();
  for (const l of existing) {
    const k = phoneKey(l.phone);
    if (k) known.set(k, l.externalId?.startsWith("legacy:") ? "legacy" : "cara");
  }

  const leads: Prisma.LeadCreateManyInput[] = [];
  const comments: { id: string; leadId: string; authorName: string | null; body: string; createdAt: Date }[] = [];
  const steps: Prisma.LeadFollowUpStepCreateManyInput[] = [];
  const quotes: Prisma.QuoteCreateManyInput[] = [];
  const journeys: Prisma.PostSalesJourneyCreateManyInput[] = [];

  const stats = {
    rowsRead,
    noPhone,
    mergedRows: 0,
    skippedAlreadyImported: 0,
    skippedExistingCaraLead: 0,
    undialable: 0,
    unnamed: 0,
    stages: {} as Record<string, number>,
    lostTags: {} as Record<string, number>,
    sources: {} as Record<string, number>,
    interests: {} as Record<string, number>,
    assignees: {} as Record<string, number>,
  };
  const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);

  for (const [key, srcs] of groups) {
    const seen = known.get(key);
    if (seen === "legacy") {
      stats.skippedAlreadyImported++;
      continue;
    }
    if (seen === "cara") {
      stats.skippedExistingCaraLead++;
      continue;
    }
    stats.mergedRows += srcs.length - 1;

    const p = pickPrimary(srcs);
    const r = p.row;
    const { stage, outcome } = mapStage(r);
    const leadId = randomUUID();
    const created = p.created ?? now;
    const lastTouch = parseIsoIst(r.last_call_date) ?? created;

    const name = r.contact_name || r["Other_Details: Full Name"] || srcs.map((s) => s.row.contact_name).find(Boolean) || "Unknown";
    if (name === "Unknown") stats.unnamed++;
    const phone = dialablePhone(r.contact_number) ?? `+${r.contact_number.replace(/\D/g, "")}`;
    if (!dialablePhone(r.contact_number)) stats.undialable++;
    const email = srcs.map((s) => s.row.contact_email).find((e) => /@/.test(e)) ?? null;
    const interest = srcs.map((s) => mapInterest(s.row.campaign_name)).find(Boolean) ?? null;
    const source = mapSource(r);
    const repId = repIdFor(r.assigned_to);

    const legacyTag = r.lead_tag;
    const prio = legacyTag.match(/^(high|medium|low)\s+priority$/i)?.[1].toLowerCase() ?? null;
    let lostTag: LostTag | null = null;
    let lostReason: string | null = null;
    if (outcome === "lost") {
      lostTag = LOST_TAG_MAP[legacyTag.toLowerCase()] ?? "Other";
      const why = [lostTag === "Other" ? legacyTag : "", r.dispose_remarks]
        .filter(Boolean)
        .join(" — ");
      lostReason = why || "Imported as lost from the previous CRM";
      bump(stats.lostTags, lostTag === "Other" ? `Other (${legacyTag || "—"})` : lostTag);
    }
    bump(stats.stages, outcome === "open" ? stage : `${stage} + ${outcome}`);
    bump(stats.sources, source);
    bump(stats.interests, interest ?? "—");
    bump(stats.assignees, `${r.assigned_to || "—"}${repId ? " → assigned" : ""}`);

    leads.push({
      id: leadId,
      name,
      phone,
      email,
      interest,
      source,
      status: outcome === "lost" ? "lost" : "manual_followup",
      interestLevel: prio,
      stage,
      tag: !prio && outcome !== "lost" && legacyTag ? legacyTag : null,
      remark: r.dispose_remarks || null,
      stageChangedAt: lastTouch,
      stageStuckNotifiedAt: now, // stage-SLA scan: treat as already alerted
      lostTag,
      lostReason,
      lostAt: outcome === "lost" ? lastTouch : null,
      prematureLost: false,
      lastWinBackAt: outcome === "lost" ? now : null, // win-back sweep: already handled
      needsHandover: false,
      assignedRepId: repId,
      assignedAt: repId ? now : null,
      branchId: branch.id,
      externalId: `legacy:${key}`,
      campaign: r.campaign_name || null,
      adId: r["Other_Details: Ad Id"] || null,
      createdAt: created,
    });

    // Comments: a summary of what the old CRM said, then every remark it kept.
    const summary = srcs
      .map((s) =>
        [
          `Imported from previous CRM (${s.pipeline} pipeline, ${s.file}).`,
          `Stage: ${s.row.lead_stage || "—"} · Status: ${s.row.lead_status || "—"}`,
          s.row.lead_tag && `Tag: ${s.row.lead_tag}`,
          s.row.assigned_to && `Assigned to: ${s.row.assigned_to}`,
          s.row.campaign_name && `Campaign: ${s.row.campaign_name} (${s.row.source_type})`,
          s.row.alternate_number && `Alternate number: ${s.row.alternate_number}`,
          s.row.deal_amount && `Deal amount: ${s.row.deal_amount}`,
          s.row.next_followup_date && `Next follow-up was: ${s.row.next_followup_date}`,
        ]
          .filter(Boolean)
          .join("\n"),
      )
      .join("\n\n");
    comments.push({ id: randomUUID(), leadId, authorName: "Legacy import", body: summary, createdAt: created });

    const bodies = new Set<string>();
    for (const s of srcs) {
      for (let n = 1; n <= 40; n++) {
        const body = (s.row[n === 1 ? "Remark 1 (latest)" : `Remark ${n}`] ?? "").trim();
        if (!body || bodies.has(body)) continue;
        bodies.add(body);
        comments.push({
          id: randomUUID(),
          leadId,
          authorName: s.row[`Remark ${n} Added By`] || null,
          body,
          createdAt: parseRemarkTime(s.row[`Remark ${n} Timestamp`] ?? "") ?? s.created ?? created,
        });
      }
      const dispose = s.row.dispose_remarks.trim();
      if (dispose && !bodies.has(dispose)) {
        bodies.add(dispose);
        comments.push({ id: randomUUID(), leadId, authorName: s.row.assigned_to || null, body: dispose, createdAt: lastTouch });
      }
    }

    // The next follow-up the old CRM had scheduled (open leads only).
    const fu = parseIsoIst(r.next_followup_date);
    if (fu && outcome !== "lost" && outcome !== "converted") {
      steps.push({
        id: randomUUID(),
        leadId,
        order: 0,
        title: "Follow up (carried over from previous CRM)",
        channel: "call",
        dueAt: fu,
        status: "pending",
        ownerKind: "rep",
        ownerRepId: repId,
        source: "manual",
        remindedAt: now, // reminder sweep: don't fire for the backlog
      });
    }

    if (outcome === "quoted" || outcome === "converted") {
      const quoteId = randomUUID();
      const price =
        money(r.deal_amount) ?? money(r["Other_Details: Amt Payable"]) ?? money(r["Other_Details: Total Price"]);
      const convertedAt = outcome === "converted" ? lastTouch : null;
      quotes.push({
        id: quoteId,
        leadId,
        treatment: interest ?? r["Other_Details: Category"] ?? "Treatment (from previous CRM)",
        status: outcome === "converted" ? "converted" : "sent",
        price,
        totalPayable: price,
        source: "legacy_import",
        branchId: branch.id,
        ownerRepId: repId,
        convertedAt,
        lockedAt: convertedAt,
        createdAt: created,
      });
      if (outcome === "converted") {
        journeys.push({
          id: randomUUID(),
          quoteId,
          leadId,
          stage: "closed_successfully",
          stageChangedAt: now,
          overdueNotifiedAt: now,
          branchId: branch.id,
          openedAt: convertedAt ?? created,
          closedAt: now,
          closedNote: "Converted in the previous CRM — imported closed, no post-sales follow-up",
        });
      }
    }
  }

  console.log("\n--- summary ---");
  console.log(JSON.stringify({ ...stats, toCreate: { leads: leads.length, comments: comments.length, followUps: steps.length, quotes: quotes.length, journeys: journeys.length } }, null, 2));

  if (!apply) {
    console.log("\nDry run — nothing written. Re-run with --apply to import.");
    return;
  }

  for (const c of chunk(leads, 1000)) await prisma.lead.createMany({ data: c });
  for (const c of chunk(comments, 2000)) await prisma.leadComment.createMany({ data: c });
  for (const c of chunk(steps, 2000)) await prisma.leadFollowUpStep.createMany({ data: c });
  for (const c of chunk(quotes, 1000)) await prisma.quote.createMany({ data: c });
  for (const c of chunk(journeys, 1000)) await prisma.postSalesJourney.createMany({ data: c });
  console.log(`\nImported ${leads.length} leads.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
