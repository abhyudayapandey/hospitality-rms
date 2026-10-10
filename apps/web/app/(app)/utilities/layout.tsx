import { ModuleGate } from '@/components/module-gate';

// Shown only while the customer has the block on (ADR 085).
export default function Layout({ children }: { children: React.ReactNode }) {
  return <ModuleGate code="utilities">{children}</ModuleGate>;
}
