"use client";

// Type-to-pick treatment field for a new quote. Replaces a search box sitting above a
// separate <select>: staff typed into one control and then had to find the result in
// another, which read as "the dropdown doesn't respond to typing". Now the suggestions
// open under the field as you type, from the clinic's catalog (Services + Packages).
//
// Picking a suggestion hands the item back so the quote can fill its price, GST and any
// package discount. Typing something that isn't in the catalog is allowed — the text is
// the treatment, and the price is entered by hand (docs/flows/10-quote-lifecycle.md).
import { useId, useMemo, useRef, useState } from "react";
import type { CatalogGroups, CatalogOption } from "@/lib/catalog";

/// Enough to scan at a glance; typing narrows it further.
const MAX_SUGGESTIONS = 40;

type Suggestion = CatalogOption & { group: string };

export function TreatmentCombobox({
  catalog,
  value,
  onType,
  onPick,
  className,
}: {
  catalog: CatalogGroups[];
  /// The treatment text as it stands (picked name or free text).
  value: string;
  /// Free typing: the text is now the treatment, and no catalog item is selected.
  onType: (text: string) => void;
  onPick: (item: CatalogOption) => void;
  className?: string;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const all = useMemo<Suggestion[]>(
    () =>
      catalog.flatMap((g) =>
        g.categories.flatMap((c) => c.items.map((it) => ({ ...it, group: `${g.label} · ${c.category}` }))),
      ),
    [catalog],
  );

  // Every word typed must appear in the name or category, in any order — "prp hair"
  // finds "Hair PRP (3 sessions)". Names that START with the query rank first.
  const matches = useMemo(() => {
    const words = value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return all.slice(0, MAX_SUGGESTIONS);
    const q = value.trim().toLowerCase();
    return all
      .filter((it) => {
        const hay = `${it.name} ${it.group}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .sort((a, b) => Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)))
      .slice(0, MAX_SUGGESTIONS);
  }, [all, value]);

  const pick = (it: CatalogOption) => {
    onPick(it);
    setOpen(false);
  };

  const priceNote = (it: CatalogOption) =>
    it.discountValue
      ? `₹${it.price.toLocaleString("en-IN")} · ${it.discountValue}% off`
      : `₹${it.price.toLocaleString("en-IN")}${it.gstRate === 0 ? " · no GST" : ""}`;

  return (
    <div className="relative">
      <input
        ref={inputRef}
        className={className}
        placeholder="Treatment — start typing to pick from the catalog…"
        value={value}
        role="combobox"
        aria-expanded={open && matches.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
        onFocus={() => setOpen(true)}
        // Delay so a click on a suggestion lands before the list closes.
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onChange={(e) => {
          onType(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((i) => Math.min(i + 1, matches.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter" && open && matches[active]) {
            e.preventDefault();
            pick(matches[active]);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {open && matches.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded border border-black/15 bg-background py-1 text-sm shadow-lg dark:border-white/20"
        >
          {matches.map((it, i) => (
            <li
              key={it.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`flex cursor-pointer items-baseline justify-between gap-3 px-3 py-1.5 ${
                i === active ? "bg-black/5 dark:bg-white/10" : ""
              }`}
              onMouseEnter={() => setActive(i)}
              // mousedown, not click: it fires before the input's blur.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(it);
              }}
            >
              <span className="min-w-0">
                <span className="block truncate">{it.name}</span>
                <span className="block truncate text-xs text-black/45 dark:text-white/45">{it.group}</span>
              </span>
              <span className="shrink-0 text-xs text-black/60 tabular-nums dark:text-white/60">{priceNote(it)}</span>
            </li>
          ))}
        </ul>
      )}
      {open && value.trim() && matches.length === 0 && (
        <p className="absolute z-20 mt-1 w-full rounded border border-black/15 bg-background px-3 py-2 text-xs text-black/55 shadow-lg dark:border-white/20 dark:text-white/55">
          Not in the catalog — it will be quoted as typed; enter the price below.
        </p>
      )}
    </div>
  );
}
