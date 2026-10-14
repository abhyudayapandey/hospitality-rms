import { redirect } from 'next/navigation';

// One To do list (ADR 145): approvals and tasks are on the same screen, /tasks.
export default function InboxPage() {
  redirect('/tasks');
}
