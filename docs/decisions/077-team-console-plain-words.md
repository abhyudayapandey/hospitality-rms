# 077 — The team console speaks plainly

Status: accepted · 2026-10-07 · no migration

The platform console (ADR 012) is used by Outlet Ops staff only; customers never see it. It
had grown in the words of how it works: two links ran together on its first page ("New
customer: the company and its owner onlyOutlet templates: …") whenever no set-up was in
progress, customer codes sat beside names, a Reason box and Suspend button stood on every
customer row, imports spoke of dry runs, applying and tables ("org places", "job role
access"), jobs showed their kind and raw state ("Import: dry run · TEST-COMPANY · done"),
and the logins page explained Cognito's email allowance. Our own team found it hard to
read. The rule of the customer app (people who onboard never see a code; a step or status
is never shown as its code) now holds in the console too.

## Decision

1. **Its first page has one main action**, "Set up a new customer", with a line saying what
   it does; then set-ups in progress, the customers (name, Active or Paused, Demo, people,
   last sign-in; no codes), recent activity in words, and last, as separate rows, **Other
   tools**: "Kinds of outlet" and "Add a customer from their files". The header says it is
   the team console and that customers never see it.
2. **Pausing a customer is on its page**, at the bottom, behind a tap ("Pause this
   customer"), with what it does; never on the list.
3. **A customer's page**: Add an outlet (main), Sign-ins for their people, Update from their
   files; **What they buy**, each bundle saying what it adds (`adds` in `bundles.ts`, which
   replaces `includes`: stock, orders and the roster are in every plan, so a bundle "adds"
   to them); account owners as name, how they sign in and whether they have; History.
4. **Files**: "Upload and check", then "Load these changes"; the report's rows are named as
   people say them (`countLabel`), its summary says what loading would do, and what is
   worth a look doesn't stop loading. Problems keep their file, row and column, to find them.
5. **Background work** reads as what it did ("Checked their files · Test Company") and how
   far it got (Waiting to start, Working on it…, Finished, Didn't finish).
6. **Sign-ins**: people without an email (a login ID and a printed one-time password) and
   people with one (an invitation; at most 40 a day for all customers, the rest go by
   themselves). Demo passwords are "demo passwords".
7. **Add an outlet asks for no code**: it is made from the outlet's name and the customer's
   code (`addOutlet`), numbered when taken, as the set-up wizard does (ADR 064).

## Consequences

- e2e: `platform.spec.ts` checks the first page at 380 px with one main action, the list,
  then each other tool on its own row; pausing happens on the customer's page; the import,
  sign-in and add-outlet specs read the new words, and add-outlet checks the code made from
  the name.
- Job and customer states keep their stored values; only their words changed. The
  `job-status` element carries `data-status` for tests that wait on the worker.
