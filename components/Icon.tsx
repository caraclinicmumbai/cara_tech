// Inline SVG icons (§chrome).
//
// These replace the emoji and the Unicode dingbats the interface had been
// leaning on. Emoji are rendered by the operating system, not by the page: 👋
// and 🤝 are a different drawing on macOS, Windows, Android and Linux, some of
// them cartoonish, and a few of the dingbats (☎, ☀) silently switch to emoji
// presentation on their own. That is a lottery for a product being sold to
// clinic owners, and it costs nothing to draw them instead.
//
// One stroke weight, one 16-unit box, sized by the parent's font-size so they
// sit on the text baseline wherever they are used.
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 14, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/// A handset — leads that have never been called.
export const IconPhone = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 2.8h2.2l1.1 2.7-1.4.9a7.4 7.4 0 0 0 3.7 3.7l.9-1.4 2.7 1.1v2.2a1 1 0 0 1-1.1 1A10.6 10.6 0 0 1 2 3.9a1 1 0 0 1 1-1.1Z" />
  </Svg>
);

/// Two figures — a patient waiting for a counsellor.
export const IconHandover = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="5.6" cy="5" r="2" />
    <path d="M1.8 13c0-2 1.7-3.4 3.8-3.4S9.4 11 9.4 13" />
    <path d="M10.6 4.2a2 2 0 0 1 0 3.9M11.6 9.9c1.6.3 2.7 1.5 2.7 3.1" />
  </Svg>
);

/// Overlapping sheets — a duplicate record.
export const IconDuplicate = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5.4" y="5.4" width="8" height="8" rx="1.6" />
    <path d="M10.6 5.4V4a1.6 1.6 0 0 0-1.6-1.6H4A1.6 1.6 0 0 0 2.4 4v5a1.6 1.6 0 0 0 1.6 1.6h1.4" />
  </Svg>
);

/// A barred circle — outreach suppressed.
export const IconStopped = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.8" />
    <path d="M4 12 12 4" />
  </Svg>
);

/// Paused bars — held for review, nothing goes out.
export const IconHeld = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.2 3.4v9.2M9.8 3.4v9.2" />
  </Svg>
);

/// An exclamation in a circle — past due.
export const IconOverdue = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.8" />
    <path d="M8 5.2v3.4" />
    <circle cx="8" cy="10.9" r=".5" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconUp = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 12.6V3.7M4.2 7.4 8 3.6l3.8 3.8" />
  </Svg>
);

export const IconDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 3.4v8.9M11.8 8.6 8 12.4 4.2 8.6" />
  </Svg>
);

export const IconFlat = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.2 8h9.6" />
  </Svg>
);

/// Sun and moon for the theme toggle — ☀︎ and ☾ both flip to emoji on some
/// platforms, which made the control change size as it was pressed.
export const IconSun = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2.9" />
    <path d="M8 1.6v1.3M8 13.1v1.3M14.4 8h-1.3M2.9 8H1.6M12.5 3.5l-.9.9M4.4 11.6l-.9.9M12.5 12.5l-.9-.9M4.4 4.4l-.9-.9" />
  </Svg>
);

export const IconMoon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.2 9.6A5.8 5.8 0 0 1 6.4 2.8a5.8 5.8 0 1 0 6.8 6.8Z" />
  </Svg>
);
