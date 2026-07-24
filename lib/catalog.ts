// Treatment catalog (§quote generation). Reads the CatalogItem table (the clinic's
// Master Data List) and shapes it for the quote treatment picker: a flat, ordered list
// of options grouped by type (Service / Package) then category. Picking one auto-fills
// the quote's base price, GST, and — for packages — the built-in discount.
import { prisma } from "@/lib/prisma";

/// One selectable treatment for the quote picker (serialisable to the client).
export type CatalogOption = {
  id: string;
  type: "service" | "package" | string;
  category: string;
  name: string;
  /// Base price in whole rupees (service price, or a package's standard/pre-discount price).
  price: number;
  gstRate: number;
  /// A package's built-in discount % (percent), or null. Prefilled into the quote.
  discountValue: number | null;
  /// The package's already-discounted price, for display next to the option.
  packagePrice: number | null;
};

/// A category bucket of options, within a type group.
export type CatalogCategory = { category: string; items: CatalogOption[] };

/// The picker's data: options grouped by type ("service" | "package") → category.
export type CatalogGroups = { type: string; label: string; categories: CatalogCategory[] };

const TYPE_LABELS: Record<string, string> = { service: "Services", package: "Packages" };

/// Load all active catalog items, grouped by type then category, ordered for display.
export async function listCatalogGroups(): Promise<CatalogGroups[]> {
  const rows = await prisma.catalogItem.findMany({
    where: { active: true },
    orderBy: [{ type: "asc" }, { category: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
    select: {
      id: true,
      type: true,
      category: true,
      name: true,
      price: true,
      gstRate: true,
      defaultDiscountValue: true,
      packagePrice: true,
    },
  });

  // Services before Packages; within each, preserve the query's category/name order.
  const order = ["service", "package"];
  const byType = new Map<string, Map<string, CatalogOption[]>>();
  for (const r of rows) {
    const opt: CatalogOption = {
      id: r.id,
      type: r.type,
      category: r.category,
      name: r.name,
      price: r.price,
      gstRate: r.gstRate,
      discountValue: r.defaultDiscountValue ?? null,
      packagePrice: r.packagePrice ?? null,
    };
    if (!byType.has(r.type)) byType.set(r.type, new Map());
    const cats = byType.get(r.type)!;
    if (!cats.has(r.category)) cats.set(r.category, []);
    cats.get(r.category)!.push(opt);
  }

  const types = [...byType.keys()].sort(
    (a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99),
  );
  return types.map((type) => ({
    type,
    label: TYPE_LABELS[type] ?? type,
    categories: [...byType.get(type)!.entries()].map(([category, items]) => ({ category, items })),
  }));
}
