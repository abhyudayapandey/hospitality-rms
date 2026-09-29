# 005 — Hosting on the AWS Free plan: one EC2 instance, no NAT

Status: accepted · 2026-09-29

## Context

The production AWS account is on the **Free plan**. It was created in September 2026
and has $100 of credits, plus up to $100 more from onboarding tasks. The plan lasts at
most 6 months and ends about March 2027. The decision date to upgrade is
**15 February 2027**.

These resources are ruled out:

- NAT gateway
- RDS Proxy
- Multi-AZ
- Aurora provisioned
- load balancers
- interface VPC endpoints
- SNS SMS

CLAUDE.md names RDS, Amplify Hosting and Lambda plus EventBridge. **This ADR overrides
those for the Free-plan period.** CLAUDE.md's Stack section points here.

## Decisions

### Hosting

- **Everything runs on one EC2 `t4g.small` in a public subnet.** It serves Next.js
  standalone behind Caddy, the wf-execute systemd timer (every minute), and
  Postgres 16 with pg_cron in Docker.
- **Why not the planned services.**
  - Amplify SSR and Lambda outside the VPC cannot reach a database that is not
    public.
  - Lambda inside the VPC cannot reach SSM without NAT or interface endpoints, and
    both are forbidden.
  - RDS alone would use about half the credits.
- **Estimated cost** is about $15–16/month in credits (docs/deploy.md has the table).
- **The DB is never public.**
  - `listen_addresses = '127.0.0.1'`, host networking, and no published ports.
  - `pg_hba` allows only loopback scram and local peer for `postgres`.
  - The security group opens only 80 and 443.
  - `infra/instance/instance.test.ts` enforces this.
- **TLS to the DB is off (`sslmode=disable`)** because the traffic never leaves the
  loopback interface. It becomes `verify-full` on RDS.

### Data durability

- **Postgres data is on a separate EBS volume that is kept.** The AMI resolves at
  deploy time, so a later `cdk deploy` may replace the instance, and the data must
  survive that.
- **Two layers of backup:**
  - `pg_dump -Fc` to S3 every 6 hours, kept 30 days
  - DLM daily snapshots, 7 kept
- **A scripted restore drill** restores into a scratch database and compares counts.
  The drill leaves out pg_cron objects, because pg_cron can only exist in
  `cron.database_name`.
- **Small-box tuning:** 2 GiB swap, `vm.swappiness=10`, `shared_buffers=256MB`,
  `max_connections=40`, and `MemoryMax` on the services.

### Secrets

- **SSM Parameter Store SecureString, standard tier,** with the AWS-managed key. It is
  free; Secrets Manager costs $0.40 per secret per month.
- **One parameter per DB role**, plus the session key, created out of band by
  `infra/scripts/create-secrets.sh`. CloudFormation never sees the values.
- **Isolation between services** comes from the OS, because all processes share one
  instance role:
  - `fetch-params.sh` writes root-only files.
  - systemd `LoadCredential` gives each unit only its own secret. Web gets `app_rw` and
    the session key; wf-execute gets `wf_executor`.
  - Each unit runs as its own system user.
- **The instance role** can read exactly those four parameters and the config path.
- **The Postgres superuser password** is generated on the instance and stays there.
  No app uses it.
- **In production, `migrator` is not a member of `app_rw` or `wf_executor`.**
  `bootstrap-db.sh` revokes it. The grant in `packages/db/docker/init/` exists only for
  local and CI tests.

### Deploy

- **Builds happen in CI only.** `infra/scripts/build-release.sh` produces a
  linux-arm64 bundle containing:
  - the Next.js standalone server, esbuild job bundles, and migrations
  - Node 22 (sha256-verified against nodejs.org)
  - Caddy (sha512-verified against its release checksums)
  - dbmate (the npm package at the root's pinned version)
- **GitHub Actions uses OIDC.** The role trusts only
  `repo:<repo>:environment:production`, and that environment has required reviewers.
- **The deploy role can only:**
  - put `releases/*` objects
  - run the single `OutletOps-Deploy` document on the one instance (the release
    parameter must be a 40-hex SHA)
  - read command results
- **The instance runs `deploy.sh`.** Migrations are forward-only (ADR 003). A failed
  health check rolls back the app code but not the migrations.
- **No CDK bootstrap.** `CliCredentialsStackSynthesizer` works because the template has
  no assets.
- **No custom-resource Lambdas.** `restrictDefaultSecurityGroup` is off, and the OIDC
  provider is the L1 resource.
- **Instance access is through SSM only.** There is no SSH and no key pair. The instance
  role gets only the SSM agent actions, not `AmazonSSMManagedInstanceCore`, so it gets
  no blanket `ssm:GetParameters`.

### Auth

- **Cognito Essentials** with managed login.
- **Sign-in is email OTP, or username + password** for staff without email. There is
  no SMS: India needs DLT registration, and SMS is not allowed on this plan (see
  docs/deploy.md).
- **Emails go through the Cognito default sender** (50 a day).
- **Self sign-up is off.** Admins create users.
- **Password recovery is email-only.** Accounts without email are reset by a manager.

### Account access

- **No AWS Organization and no IAM Identity Center while on the Free plan.** Enabling
  Identity Center on a standalone account creates an Organization. That upgrades the
  account to the Paid plan and the unused credits expire.
- **Admins use the IAM user `ap-admin`**: `AdministratorAccess`, MFA, and console
  sign-in only, with no access keys. The CLI signs in with
  `aws login --profile outlet-ops` (AWS CLI 2.32+), which issues short-lived
  credentials.
- **GitHub Actions** uses its OIDC role, as described under Deploy.

### Cost guardrails

- An AWS Budget of $20/month of actual cost, with credits excluded, alerting at 50, 80
  and 100%.
- Every resource is tagged `CostProfile` = `always-free` or `credits`, plus a
  `CostNote`.
- The stack tests fail if any of these appear:
  - a forbidden resource type
  - an interface endpoint
  - a non-public subnet
  - a Lambda, Secrets Manager secret, SNS topic, Amplify app or ECR repository

## Consequences

- **A single point of failure.** Instance loss means minutes to an hour of downtime.
  Recovery points are up to 6 hours (dump) or 24 hours (snapshot). This is acceptable
  for a one-outlet pilot.
- **We patch the OS and Postgres ourselves.** Postgres minor versions come through the
  image rebuild on deploy. OS updates need `dnf upgrade` through SSM, or instance
  replacement.
- **Realtime stays polling**, as in CLAUDE.md.
- **Moving to RDS, Lambda and Amplify** after upgrading is documented in
  docs/deploy.md.

## Operations notes

Record data-volume swaps from snapshot restores here, with the date and volume IDs.
