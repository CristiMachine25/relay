/**
 * The product name, drawn as monoline strokes so it needs no font and follows the theme.
 * The R's leg is a separate stroke in the accent color, echoing the two-tone icon.
 */
export function Wordmark({ height = 22, className }: { height?: number; className?: string }) {
  return (
    <svg
      role="img"
      aria-label="Relay"
      viewBox="0 0 70 28"
      height={height}
      width={(height * 70) / 28}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 20V4H9.5a4.5 4.5 0 0 1 0 9H3" />
      <path d="M9 14L15 20" className="stroke-hop" />
      <path d="M19 14H30.5A6 6 0 1 0 29.4 17.6" />
      <path d="M36 4V20" />
      <path d="M40.5 14a6 6 0 1 0 12 0a6 6 0 1 0-12 0M52.5 8V20" />
      <path d="M57.5 8L62.9 19.4M68.5 8L60.5 25.6" />
    </svg>
  )
}
