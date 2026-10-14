import { ImageResponse } from 'next/og';
import { SENIOR_MARK_DRAWING } from './senior-mark';

// PNG app icons for the manifest, rendered at build time from Senior's mark (ADR 141): the
// drawing on a full teal square (the phone rounds the corners itself); a maskable icon keeps
// it inside the 80 % safe circle.
export function appIcon(size: number, maskable = false): ImageResponse {
  const scale = maskable ? 0.7 : 0.92;
  const s = (120 * (1 - scale)) / 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="${size}" height="${size}">` +
    `<g transform="translate(${s} ${s}) scale(${scale})">${SENIOR_MARK_DRAWING}</g></svg>`;
  return new ImageResponse(
    <div style={{ width: '100%', height: '100%', display: 'flex', background: '#1f5f57' }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- satori draws img, not next/image */}
      <img
        src={`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`}
        width={size}
        height={size}
        alt=""
      />
    </div>,
    { width: size, height: size },
  );
}
