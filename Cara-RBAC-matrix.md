# Cara CRM — Role Access Matrix (fill & return)

Edit any cell you disagree with, answer the **Decisions** at the bottom, add
roles/rows if you need them, then send this file back.

**Legend**
- **Y** — allowed
- **N** — not allowed
- **OWN** — allowed, but only for the user's own / assigned leads
- **LTD** — limited (explain in the Notes column)
- **?** — open question — your call

Cells pre-filled with my proposal; change anything. `?` marks the ones I most need your decision on.

---

## 1. Capability matrix

| # | Capability | Front-Desk | Telecaller / Counsellor | Branch Manager | Sales Head | CRM Admin | Notes |
|---|------------|:---------:|:-----------------------:|:--------------:|:----------:|:---------:|-------|
| 1 | View leads (list & detail) | Y (read) | Y | Y | Y | Y | |
| 2 | Lead visibility scope (ALL vs OWN) | ALL | ? | ALL | ALL | ALL | see Decision 2 |
| 3 | Create lead (manual entry) | Y | Y | Y | N | Y | |
| 4 | Walk-in entry (+ consent) | Y | Y | Y | N | Y | |
| 5 | Edit stage | LTD | Y | Y | Y | Y | FD = appointment only? |
| 6 | Edit tag / interest | N | Y | Y | Y | Y | |
| 7 | Click-to-call (record) | N | Y | Y | Y | Y | |
| 8 | Send WhatsApp (freeform + template) | N | Y | Y | Y | Y | |
| 9 | Merge duplicate leads | N | Y | Y | Y | Y | |
| 10 | Mark Lost (preset tag / review) | N | Y | Y | Y | Y | |
| 11 | Delete lead → trash (soft) | N | ? | Y | N | Y | see Decision 4 |
| 12 | Restore from trash | N | N | Y | N | Y | |
| 13 | Permanent delete | N | N | N | N | Y | |
| 14 | View calls / recordings / transcripts | N | Y (own) | Y | Y | Y | |
| 15 | View CQS scores | N | Y (own) | Y | Y | Y | |
| 16 | Dashboard / analytics | N | N | Y | Y | Y | |
| 17 | CQS dashboard | N | N | Y | Y | Y | |
| 18 | Manage WhatsApp templates | N | N | Y | N | Y | |
| 19 | Manage sales-rep roster | N | N | Y | Y | Y | |
| 20 | Manage settings / integrations | N | N | N | N | Y | |
| 21 | Manage users & roles | N | N | N | N | Y | |

*(Add rows for anything I missed, or columns for future roles.)*

---

## 2. Slack alert routing (who receives which alert)

| Alert | Recipient role(s) |
|-------|-------------------|
| Handover required (per lead) | Assigned Telecaller |
| Counsellor oversight feed | Telecaller + Branch Manager |
| Daily digest | Branch Manager |
| CQS extremes (≥ 90 / ≤ 15) | Sales Head |
| System health / downtime | CRM Admin + Branch Manager |

*(Change recipients as you like.)*

---

## 3. Decisions (please answer)

1. **Login = SalesRep?** Should each telecaller/manager have ONE login account that also *is* their sales-rep identity (needed for "own leads" + call attribution)?
   → **Answer:** _______________

2. **Telecaller lead visibility:** ALL leads (shared pool) or only their OWN/assigned?
   → **Answer:** _______________

3. **Branches:** one branch for now, or do we need to add a Branch concept and scope managers/leads to a branch?
   → **Answer:** _______________

4. **Delete rights:** can Telecallers soft-delete junk leads, or Managers/Admin only? (Permanent delete stays CRM-Admin-only either way.)
   → **Answer:** _______________

5. **Front-Desk scope:** view + walk-in only, or can they also book/reschedule appointments (edit stage → Appointment Scheduled)?
   → **Answer:** _______________

6. **Managers / Sales Head:** hands-on (call, WhatsApp) as in the matrix, or oversight/read + config only?
   → **Answer:** _______________

---

## 4. Future roles (add here)

- _______________  (which capabilities?)

## 5. Notes / anything else

- _______________
