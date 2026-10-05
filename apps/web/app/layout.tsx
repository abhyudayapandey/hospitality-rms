import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { ServiceWorker } from '@/components/service-worker';
import { DEFAULT_THEME, THEME_SCRIPT } from '@/lib/theme';
import './globals.css';

export const metadata: Metadata = {
  title: 'Outlet Ops',
  description: 'Stock, orders, people and operations for every outlet.',
  appleWebApp: { capable: true, title: 'Outlet Ops', statusBarStyle: 'default' },
  icons: { icon: '/icons/icon-192.png', apple: '/icons/icon-192.png' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#1f5f57',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // dark by default; the head script applies the person's choice before the first paint
    <html lang="en" data-theme={DEFAULT_THEME} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-dvh bg-slate-50 text-slate-900 antialiased">
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
