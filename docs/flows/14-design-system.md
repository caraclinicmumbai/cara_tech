# Flow 14 — The design system

**What it is for.** Every colour, size and badge in the interface resolves through
one set of tokens in `app/globals.css`. This is the record of what they are and why,
so the next change to the look is a change to a handful of values rather than a
sweep through forty files — which is what the last one was.

The product's brand is **enori**. Cara Clinic is a tenant of it. That distinction is
the reason the separate identity exists: this is sold to clinics that compete with
each other, and none of them should see another practice's name on the masthead.

---

## The palette

| Role | Value | Where |
|---|---|---|
| Accent | `#3358E8` royal blue | navbar, primary button, chart bars, active nav item |
| Ground | `#F5F6F8` | the page, with white cards on it |
| Ink | `#14161D` | all typography |
| Lime | `#DDF26B` | a figure moving the way the clinic wants |

Token names are still `--cara-*`. They are consumed by several hundred call sites
and renaming them is a large diff for no behaviour change, so the prefix is history
rather than meaning. There is no CARA design any more — it was retired once every
screen had been converted, and the toggle that compared them went with it.

**Dark mode is derived, not specified.** The Brand Guidelines define no dark ramp —
only "on dark surfaces, switch *ori* to white" — so those values are extrapolated
and have never been through brand sign-off. Worth flagging before anyone treats them
as canonical.

## Tags — the one place with identity

Status badges answer *different* questions: is this a duplicate, has this person
opted out, is it held, does it need a counsellor. Four questions need four answers,
and **one hue cannot give four answers**.

This was measured rather than argued. Six blue/violet hues put the worst adjacent
pair at **ΔE 5.6 for normal colour vision**, against a floor of 15 — two badges most
people could not tell apart, before colour blindness enters into it. The supplied tag
palette clears it at **15.2 normal, 15.3** for the worst colour-blind pair.

Each badge carries **fill, ink and a drawn glyph** — so a state survives greyscale,
colour blindness and a printed page, none of which a block of colour does.

```
.tag .tag-blue .tag-lime .tag-aqua .tag-citric .tag-klein .tag-fushia .tag-tangerine .tag-ink
```

> ⚠️ **DEVIATION from the Brand Guidelines (p.11):** "Never introduce green or red
> status badges." This palette has both. It was supplied by the business for the tags
> specifically, so it is scoped to them — charts, trends and deltas stay on the blue
> ladder where the rule still holds.

## The other semantic classes

| Class | For |
|---|---|
| `.txt-bad` / `.txt-good` / `.txt-warn` | coloured sentences — validation, results |
| `.cara-notice` + `.is-bad/warn/good/info/violet` | the inline banners on a lead |
| `.bar-bad/good/warn/info` | meter fills |
| `.cara-btn-danger` | destructive buttons |
| `.tone-link` | links |
| `.cara-nav-link` / `.cara-nav-heading` | the sidebar |

Hues match the tag palette deliberately: a failed call in a sentence and a failed
call in a badge should not be two different reds.

## Type

**Two families.** Plus Jakarta Sans carries the interface; Playfair Display is
reserved for the logotype. Inter and Cormorant Garamond were dropped — four families
was three too many, and each was another render-blocking request.

Body is **13px**. The business asked for a 30% cut to the global scale and the
display end took it — h1 26→19, stat figures 32→22, hero figures 40→27 — but body
went 14→13, not 14→9.8. A third off the *reading* size is below any defensible
minimum for tables read all day on laptop screens. The density was bought from the
headline sizes and the padding, which is where the slack actually was.

## No emoji

Emoji are drawn by the operating system, not the page: 👋 and 🤝 are a different
picture on macOS, Windows, Android and Linux. Several dingbats (`☎`, `☀`) switch to
emoji presentation on their own, which was making the theme toggle change size as it
was pressed.

Everything is inline SVG in `components/Icon.tsx` — one stroke weight, one 16-unit
box, sized off the parent's font-size.

**Slack messages keep their emoji.** Slack renders them in its own client,
consistently, and they earn their place in an alert read at a glance on a phone.
That is a different context from the product UI.

## Charts

See [flows/12-reports.md](12-reports.md) for what is measured. On how they are drawn:

- Bars cap at **34px** and sit back in a soft periwinkle; only the busiest day
  carries the accent. The house rule caps columns at 24px to stop a bar filling its
  slot — at eight columns the slots are ~61px, so 34px still leaves a third of each
  band as air, which is what the cap protects.
- The source ring is a **sequential ramp**, ordered largest-to-smallest and
  darkest-to-lightest, capped at five segments with the tail folded into "Other".
  Identity lives in the legend — name, count and share, in text.
- Deltas compare **like for like**: the same elapsed stretch of the previous month,
  not all of it. Measuring fourteen days of September against a complete August made
  every figure report a collapse until the 28th.

## Files

- `app/globals.css` — every token and component class
- `components/Icon.tsx` — the icon set
- `components/SidebarNav.tsx` — the grouped nav and its active state
- `components/dashboard/*` — stat tiles, delta pills, the chart and ring
- `scripts/seedDemoData.ts` — `npm run seed:demo`, for looking at any of it with
  something in it
