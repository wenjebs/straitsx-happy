/*
 * 16x16 stroke glyphs standing in for a real icon set. If the codebase adopts
 * an icon library, swap the bodies here and nothing else changes.
 */

interface IconProps {
  size?: number;
}

function Glyph({ size = 16, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function BagIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M2 5.5h12l-1 8H3l-1-8Z" />
      <path d="M5.5 5.5V4a2.5 2.5 0 0 1 5 0v1.5" />
    </Glyph>
  );
}

export function CardIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect x="1.8" y="3.8" width="12.4" height="8.4" rx="1.6" />
      <path d="M1.8 6.6h12.4" />
    </Glyph>
  );
}

export function ShieldIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M8 1.8 13.2 4v4.2c0 3-2.2 5-5.2 6-3-1-5.2-3-5.2-6V4L8 1.8Z" />
    </Glyph>
  );
}

export function GearIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="8" cy="8" r="2.3" />
      <path d="M8 1.6v1.7M8 12.7v1.7M1.6 8h1.7M12.7 8h1.7M3.5 3.5l1.2 1.2M11.3 11.3l1.2 1.2M12.5 3.5l-1.2 1.2M4.7 11.3l-1.2 1.2" />
    </Glyph>
  );
}

export function PanelIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect x="2" y="3" width="12" height="10" rx="1.6" />
      <path d="M6.2 3v10" />
    </Glyph>
  );
}

export function ChevronLeftIcon({ size = 13 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M9.5 3.5 5 8l4.5 4.5" />
    </svg>
  );
}

export function ArrowUpIcon({ size = 15 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8 13V3.5M8 3.5 4 7.5M8 3.5l4 4" />
    </svg>
  );
}
