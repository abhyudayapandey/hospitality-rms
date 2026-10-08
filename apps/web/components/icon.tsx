// Drawn line icons (UX-6, ADR 034): one stroke weight, no fill, the colour of the text
// around them. Inline SVG, so no icon font or package and nothing to download.

const PATHS = {
  home: ['M3 11l9-7 9 7', 'M5 10v10h14V10'],
  clock: ['M12 7v5l3 2', 'circle:12,12,9'],
  check: ['M5 12l4 4 10-10'],
  list: ['M9 6h11M9 12h11M9 18h11', 'M4 6h.01M4 12h.01M4 18h.01'],
  tasks: ['M4 6l1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17', 'M11 6h9M11 12h9M11 18h9'],
  pot: ['M4 10h16v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z', 'M2 10h20M9 6c0-1 1-2 1-3M14 6c0-1 1-2 1-3'],
  glass: ['M6 3h12l-1 7a5 5 0 0 1-10 0z', 'M12 15v6M8 21h8'],
  calendar: ['rect:3,5,18,16,2', 'M3 10h18M8 3v4M16 3v4'],
  leaf: ['M5 19c0-8 6-14 15-14 0 9-6 15-14 15', 'M5 19l7-7'],
  wrench: ['M14 6a4 4 0 0 0 5 5l-8 8a2 2 0 0 1-3-3z'],
  box: ['M3 7l9-4 9 4v10l-9 4-9-4z', 'M3 7l9 4 9-4M12 11v10'],
  truck: ['M3 6h11v10H3zM14 10h4l3 3v3h-7', 'circle:7,18,2', 'circle:17,18,2'],
  down: ['M12 4v12M6 10l6 6 6-6M4 20h16'],
  chart: ['M4 20V10M10 20V4M16 20v-7M22 20H2'],
  camera: ['rect:3,7,18,13,2', 'M8 7l2-3h4l2 3', 'circle:12,13,3.5'],
  alert: ['M12 3l10 18H2z', 'M12 10v5M12 18h.01'],
  user: ['circle:12,8,4', 'M4 21c1-4 4-6 8-6s7 2 8 6'],
  people: [
    'circle:9,8,3.5',
    'M2 20c.8-3.5 3.5-5 7-5s6.2 1.5 7 5',
    'M16 4.5a3.5 3.5 0 0 1 0 7M22 20c-.5-2.5-2-4-4-4.6',
  ],
  bed: ['M3 18V8M3 14h18v4M21 14v-2a3 3 0 0 0-3-3h-7v5', 'circle:7,11,2'],
  plate: ['circle:12,13,7', 'circle:12,13,3', 'M3 4v6M21 4v16'],
  inbox: ['M3 13l3-8h12l3 8v6H3z', 'M3 13h5l1 2h6l1-2h5'],
  bell: ['M6 16V11a6 6 0 0 1 12 0v5l2 2H4z', 'M10 21h4'],
  gear: [
    'circle:12,12,3',
    'M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.5a2 2 0 0 1-1 1.7l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.7v-.5a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2z',
  ],
  book: ['M4 4h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4z', 'M20 4h-6a3 3 0 0 0-3 3', 'M20 4v14h-6'],
  cart: ['M3 4h2l2.5 11h11L21 7H6.2', 'circle:9,19,1.5', 'circle:17,19,1.5'],
  swap: ['M4 8h13l-3-3M20 16H7l3 3'],
  trash: ['M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13'],
  clipboard: ['rect:5,4,14,17,2', 'M9 4V3h6v1', 'M9 11h6M9 15h4'],
  sun: [
    'circle:12,12,4',
    'M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5',
  ],
  moon: ['M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z'],
  grid: ['rect:4,4,7,7,1.5', 'rect:13,4,7,7,1.5', 'rect:4,13,7,7,1.5', 'rect:13,13,7,7,1.5'],
  chevron: ['M9 6l6 6-6 6'],
  back: ['M15 6l-6 6 6 6'],
  plus: ['M12 5v14M5 12h14'],
  minus: ['M5 12h14'],
  x: ['M6 6l12 12M18 6L6 18'],
  out: ['M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5', 'M10 16l-4-4 4-4M6 12h10'],
  sales: ['M6 3h12v18l-3-2-3 2-3-2-3 2z', 'M9 8h6M9 12h6'],
  bill: ['M6 3h12v18l-3-2-3 2-3-2-3 2z', 'M9 7h6M9 11h6M9 15h3'],
  upload: ['M12 16V4M6 10l6-6 6 6M4 20h16'],
  fire: ['M12 3c1 4 6 6 6 11a6 6 0 0 1-12 0c0-3 2-5 3-7 1 2 2 3 3 3 0-3-1-5 0-7z'],
  // a certificate with its seal: licences and compliance (ADR 069)
  shield: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', 'M9 12l2 2 4-4'],
  star: ['M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z'],
  // hospitality pictograms for tasks and their steps (ADR 079), the same weight and style
  bottle: [
    'M10 3h4v4l1.5 2.5V20a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1V9.5L10 7z',
    'M8.5 13h7',
    'M3 21h18',
  ],
  // a small bottle: a nip or a miniature beside the full bottle on the count sheet (ADR 079)
  nip: ['M10.5 8h3v2.5l1 1.5V20a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-8l1-1.5z', 'M3 21h18'],
  thermometer: ['M10 4a2 2 0 0 1 4 0v10.5a4 4 0 1 1-4 0z', 'M12 9v8', 'circle:12,17.5,1.5'],
  mop: ['M12 3v11', 'M7 21l1.5-7h7L17 21', 'M10 21v-3M14 21v-3'],
  broom: ['M18 3l-6.5 9', 'M8 12.5l5 3.5-2 5H5z', 'M8 21l1.5-3M11.5 21l.5-2'],
  handwash: [
    'M4 14h4l3 2h4a1.5 1.5 0 0 1 0 3H9',
    'M4 20h12l5-4a1.5 1.5 0 0 0-2-2l-3 2',
    'M15 3c1.5 2 2.5 3.2 2.5 4.5a2.5 2.5 0 0 1-5 0C12.5 6.2 13.5 5 15 3z',
  ],
  fridge: ['rect:6,2,12,20,2', 'M6 9h12', 'M9 5v2M9 12v4'],
  oil: ['M12 3c3 4 6 7.5 6 11a6 6 0 0 1-12 0c0-3.5 3-7 6-11z', 'M9 15a3 3 0 0 0 3 3'],
  towel: ['M6 3h12v15H6z', 'M6 18l2 3h12l-2-3', 'M6 8h12M6 12h12'],
  ice: ['rect:4,8,7,7,1.5', 'rect:13,8,7,7,1.5', 'rect:8.5,3,7,5,1.5', 'M7 18v3M17 18v2'],
  knife: ['M4 20l9-9', 'M13 11c2-4 5-7 7-8 0 3-2 7-5 10z', 'M7 17l-2-2'],
  extinguisher: [
    'M9 8h6a2 2 0 0 1 2 2v10a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V10a2 2 0 0 1 2-2z',
    'M12 8V5h3l3-2',
    'M10 13h4',
  ],
  spray: [
    'M8 9h6v11a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1z',
    'M9 9V6h4l2 1',
    'M17 4h.01M19 6h.01M17 8h.01M20 3h.01',
  ],
  lock: ['rect:5,11,14,10,2', 'M8 11V7a4 4 0 0 1 8 0v4', 'M12 15v2'],
  bulb: ['M9 18h6M10 21h4', 'M8 14a6 6 0 1 1 8 0c-1 1-1 2-1 4H9c0-2 0-3-1-4z'],
  tap: [
    'M4 9h9a3 3 0 0 1 3 3v2',
    'M8 9V6h3v3',
    'M6 6h7',
    'M16 18c.8 1 1.5 1.6 1.5 2.3a1.5 1.5 0 0 1-3 0c0-.7.7-1.3 1.5-2.3z',
  ],
  pool: [
    'M3 17c2 0 2-1.5 4.5-1.5S10 17 12 17s2-1.5 4.5-1.5S19 17 21 17',
    'M3 21c2 0 2-1.5 4.5-1.5S10 21 12 21s2-1.5 4.5-1.5S19 21 21 21',
    'M8 14V5a2 2 0 0 1 4 0M14 14V5a2 2 0 0 1 4 0M8 9h6',
  ],
  dumbbell: ['M3 10v4M21 10v4', 'rect:5,7,3,10,1', 'rect:16,7,3,10,1', 'M8 12h8'],
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  className = 'size-6',
  label,
}: {
  name: IconName;
  className?: string;
  /** a name for screen readers when the icon stands alone; otherwise it is hidden */
  label?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`shrink-0 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-icon={name}
    >
      {PATHS[name].map((d) => {
        if (d.startsWith('circle:')) {
          const [cx, cy, r] = d.slice(7).split(',');
          return <circle key={d} cx={cx} cy={cy} r={r} />;
        }
        if (d.startsWith('rect:')) {
          const [x, y, w, h, rx] = d.slice(5).split(',');
          return <rect key={d} x={x} y={y} width={w} height={h} rx={rx} />;
        }
        return <path key={d} d={d} />;
      })}
    </svg>
  );
}
