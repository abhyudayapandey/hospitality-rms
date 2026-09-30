# 013 — Platform console: imports and logins (B2)

Status: accepted · 2026-09-30

B2 of the Platform Admin console (ADR 012, PRD ADM-3). A platform admin imports a
customer's onboarding files (ADR 009) with a dry run and a separate apply, then creates
the imported people's logins.

- **Migration:** `20261006100000_platform_imports` (forward-only).
- **Deploy:** stack first (S3 prefix, instance role), then the Deploy workflow; see
  `docs/deploy.md`.

## An upload belongs to one customer

- **What is kept.** The console takes one zip or the CSV files (5 MB at most). Only the
  numbered onboarding files (`00_customer.csv` to `17_…`) are kept. A
  `TEST_LOGINS_do_not_commit.csv` (passwords), a README or a Mac's `__MACOSX` folder is
  never stored. A zip may hold the files at its top level or in one folder.
- **What is refused.**
  - Names that could escape a folder (`..`, absolute paths, backslashes).
  - Two folders, or the same file twice.
  - Text that isn't UTF-8.
  - Anything too large: 40 files, 10 MB per file and 25 MB in all once inflated. These
    are checked against the zip's headers before inflating, and again after, since the
    headers aren't trusted (zip bombs).
- **Where it goes.** The upload is stored as `onboarding/<customer>/<upload>.json` in the
  private photo bucket (SSE-S3). The instance role gets `s3:PutObject` and `s3:GetObject`
  on `onboarding/*` only, with no list and no delete. A lifecycle rule removes uploads
  after 30 days. Without a bucket (dev, e2e) a local folder stands in.
- **The customer check, three times.** File 00 must name the customer the upload is for:
  - the upload route checks it first;
  - `platform.request_import` checks it again (`CUSTOMER_MISMATCH`), and refuses a
    storage key that isn't under that customer (`INVALID_UPLOAD`);
  - the worker re-reads the stored files with the same checks before loading anything.
- **Why a route handler.** The upload is a plain multipart form to a route handler,
  which works without JavaScript and keeps server actions at their default 1 MB limit.
  The handler checks the origin (CSRF, ADR 011) and the platform session, and checks
  `Content-Length` before reading the body.

## Dry run, then apply

- **The dry run.** Uploading queues an `import_dry_run` job. The worker
  (`platform_loader`, ADR 012) runs the loader and rolls back. The report shows:
  - creates, changes and unchanged rows per table;
  - every problem, with file, row and column;
  - the approval-coverage warnings (ADR 010).

  The access preview (file 99 layout) is left out of the report.

- **Applying** is a separate `import_apply` job. `platform.request_import_apply` allows it
  only after a successful dry run of the same upload.
- **Repeating is safe.** The loader upserts, so applying the same dry run again changes
  nothing, and the report says "No changes".
- **Audit.** Every step is in the platform audit: the upload's name, size and SHA-256, the
  apply request, and each job's outcome.

## Logins

- **Username logins** are created by the console (the web app already holds the customer
  pool's admin rights, ADR 011):
  - `platform.begin_logins` returns the customer's username-login people without a login;
  - each login is created in Cognito, then linked with `platform.link_customer_login`.
    That function links only a human, active, username-login person of that customer,
    never the AI agent, and never over another login.
  - Generated temporary passwords are shown once, can be downloaded once as a CSV (a
    browser Blob built from the response), and are never stored or logged.
- **Test<Role>!12 (PRD ADM-1).** The option sets `Test` + job title without spaces +
  `!12`, as a permanent password. It is offered only to test customers (`is_test`, fixed
  at creation). `begin_logins` refuses it for any other customer
  (`TEST_RULE_NOT_ALLOWED`), so a tampered request gets nothing (e2e).
- **Email logins** are Cognito invitations, sent by the worker (`invite_logins` jobs).
  Cognito's default sender allows about 50 emails a day for the whole pool, and the
  sign-in codes of email-login staff come out of the same allowance. So:
  - invitations use at most 40 a day (`platform.invite_daily_limit()`), leaving about 10
    for codes;
  - every invitation, the new owner's (ADR 012) included, is counted in
    `platform.invite`;
  - a job sends what the allowance permits, then goes back in the queue (`run_after`)
    until the allowance frees up, so a large customer's invitations take more than one
    day without anyone re-clicking.
  - Username logins send no email and aren't limited.
  - After moving the pool to SES, raise the limit in a migration.
- **The worker's new config.** The worker's systemd unit reads `platform-worker.env`
  (pool id, bucket, region; no secrets). Its database password still comes only through
  `LoadCredential`.
