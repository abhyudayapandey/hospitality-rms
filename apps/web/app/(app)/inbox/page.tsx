import { redirect } from 'next/navigation';

// One To do list (ADR 142): approvals and tasks are on the same screen, /tasks.
export default function InboxPage() {
  redirect('/tasks');
}
