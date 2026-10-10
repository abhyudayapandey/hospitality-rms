# 095 — Audits & taste panels, Training & SOPs

Status: accepted · 2026-10-10 · migrations 20261211190000, 20261211200000

Passport's SOPs have a monthly service audit, a management taste panel, a handbook every
department must have read and training sessions with tests. Part of
`docs/plans/building-blocks.md`, PR 4; the Audits and Training blocks (ADR 085).

## Decision

1. **Audits are checklists with scored steps.** Two step kinds: `yesno` (yes, no or not
   applicable) and `rating` (1 to 5), in file 29 and the checklist editor. A template with a
   scored step belongs to the Audits block (`module = 'audits'`), so it runs on its schedule
   like any round (ADR 020, 087) but has no rounds while Audits is off. Nothing new schedules,
   assigns or signs off an audit.
2. **The score** of a done round (`ops.task_score`): yes = 1, no = 0, a rating of n = n / 5,
   not applicable left out; the mean as a %. The Audits screen lists each audit at a place with
   its last rounds' scores (`ops.audit_rounds`), for whoever holds AUDITS there (department
   heads and the outlet's managers; supervisors read).
3. **SOPs** (file 46, `ops.sop`): a text at a place for some job roles (none: everyone there).
   Me → SOPs lists one's own. "I've read this" (`ops.ack_sop`, only where `needs_ack`) is kept
   per person and version; a changed text bumps the version and asks again. Whoever holds
   TRAINING modify at the place sees who has not read it (`ops.sop_reading`).
4. **Training sessions** (`ops.training_session`, `ops.training_attendance`): a title, when, who
   trains, and for each person working at the place whether they came and, for a test, their
   score (none if absent). Kept by whoever holds TRAINING modify there (HR, the department
   head, the outlet's managers). Induction stays a checklist given to the new joiner.

## Tests

`audits.db.test.ts` and `training-sops.db.test.ts` (scores, not applicable left out, who may,
SOPs per place and role, acknowledgement per version, attendance and scores, nothing while
the blocks are off), and the e2e `audits.spec.ts` and `training-sops.spec.ts`.
