import { ImageResponse } from 'next/og';

// PNG app icons for the manifest, rendered at build time.
export function appIcon(size: number, maskable = false): ImageResponse {
  const pad = maskable ? size * 0.2 : 0;
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0f172a',
        borderRadius: maskable ? 0 : size * 0.18,
        padding: pad,
      }}
    >
      <div style={{ color: '#f8fafc', fontSize: (size - pad * 2) * 0.42, fontWeight: 700 }}>OO</div>
    </div>,
    { width: size, height: size },
  );
}
