# 171. Operations: alerts, backups that cannot be lost, recovery, a harder server

Date: 2026-10-17. Status: accepted. Migration `20270123100000_job_heartbeats`. Stacks
`OutletOps` (changed), `OutletOpsBackupCopy` (new, ap-south-2), `OutletOpsMonitor` (new,
us-east-1).

## Context

The platform review (H4, H5, M43, M44, M46, M47, M48, M49, M51, M52) found that the pilot
server tells nobody when it stops:

- **No alerts (H5).** wf-execute, the tasks job, the nightly job, backups and the platform
  worker report failures only to the journal. A leave failed three times in production on
  16 Oct and nobody knew until someone looked. There was no outside check, no disk alarm and
  no automatic recovery (M52).
- **Backups that can be lost (M43, M44).** Dumps were kept 30 days in one bucket, with no
  versioning and no lock; the instance could overwrite them. Money data is kept 7 years. A dump
  cut short was still uploaded as the newest one, and the restore drill ran only by hand.
- **The disk can fill (M46).** Docker logs had no cap, Postgres logged every expected refusal
  with its statement, and old images were never removed.
- **Every process could read every secret (H4).** The metadata endpoint was open to every local
  user, so any process could get the role's credentials and read platform_loader's password.
- **Deploys (M47, M48).** The health check asked `/login`, which works with the database down; a
  rollback left the worker and units on the new release; Deploy could ship any branch.
- **Stuck platform jobs (M49).** A job left `running` by a worker that died stayed that way.
- **No patches (M51).** The pinned AMI and an unpinned `postgres:16` built from cache meant the
  OS and Postgres never got security fixes.

## Decision

1. **Alerts.** One SNS topic per region (the main stack, and the monitor stack), emailed to
   `alertEmail`. The instance may publish to the main one and nothing else.
   - Every job and service has `OnFailure=outlet-ops-notify@%n.service`. `notify.sh` records the
     failure against the job and emails the unit's last 30 log lines, at most once an hour per
     unit, so a job failing every minute sends one email.
   - A watchdog (every 15 minutes, root) fails when a disk is 85 % full, the app does not answer
     `/health/db` or the platform worker is not running. Free, where the CloudWatch agent's disk
     metric would not be.
2. **Heartbeats.** `platform.job_heartbeat` lists the server's jobs with how late each may be.
   Each job's unit records a good run as root (`ExecStartPost=+heartbeat.sh`, the database
   superuser), and the watchdog records the app and the worker. No app role can read or write
   the table. `/health` (app_rw, no session) answers 200 only when the database answers and
   every job ran in time, and says nothing else; `/health/db` asks only the database, for the
   deploy, so a deploy that fixes a broken job is never rolled back for it. The platform console
   shows "The server": one green line, or each late job in words with its last error.
3. **The outside check.** A Route 53 health check calls `http://<domain>/health` every 30 s;
   Caddy answers that path on plain HTTP and redirects everything else. An alarm emails when it
   has failed for 2 minutes and again when it is back. It lives in us-east-1, the only region
   with Route 53's metrics; plain HTTP costs half an HTTPS check and the page says nothing.
4. **Recovery.** A CloudWatch alarm on `StatusCheckFailed_System` recovers the instance on new
   hardware (same disks and IP); one on `StatusCheckFailed_Instance` reboots it. Both email.
5. **Backups.** A new bucket, `BackupVault`, replaces the old one (whose dumps expire within 30
   days; it is then removed by hand). Versioning and Object Lock in governance mode for 35 days:
   nothing on the server can delete or overwrite a dump. Each 6-hour dump is kept 35 days; the
   first of each month goes to `pg-monthly/`, locked and kept 7 years in Glacier Deep Archive.
   S3 replication copies everything to `OutletOpsBackupCopy` in Hyderabad (ap-south-2, an opt-in
   region chosen to keep the data in India), same lock and lifecycle. A new bucket rather than
   Object Lock on the old one: switching the lock on in CloudFormation may replace a bucket.
   - The dump goes to a file, `pg_restore -l` checks it, and only then is it uploaded.
   - The restore drill runs every Sunday at 03:30 IST and fails when the dump does not restore,
     a table comes back empty or a count is under 90 % of today's.
6. **The disk.** Docker logs 3 × 10 MB per container, the journal 500 MB, old images pruned on
   every deploy, and `log_min_error_statement = fatal`.
7. **Secrets (H4, in part).** An iptables rule lets only root, `outletops-web` and
   `outletops-platform` reach the metadata endpoint; the jobs' user, Postgres and any container
   are refused. The web app and the worker still need the role (photos, logins, uploads), so a
   bug in them can still reach it; separating that needs a second role and is for later. The
   hop limit is left as it is: changing it would replace the instance.
8. **Deploys.** The deploy checks `/health/db`. A rollback puts back the old release's units and
   Caddy file and restarts the web app and the worker. The worker gets 10 minutes to finish its
   job on a restart. The Deploy workflow refuses any ref but master, and any commit whose newest
   `static`, `db (n)` and `e2e (n)` runs have not all passed.
9. **Stuck platform jobs.** `platform.claim_job` takes a job left `running` for 30 minutes again,
   three tries in all; after the third it fails with "The worker stopped three times while
   running this. Start it again."
10. **Patches.** Every Sunday at 04:30 IST, `dnf --releasever=latest upgrade --security`; a
    reboot follows only when a kernel or core library needs it. Postgres is pinned to `16.15`
    and built with `--pull`, so the tag's own security rebuilds still arrive; the minor version is
    bumped on purpose.

## Not done

- A second AWS account for the backup copy: stronger than a second region, but needs the
  account. A per-process IAM role for the web app and the worker (see 7).
- CloudWatch Logs, a status page, SMS or chat alerts.
- RDS and a second server (M52's second half): before a second customer, ADR 005.

## Cost

About USD 0.50 a month: the Route 53 health check of an AWS endpoint. The SNS emails (first
1,000 a month), three alarms (first 10) and the extra S3 storage (cents) are free or nearly so.
