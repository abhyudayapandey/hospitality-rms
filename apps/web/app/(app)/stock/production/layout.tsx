import { ModuleGate } from '@/components/module-gate';

// Shown only while the company has the module on (ADR 026).
export default function Layout({ children }: { children: React.ReactNode }) {
  return <ModuleGate code="production">{children}</ModuleGate>;
}
