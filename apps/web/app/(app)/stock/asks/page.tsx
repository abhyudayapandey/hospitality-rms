import { redirect } from 'next/navigation';

// Asks to one's head are listed with every other request under Things I asked for (ADR 142).
export default function MyAsksPage() {
  redirect('/requests');
}
