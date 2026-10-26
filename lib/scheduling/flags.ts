// Patient flags (§3.2 "Cards and Flags for a Patient") — the shared vocabulary for
// the flag definitions an admin creates. Icons are keys into components/Icon.tsx (no
// emoji, per the design system); tones are the tag palette.

export const FLAG_ICONS = ["star", "alert", "heart", "dot"] as const;
export type FlagIcon = (typeof FLAG_ICONS)[number];

export const FLAG_ICON_LABELS: Record<FlagIcon, string> = {
  star: "Star",
  alert: "Alert",
  heart: "Heart",
  dot: "Dot",
};

export const FLAG_TONES = ["citric", "fushia", "tangerine", "aqua", "klein", "lime", "blue", "ink"] as const;
export type FlagTone = (typeof FLAG_TONES)[number];
