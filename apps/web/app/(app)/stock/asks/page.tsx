import { redirect } from 'next/navigation';

// Asks to one's head are listed with every other request under RFMs, Previous asks (ADR 142, 143).
export default function MyAsksPage() {
  redirect('/requests?tab=asked');
}
