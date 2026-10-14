import { redirect } from 'next/navigation';

// Ask for something is the Ask tab of RFMs (ADR 143).
export default async function NewAskPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const store = typeof sp['store'] === 'string' ? `&store=${encodeURIComponent(sp['store'])}` : '';
  redirect(`/requests?tab=ask${store}`);
}
