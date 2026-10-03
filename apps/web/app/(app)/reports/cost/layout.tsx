import { ModuleGate } from '@/components/module-gate';

// Shown only while the company has Menu and sales on (ADR 026, 028).
export default function Layout({ children }: { children: React.ReactNode }) {
  return <ModuleGate code="menu_sales">{children}</ModuleGate>;
}
