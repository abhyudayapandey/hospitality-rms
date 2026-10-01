# Deploying Outlet Ops to AWS (Free plan)

This guide covers the production setup in `ap-south-1` (Mumbai) on an AWS **Free plan**
account. The design reasons are in [ADR 005](decisions/005-hosting-free-plan.md).

> **Dated reminder.** The account was created in September 2026. The Free plan ends
> after 6 months or when the credits run out, whichever comes first: **about March 2027**.
> **Decide by 15 February 2027** whether to upgrade to a paid plan (see
> [Upgrading](#upgrading-after-the-free-plan-rds-migration-path)). If you do nothing,
> AWS closes the account at the end of the plan and deletes its resources after a
> grace period. **Take a final `pg_dump` off AWS first.**

> **Never create an AWS Organization or enable IAM Identity Center while on the Free
> plan.** Enabling Identity Center on a standalone account creates an Organization.
> Creating or joining an Organization upgrades the account to the Paid plan, and the
> unused Free-plan credits expire. Use the IAM user `ap-admin` described in
> [Prerequisites](#prerequisites-once) instead.

## What gets deployed

One CDK stack (`infra/`, stack name `OutletOps`) deploys everything below.

- **Network.** A VPC with one public subnet and an internet gateway. It has no NAT
  gateway, no load balancer and no interface endpoints. The security group allows only
  ports 443 and 80 (80 is for ACME and the HTTPS redirect). There is no SSH; use SSM
  Session Manager.
- **App server.** One EC2 `t4g.small` (ARM, 2 GB RAM) on Amazon Linux 2023 with a
  2 GB swap file and an Elastic IP.
  - **Caddy** serves HTTPS with automatic Let's Encrypt certificates and proxies
    to the app.
  - **The Next.js standalone server** listens on `127.0.0.1:3000` as user
    `outletops-web`.
  - **The workflow executor** runs from a systemd timer every minute as user
    `outletops-wf`. It replaces the planned wf-execute Lambda.
  - **The nightly attendance job** (ADR 008) runs from a systemd timer at 02:15
    Asia/Kolkata as the same user and DB role (`wf_executor`). It raises late, no-show,
    missing clock-out and unrostered exceptions, and nulls raw clock-in coordinates
    after 90 days. The timer is `Persistent=true`, so a run missed while the instance was
    off happens at the next boot.
  - **Postgres 16 with pg_cron** runs in Docker with host networking and listens on
    `127.0.0.1` only. Its data is on a separate encrypted 20 GiB EBS volume that is
    kept if the stack or the instance is deleted.
- **Wastage photos.** A private S3 bucket.
  - The web app issues 5-minute presigned URLs with the instance role: POST uploads
    are limited to jpeg/png/webp up to 5 MB, and GET is for viewing.
  - Uploads are allowed only under `wastage/<tenant>/<node>/`.
  - CORS allows POST only from `https://<domainName>`.
  - Photos expire after 400 days.
- **Backups.**
  - `pg_dump` to S3 every 6 hours (00, 06, 12, 18 UTC), kept 30 days.
  - Daily EBS snapshots of the data volume through Data Lifecycle Manager, 7 kept.
- **Secrets.** SSM Parameter Store SecureString parameters (standard tier), one per
  DB role plus the session key. You create them before the first deploy. systemd
  `LoadCredential` gives each service only its own secret:
  - web gets `app_rw` and `session_secret`
  - wf-execute and the nightly attendance job get `wf_executor`
  - migrations (during deploy, as root) get `migrator`

  The Postgres superuser password is generated on the instance and never leaves it.
  No app uses it.

- **Cognito.** A user pool on the Essentials tier with managed login.
  - Sign-in is by **email OTP**, or by **username + password** for staff without email.
  - Emails go through Cognito's default sender, which is free and limited to 50/day.
  - There is no SMS.
- **Deploy path.**
  - A GitHub OIDC provider and a deploy role that trusts only the `production`
    environment of this repo.
  - An S3 deploy bucket for release bundles.
  - An SSM command document, `OutletOps-Deploy`, that installs a release on the
    instance.
- **Budget.** $20/month of actual cost (credits excluded), with email alerts at
  50/80/100%.

### What was dropped from the original plan, and why

| Dropped                         | Why                                                                                                                                                                                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Amazon RDS                      | db.t4g.micro plus storage would cost about $18/month of credits, about half of the $200. It can move there after upgrading (see below).                                                                                                            |
| Amplify Hosting                 | Amplify's SSR compute cannot reach a database that is not public without a NAT or a VPC connector, and the DB must never be public.                                                                                                                |
| wf-execute Lambda + EventBridge | A Lambda inside the VPC without NAT or interface endpoints (both forbidden on this plan) can't reach SSM for its secret. A Lambda outside the VPC can't reach a DB that is not public. A systemd timer on the instance does the same job for free. |
| Secrets Manager                 | $0.40 per secret per month. SSM SecureString (standard tier, AWS-managed key) is free.                                                                                                                                                             |
| Isolated subnets, VPC endpoints | Nothing uses them. Interface endpoints are forbidden on this plan.                                                                                                                                                                                 |
| SNS SMS / phone OTP             | Forbidden on the Free plan, and India needs DLT registration (see [SMS in India](#sms-in-india-later)).                                                                                                                                            |
| AI worker, Anthropic key        | Deferred to the AI prompt. The provider choice and current model IDs get checked then.                                                                                                                                                             |

## Cost: monthly credit burn

Prices are approximate, for ap-south-1, and come from third-party price lists because
the AWS pricing pages were not reachable from the build environment. **Check them in
Billing → Bills after the first week.** "Credits" means the resource is not Always
Free and draws down the Free-plan credits. Every resource is also tagged `CostProfile`
(`always-free` or `credits`) and `CostNote`.

| Resource                                                                                   | Monthly                                                 | Always Free?                           |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------- | -------------------------------------- |
| EC2 `t4g.small` on-demand (~$0.0112/h)                                                     | ~$8.20                                                  | **No**, credits¹                       |
| EBS gp3: 10 GiB root + 20 GiB data                                                         | ~$2.70                                                  | **No**, credits                        |
| Elastic IP / public IPv4 ($0.005/h, charged even when attached)                            | ~$3.65                                                  | **No**, credits                        |
| EBS snapshots (daily, 7 kept, incremental)                                                 | ~$0.50–1.00                                             | **No**, credits                        |
| S3: release bundles (30 days) + `pg_dump` every 6 h (30 days)                              | < $0.50                                                 | **No**, credits (cents)                |
| S3: wastage photos (~200 KB each after on-phone resize, ~30/day, 400 days) + requests      | < $0.01                                                 | **No**, credits (fractions of a cent)  |
| SSM Parameter Store standard SecureString (AWS-managed `aws/ssm` key)                      | $0                                                      | Yes                                    |
| SSM Run Command, Session Manager                                                           | $0                                                      | Yes                                    |
| Cognito Essentials, email OTP via Cognito default sender                                   | $0                                                      | Yes, up to 10,000 monthly active users |
| VPC, subnet, internet gateway, security group, IAM, OIDC provider, DLM, Budgets (1 budget) | $0                                                      | Yes                                    |
| Data transfer out                                                                          | $0                                                      | Yes, first 100 GB/month                |
| **Total**                                                                                  | **~$15–16/month**                                       |                                        |
| **Runway**                                                                                 | $100 → ~6 months; $200 → the plan ends first (6 months) |                                        |

¹ One source says `t4g.small` has a free trial of 750 h/month until 31 Dec 2026. If
your account gets it, EC2 shows $0 until then. Check in Billing → Bills.

**Things that could cost money beyond this:**

- **Anything added outside this stack.** Examples: a NAT gateway, a load balancer,
  RDS, interface endpoints, Secrets Manager, SNS SMS, or CloudWatch detailed monitoring,
  alarms and dashboards beyond the free tier.
- **Cost Explorer API calls:** $0.01 per request. The console is free.
- **Advanced-tier SSM parameters** ($0.05 each per month). The scripts always use
  Standard.
- **More outbound traffic than 100 GB/month.**
- **An unattached Elastic IP.** It keeps costing $3.65/month. If you destroy the
  instance, release the address.
- **The retained data volume.** It keeps costing ~$1.80/month after `cdk destroy`
  until you delete it.
- **Cognito beyond 10,000 MAU**, or switching Cognito email to SES.

## Prerequisites (once)

1. **Earn the extra $100 of credits.** In the AWS console, open **Billing and Cost
   Management → Explore AWS / Free plan onboarding tasks**. Complete each task, such as:
   - launch an EC2 instance
   - use Bedrock in the playground
   - set up a budget
   - create a Lambda function
   - create an RDS database

   Each task adds credits, up to $100 in total. **Clean up whatever a task creates.**
   Stop and delete the RDS or EC2 resources as soon as the task shows as done, or they
   burn credits. The Budgets task is covered by this stack's budget.

2. **Check the credits you have left** at least monthly.
   - **Console:** Billing and Cost Management → **Credits**. It shows the remaining
     balance and the expiry date. The **Free plan** widget on the Billing home page
     shows days left.
   - **CLI (free API):**
     `aws freetier get-account-plan-state --region us-east-1`. It returns the plan
     type, the remaining credits and the end date. It needs a recent AWS CLI v2.
   - Avoid `aws ce get-cost-and-usage` for this, because each call costs $0.01.
3. **Budget alerts.** The stack creates `outlet-ops-monthly`: $20/month with credits
   excluded, alerting at 50%, 80% and 100% to `alertEmail`. Budgets track cost, not the
   credit balance, so also check the Credits page. Confirm the subscription email if
   AWS sends one.
4. **Admin IAM user and CLI sign-in.** Don't use the root user for day-to-day work,
   and **don't create an AWS Organization or enable IAM Identity Center** (see the
   warning at the top).
   1. **Protect root.** As root, turn on MFA for the root user.
   2. **Let IAM users see billing.** As root, go to **Account → IAM user and role access
      to Billing information** and activate it. Without this, `ap-admin` can't see the
      Credits page, Bills or Budgets.
   3. **Create the admin user.** Still as root, open **IAM → Users → Create user**:
      - name it `ap-admin`
      - give it console access with a strong password
      - attach the `AdministratorAccess` managed policy directly

      Do **not** create access keys for it.

   4. **Add MFA to `ap-admin`.** Sign in as `ap-admin` with the account's IAM sign-in
      URL. Register an MFA device (passkey or authenticator app) under
      **Security credentials**, then sign out and back in to confirm it asks for MFA.
      From then on, use `ap-admin` in the console and keep root for the few tasks only
      root can do.
   5. **Install the AWS CLI 2.32 or later.** `aws --version` must show 2.32+, because
      `aws login` is newer than that.
   6. **Sign in from the CLI:**
      ```sh
      aws login --profile outlet-ops
      ```
      This opens the browser. Sign in as `ap-admin` with MFA. The CLI stores
      short-lived credentials for the `outlet-ops` profile, so no access keys sit on
      disk. The first time, choose region `ap-south-1` when it asks, or run
      `aws configure set region ap-south-1 --profile outlet-ops`. Run `aws login` again
      when the session expires.
   7. **Use the profile for every command in this guide:**
      ```sh
      export AWS_PROFILE=outlet-ops
      aws sts get-caller-identity   # should show .../user/ap-admin
      ```
      `infra/scripts/create-secrets.sh`, `pnpm cdk ...` and the `aws` commands below all
      read `AWS_PROFILE`. If `cdk` doesn't pick up the `aws login` session, export it for
      the shell first:
      `eval "$(aws configure export-credentials --profile outlet-ops --format env)"`.
   8. **Other tools:** Node 22, pnpm (`corepack enable`), and `pnpm i` in this repo.
5. **Choose a hostname.** Use either of these:
   - **DuckDNS (free):** sign in at <https://www.duckdns.org> and create a subdomain,
     for example `myoutlet.duckdns.org`.
   - **Your own domain with Cloudflare DNS:** add the domain to Cloudflare (the free
     plan is fine) and plan a name like `ops.example.com`.

## First deploy

These steps are for you to run. **Claude only synthesises and tests; it never deploys.**

### 1. Create the secrets

```sh
aws login --profile outlet-ops   # if the session has expired
export AWS_PROFILE=outlet-ops
infra/scripts/create-secrets.sh
```

This creates four SecureString parameters (standard tier) that hold random 64-hex
values:

- `/outlet-ops/prod/db/migrator`
- `/outlet-ops/prod/db/app_rw`
- `/outlet-ops/prod/db/wf_executor`
- `/outlet-ops/prod/web/session_secret`

Values never appear on the command line. Running it again skips parameters that
already exist.

### 2. Deploy the stack

The stack uses `CliCredentialsStackSynthesizer`, so **no `cdk bootstrap` is needed**:
the template has no assets.

All deploy settings live in `infra/cdk.json` under `context`, so the command takes no
flags, and CI's `cdk synth` uses the same values:

| Context key                        | What it is                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `domainName`                       | The public hostname, for example `outletops-ap.duckdns.org`                |
| `alertEmail`                       | Budget alerts and the Let's Encrypt account                                |
| `cognitoDomainPrefix`              | `<prefix>.auth.ap-south-1.amazoncognito.com`; must be unique in the region |
| `githubRepo`                       | `owner/repo` allowed to deploy                                             |
| `githubOwnerId`, `githubRepoId`    | Numeric GitHub ids in the OIDC `sub` (see below)                           |
| `amiId`                            | The instance's Amazon Linux 2023 arm64 AMI, pinned (see below)             |
| `githubOidcProviderArn` (optional) | An existing GitHub OIDC provider's ARN, if the account already has one     |

```sh
cd infra
pnpm cdk diff      # read it first: see "What the diff must never show" below
pnpm cdk deploy
```

Review the IAM and security-group changes that `cdk deploy` prints before you confirm.

**What the diff must never show:** `AWS::EC2::Instance` being replaced (`[-/+]` or
"requires replacement"). The instance's image is pinned by `amiId`. A replacement means
`amiId` differs from the running instance's AMI. Stop and check:

```sh
aws ec2 describe-instances --instance-ids <InstanceId> \
  --query 'Reservations[0].Instances[0].ImageId' --output text
```

To move to a newer image deliberately, change `amiId`, deploy, then run the Deploy
workflow. The data volume is separate and kept, and the new instance mounts it on
first boot.

`githubOwnerId` and `githubRepoId` are the numeric GitHub ids of the repository owner
and of the repository. GitHub puts both in the OIDC token's `sub` claim, and the deploy
role's trust policy matches that claim exactly:
`repo:<owner>@<ownerId>/<repo>@<repoId>:environment:production`.

To look the ids up:

```sh
gh api repos/abhyudayapandey/hospitality-rms --jq '.owner.id, .id'
# 33194509     <- githubOwnerId
# 1394585977   <- githubRepoId
```

The ids don't change when a repository is renamed or transferred. The owner and repo
names in the `sub` claim do, so after a rename, update `githubRepo` and redeploy the
stack.

Note these outputs: `PublicIp`, `InstanceId`, `DeployBucketName`, `BackupBucketName`,
`PhotoBucketName`, `DeployRoleArn`, `UserPoolId`, `UserPoolClientId`, `CognitoDomain`.

To check without deploying:

- `pnpm --filter @outlet-ops/infra synth` renders the template from `cdk.json`. It makes
  no AWS calls.
- `pnpm cdk diff` compares against the live stack.

**Order when a change touches both the stack and the app:** run `cdk deploy` first,
then the Deploy workflow. For example, the photo bucket's `photo_bucket` parameter
must exist before the app's `fetch-params.sh` reads it.

### If the first deploy fails

A failed first create rolls the stack back to `ROLLBACK_COMPLETE`. A stack in that
state can't be updated, so delete it and deploy again.

1. **Check the stack status and find the cause:**

   ```sh
   aws cloudformation describe-stacks --stack-name OutletOps \
     --query 'Stacks[0].StackStatus' --output text
   aws cloudformation describe-stack-events --stack-name OutletOps \
     --query "StackEvents[?contains(ResourceStatus, 'FAILED')].[LogicalResourceId,ResourceStatusReason]" \
     --output table
   ```

   The first `CREATE_FAILED` row, the oldest one at the bottom, is the real cause. The
   later rows are usually "Resource creation cancelled".

2. **Delete the rolled-back stack** (only if the status is `ROLLBACK_COMPLETE`):

   ```sh
   aws cloudformation delete-stack --stack-name OutletOps
   aws cloudformation wait stack-delete-complete --stack-name OutletOps
   ```

   If the status is `ROLLBACK_FAILED` or `DELETE_FAILED`, the events name the resource
   that couldn't be deleted. Remove it by hand, or run `delete-stack` again with
   `--retain-resources <LogicalResourceId>`, then clean it up in step 3.

3. **Check for leftovers.** The backup bucket and the data volume use
   `RetainExceptOnCreate`. That means they are deleted when the stack's first create
   rolls back, but kept on a later `cdk destroy`. The Cognito user pool is always kept.
   It has deletion protection, and its name isn't unique, so it never blocks a
   redeploy.

   A stack created with an older template kept the backup bucket and the data volume
   on rollback too. That applies to deploys from before the tag fix. With the stack
   deleted, anything the commands below list is left over:

   ```sh
   # Buckets (CDK names them outletops-deploybucket..., -backupbucket..., -photobucket...)
   aws s3api list-buckets \
     --query "Buckets[?starts_with(Name, 'outletops-')].[Name,CreationDate]" --output table
   aws s3 ls s3://<name> --recursive | head    # a leftover from a failed create is empty
   aws s3 rb s3://<name>

   # Data volumes that aren't attached
   aws ec2 describe-volumes \
     --filters Name=tag:Project,Values=outlet-ops Name=status,Values=available \
     --query 'Volumes[].[VolumeId,Size,CreateTime]' --output table
   aws ec2 delete-volume --volume-id <vol-id>

   # Elastic IPs that aren't associated ($3.65/month each)
   aws ec2 describe-addresses --filters Name=tag:Project,Values=outlet-ops \
     --query 'Addresses[?AssociationId==null].[AllocationId,PublicIp]' --output table
   aws ec2 release-address --allocation-id <eipalloc-id>

   # Cognito user pools (free; remove them to keep things tidy)
   aws cognito-idp list-user-pools --max-results 20 \
     --query "UserPools[?Name=='outlet-ops'].[Id,CreationDate]" --output table
   aws cognito-idp update-user-pool --user-pool-id <id> --deletion-protection INACTIVE
   aws cognito-idp delete-user-pool --user-pool-id <id>
   ```

   **Only delete a data volume or backup bucket this way if no deploy has ever
   succeeded.** After the first successful deploy, the data volume holds the database
   and the backup bucket holds the dumps.

   Two things are not leftovers:
   - The SSM parameters under `/outlet-ops/prod/` come from `create-secrets.sh`, not the
     stack. Keep them.
   - `update-user-pool` resets any settings you don't pass. That doesn't matter for a
     pool you are about to delete.

4. **Fix the cause and check it locally, then deploy again:**
   1. Run `pnpm --filter @outlet-ops/infra synth` and `pnpm test`. The stack tests check,
      among other things, that every tag uses only characters AWS accepts.
   2. Run `pnpm cdk deploy` again from `infra/`.

### 3. Point DNS at the Elastic IP

The Elastic IP keeps the address stable across instance stops and replacements.

- **DuckDNS.** On duckdns.org, set the subdomain's IPv4 to `PublicIp` and click
  _update ip_. Leave the DuckDNS updater script off, because the IP never changes.
  Caddy gets a Let's Encrypt certificate for `myoutlet.duckdns.org` through the
  HTTP-01 challenge on port 80.
- **Cloudflare.** Add an **A record** `ops` → `PublicIp` with **Proxy status: DNS
  only** (grey cloud).
  - The orange-cloud proxy would end TLS at Cloudflare and interfere with Caddy's
    certificate issuance.
  - If you want the proxy later, set SSL/TLS mode to **Full (strict)** after the first
    certificate is issued.

Check that it resolves: `dig +short myoutlet.duckdns.org` should print `PublicIp`.

### 4. Configure GitHub

In the repository settings:

1. **Environments → New environment `production`.** Add **required reviewers**
   (yourself), and limit deployment branches to `master`. The AWS role trusts only
   this environment
   (`repo:<owner>@<ownerId>/<repo>@<repoId>:environment:production`, exact match).
2. **Environment variables** for `production`, all from the stack outputs:
   - `AWS_DEPLOY_ROLE_ARN`
   - `DEPLOY_BUCKET`
   - `INSTANCE_ID`

   There are no AWS keys or secrets in GitHub. OIDC issues a 1-hour session.

#### If the Deploy workflow gets AccessDenied

**Symptom.** The `configure-aws-credentials` step fails with "Not authorized to perform
sts:AssumeRoleWithWebIdentity". This almost always means the token's `sub` claim
doesn't match the role's trust policy. GitHub changes the `sub` format now and then.

**Find the `sub` GitHub actually sent.** CloudTrail event history is free and records
the failed call. Events show up after about 5–15 minutes.

```sh
aws cloudtrail lookup-events --region ap-south-1 \
  --lookup-attributes AttributeKey=EventName,AttributeValue=AssumeRoleWithWebIdentity \
  --max-results 5 --query 'Events[].CloudTrailEvent' --output json |
  jq -r '.[] | fromjson | [.eventTime, (.errorCode // "ok"), .userIdentity.userName] | @tsv'
```

- The last column is the `sub`. The console shows the same thing: CloudTrail → Event
  history, then filter on Event name `AssumeRoleWithWebIdentity`.
- If nothing shows up in `ap-south-1`, try `--region us-east-1`. The call may have gone
  to the global STS endpoint.

**Compare it with the trust policy:**

```sh
aws iam get-role --role-name <DeployRoleArn's name> \
  --query 'Role.AssumeRolePolicyDocument.Statement[0].Condition'
```

**Fix a mismatch.**

- **Wrong ids or names:** correct `githubRepo`, `githubOwnerId` or `githubRepoId`, then
  run `cdk deploy` again.
- **A new `sub` format:** update `githubDeploySubject` in `infra/lib/config.ts`, along
  with its test.

Keep the condition an exact `StringEquals`. Never widen it with `StringLike` or `*`.

**If the `sub` matches but it still fails,** check two things:

- the `aud` claim is `sts.amazonaws.com`
- `AWS_DEPLOY_ROLE_ARN` is the stack's `DeployRoleArn` output

### 5. Deploy the app

Run **Actions → Deploy → Run workflow** on `master`, then approve the environment gate.
The workflow does the following:

1. Builds the linux-arm64 release bundle in CI with `infra/scripts/build-release.sh`.
   The bundle contains:
   - the Next.js standalone server, built with the dev login compiled out
   - esbuild bundles of wf-execute, sync-defs and attendance-nightly
   - Node 22 (sha256-verified), Caddy (sha512-verified) and dbmate
   - migrations, systemd units, Postgres config and the deploy scripts
2. Uploads it to `s3://<DeployBucket>/releases/<sha>.tgz`.
3. Runs `OutletOps-Deploy` on the instance. `deploy/deploy.sh` then works in this order:
   1. installs the units and Caddy
   2. fetches parameters into root-only files
   3. starts or updates the Postgres container
   4. creates or updates the roles (**no `app_rw`/`wf_executor` grants to `migrator` in
      production**)
   5. runs `dbmate up` as `migrator`
   6. syncs the product access (access groups, the domain matrix, bp_policy; ADR 009)
      and the workflow definitions into every tenant
   7. switches the `current` symlink atomically, restarts the services and health-checks
      `/login`
   8. if the health check fails, rolls back the **app code** (migrations are
      forward-only and stay applied)

The instance never builds anything. It keeps the last 3 releases.

Open `https://<domainName>/login`. The first certificate can take up to a minute.

#### Releasing user administration (ADR 011)

This release changes the stack (the instance role may now manage logins in the customer
pool), so the stack goes out before the app:

1. `pnpm --filter @outlet-ops/infra synth`, then `cd infra && pnpm cdk diff`. The diff
   must show only the instance role's policy gaining statement `CustomerLoginAdmin`: the
   seven `cognito-idp:Admin*` actions on the `Users` pool ARN. Anything else (a replaced
   pool or instance, other statements): stop and ask.
2. `pnpm cdk deploy`.
3. Run the Deploy workflow (the `user_admin` migration runs on the instance).

The migration checks that no username or email is used by two people across customers
and stops with the list if one is; production has no customer data yet, so it passes.

#### Releasing the platform console, B1 (ADR 012)

This release adds a database role with its own secret, a second Cognito pool and a new
service. Order matters: the secret must exist before the instance fetches it, and the
stack's new config parameters before the app is deployed.

1. Create the new secret (existing ones are left as they are):
   `infra/scripts/create-secrets.sh`. It should print `written: .../db/platform_loader`
   and `exists:` for the others.
2. `pnpm --filter @outlet-ops/infra synth`, then `cd infra && pnpm cdk diff`. Expect only
   additions and one policy change:
   - new `PlatformUsers` pool, its `PlatformWeb` client, domain, managed-login branding
     and the `platform-admins` group;
   - new `/outlet-ops/prod/config/platform_cognito_*` parameters and the
     `PlatformUserPoolId` output;
   - the instance role's `ReadOwnParameters` statement gaining `db/platform_loader`.

   Any replacement of the `Users` pool, the instance or its volume: stop and ask.

3. `pnpm cdk deploy`.
4. Run the Deploy workflow. It creates the `platform_loader` role and the
   `outletops-platform` user, runs the `platform` migration and starts
   `outlet-ops-platform-worker`.
5. Once: create your platform admin in the platform pool and add them to the group (the
   pool id is the stack output `PlatformUserPoolId`):
   ```sh
   aws cognito-idp admin-create-user --profile outlet-ops --region ap-south-1 \
     --user-pool-id <PlatformUserPoolId> --username pabhyudaya@gmail.com \
     --user-attributes Name=email,Value=pabhyudaya@gmail.com Name=email_verified,Value=true \
     --desired-delivery-mediums EMAIL
   aws cognito-idp admin-add-user-to-group --profile outlet-ops --region ap-south-1 \
     --user-pool-id <PlatformUserPoolId> --username pabhyudaya@gmail.com \
     --group-name platform-admins
   ```
6. Open `https://<domainName>/platform`, sign in with the emailed temporary password, set
   your own (14+ characters) and enrol an authenticator app. Your `platform.admin` row is
   created on that first sign-in; there is no database step.

Check afterwards: `systemctl status outlet-ops-platform-worker` is active, and creating a
test customer from the console reaches `done` within a few seconds.

#### Releasing the platform console, B2: imports and logins (ADR 013)

No new secret or service. Stack first (the upload prefix and its IAM statement), then
the app.

1. `pnpm --filter @outlet-ops/infra synth`, then `cd infra && pnpm cdk diff`. Expect
   exactly:
   - `PhotoBucket`: a second lifecycle rule, `onboarding/` expiring after 30 days
     (an in-place update);
   - the instance role's policy gaining `OnboardingUploads`: `s3:PutObject` and
     `s3:GetObject` on `<PhotoBucket>/onboarding/*`.

   Anything else, above all a replacement of the bucket, the `Users` pool or the
   instance: stop and ask.

2. `pnpm cdk deploy`.
3. Run the Deploy workflow. It runs the `platform_imports` migration, writes
   `/etc/outlet-ops/platform-worker.env` (pool id, bucket, region; no secrets) and
   restarts `outlet-ops-platform-worker` with it.

Check afterwards: open a test customer in `/platform`, **Import setup files**, upload its
zip. The dry run should reach `done` within seconds with "no changes" for a customer
that is already loaded. On **Logins**, the invitation note shows the daily allowance.

#### Releasing the invitation email and username owners (ADR 013)

1. `pnpm --filter @outlet-ops/infra synth`, then `cd infra && pnpm cdk diff`. Expect exactly
   one change: the `Users` pool (`AWS::Cognito::UserPool`) gains
   `AdminCreateUserConfig.InviteMessageTemplate` (`EmailSubject` "Your Outlet Ops account"
   and the `EmailMessage` that explains the sign-in code). It is an in-place update of
   the pool; `PlatformUsers` does not change. Any replacement: stop and ask.
2. `pnpm cdk deploy`. If Cognito refuses the template (it should not: the pool has
   email-code sign-in, so invited logins have no password), the stack rolls back and
   nothing changes; tell me the error.
3. Run the Deploy workflow (two migrations: owner login type, and the Account Owner check
   the loader may defer).

#### Releasing the extra-owner fix (ADR 013)

App and database only: no `cdk diff` change. Run the Deploy workflow (one migration:
`remove_account_owner`). Then fix Test Company as in "Fixing an extra account owner".

#### Releasing menu, recipes and costing (ADR 014, Prompt 9a)

App and database only: no `cdk diff` change, no new parameter or secret. Before merging,
run **Actions → RLS equivalence (all users)**: access rules changed.

**1. Deploy.** Run the Deploy workflow. It applies three migrations (`menu_recipes`,
`menu_costing`, `menu_reads`) and syncs the product access, which adds the RECIPES,
RECIPES_TEAM, MENU and DERIVED_MENU grants.

**2. See what production holds** (read-only: the session refuses any write). From your
workstation:

```sh
cat > /tmp/menu-state.json <<'JSON'
{"commands":["docker exec -u postgres -e PGOPTIONS='-c default_transaction_read_only=on' outlet-ops-pg psql -d outlet_ops -X -P pager=off -c \"select t.code, (select count(*) from inv.item i where i.tenant_id = t.id) as items, (select count(*) from inv.item_node x where x.tenant_id = t.id) as item_locations, (select count(*) from core.node_link l where l.tenant_id = t.id) as links, (select string_agg(distinct u.username, ', ') from core.role_assignment ra join core.security_group g on g.id = ra.group_id and g.code = 'ACCOUNT_OWNER' join core.app_user u on u.id = ra.user_id where ra.tenant_id = t.id) as owners from core.tenant t where t.code in ('TEST-COMPANY', 'TEST-SOLO-COMPANY') order by 1\""]}
JSON
id=$(aws ssm send-command --profile outlet-ops --region ap-south-1 \
  --instance-ids <InstanceId> --document-name AWS-RunShellScript \
  --parameters file:///tmp/menu-state.json --query Command.CommandId --output text)
sleep 5
aws ssm get-command-invocation --profile outlet-ops --region ap-south-1 \
  --instance-id <InstanceId> --command-id "$id" --query StandardOutputContent --output text
```

| Row                 | Loaded before the menu data (what the dry runs below expect)                                     |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `TEST-COMPANY`      | 64 items, 303 item locations, 16 links, owners `test.account-owner`                              |
| `TEST-SOLO-COMPANY` | 36 items, 39 item locations, 3 links, owners `test.solo.bar-manager`, or no row: not created yet |

If Test Company's owners also list `test-company.owner`, remove it first ("Fixing an
extra account owner" below): until then the dry run stops with a problem naming both
owners. Any other numbers: stop and send me the output.

**3. Load the menu files.** Build each zip as in step 7 (it now holds files 18 to 24 and
Test Company's new link in file 03). The customer's page → **Import setup files** → the
zip → **Upload and dry run**. Expected, with no problems and no menu warnings:

- **Test Company** (loaded before the menu data): **"Dry run: applying would make 393
  changes."** All new: links 1 (the central kitchen production team's store, so its cooks
  read the gravy recipes), items 7, item locations 26, opening stock 25 (the zero-quantity
  Angostura Bitters line at Bar 3.0 is unchanged), unit conversions 71, prep items 10,
  prep locations 34, menu items 37, menu prices 111, recipes 47, prep procedures 24.
  Everything else unchanged; the same 2 approval-coverage warnings as before.
- **Test Solo Bar Co, loaded before the menu data**: **205 changes**, all new: items 13,
  item locations 14, opening stock 13 (its zero-quantity Angostura Bitters line
  unchanged), unit conversions 49, prep items 7, prep locations 7, menu items 27, menu
  prices 27, recipes 34, prep procedures 14. The same 5 approval-coverage warnings.
- **Test Solo Bar Co, not created yet**: create it and import as in step 7: **399
  changes**.

These were checked on a scratch database rebuilt the way production was: each customer
created in the console code path with the runbook's entries, its pre-menu files applied
(Test Company 1522 changes; production showed 1523 because the extra owner made the
file's owner one more new user, then removed), then the current files dry-run. Logins
made on the Logins page do not change the counts.

**4. Apply**, then **Apply** again: "No changes". Then sign in as
`test.general-manager.1.0`: **Menu** lists Hotel 1.0's 37 items with cost %. As
`test.commis.1.0`, **Menu** lists the kitchen recipes only, with no prices; as
`test.central-kitchen-commis`, the Makhani Gravy and Onion Tomato Masala recipes.

#### Releasing production, sales and cost control (ADR 015, Prompt 9b)

App and database only: no `cdk diff` change, no new parameter or secret. Before merging,
run **Actions → RLS equivalence (all users)**: access rules changed (PRODUCTION and SALES).

**1. Deploy.** Run the Deploy workflow. It applies two migrations (`production_sales`,
`production_reads`) and syncs the product access.

- **The ledger rewrite.** `production_sales` changes the ledger's quantity type, which
  rewrites `inv.stock_ledger` and `inv.stock_level` once. On the test customers' few
  thousand rows this takes well under a second.
- **Nothing to re-import.**

**2. Check**, signed in as each test user:

- `test.chef-de-partie.1.0`: **Stock → Production** at the Hotel 1.0 kitchen store lists
  Ginger Garlic Paste, Mint Chutney and Steamed Basmati Rice; recording half a batch shows
  it under "Batches here" with its use-by.
- `test.general-manager.1.0`: **Menu → Sales** shows Hotel 1.0's 37 items for today.
- `test.cost-controller.1.0`: **Menu → Variance** shows the kitchen store's items and the
  outlet's cost %.

Sales posted on production by testing are real stock movements. To undo a test day, post
it again with zeros: stock returns by the difference.

#### Releasing the central kitchen store scope (test data and loader warning)

App only: no migration, no `cdk diff` change, no new parameter or secret. Before merging,
run **Actions → RLS equivalence (all users)**: the test customers' access changed.

- **What changed.** In Test Company's file 06, the Central Kitchen Chef's STOCK_USER and
  the Central Kitchen Store Keeper's STORE_KEEPER now cover the central kitchen store
  only, like the Central Kitchen Manager's HUB_MANAGER. Before, "this place and
  everything below" reached all 11 outlet stores under it in the delivery tree.
- **The new loader warning.** The import now warns, without blocking, about any STOCK_USER
  or STORE_KEEPER grant that reaches more than one stock location through the places
  below it. The warning names the person and the extra stores.

**1. Deploy.** Run the Deploy workflow.

**2. Re-import Test Company.** Build the zip as in step 7. Then go to the customer's page
→ **Import setup files** → the zip → **Upload and dry run**. Expected:

- **No problems.**
- **"Dry run: applying would make 2 changes."** Both are changed job role access rows:
  the chef's and the store keeper's central kitchen store grant. Everything else is
  unchanged.
- **The same 2 approval-coverage warnings as before**, and no stock-reach warnings.

**Apply**, then **Apply** again: it must say "No changes".

**3. Test Solo Bar Co: nothing to re-import.** Its files are unchanged. If you dry-run it
anyway, it reports "No changes", the same 5 approval-coverage warnings, and no
stock-reach warnings.

These counts were checked on a scratch database set up the way production is now. Each
customer was created through the console's code path with step 7's entries, the files
from `master` were applied, and then this branch's files were dry-run. Applying gave
both grants "this place only", and a second load made no changes.

**4. Check.** Sign in as `test.central-kitchen-chef`, then as
`test.central-kitchen-store-keeper`. For each, **Stock** lists only the Central Kitchen
store, with no hotel or outlet stores.

### 6. Onboard the customer and users

The production database has no dev seed.

- **Customer data** (ADR 009, 013). Prepare the customer's onboarding files in the layout
  of `docs/onboarding/test-data` (structure, job roles, people, stock, leave, shifts), with
  real names and no test rows. In the Platform Admin console, open the customer,
  **Import setup files**, and upload them as one zip (or the CSV files). Fix every problem
  the dry run lists and upload again; **Apply** only a clean dry run. Applying again is
  safe: it reports "no changes".
  The loader creates the customer's structure, gives it the product access, the workflow
  definitions and an AI agent user, and derives everyone's access from their job role.
  The CLI (`pnpm --filter @outlet-ops/onboarding load <folder> [--access] [--apply]`)
  still works through an SSM port-forwarding session, for example to print the full
  access preview before applying.
  - The loader also rejects any structure where some process at some place would have no
    approver (`NO_APPROVER`, one line per case, ADR 009); fix the structure or the
    access files and dry-run again.
  - The leave HR step is on unless file 00 sets `leave_hr_approval` to `no`.
  - The dry run also prints `WARNING` lines: people whose own requests nobody else could
    approve (ADR 010). They do not block the load. An account owner's are approved at
    the top of the chain; for anyone else, add an approver before they need one.
  - Before the pilot, and whenever access rules change, run **Actions → RLS equivalence
    (all users) → Run workflow** on the commit you deploy: it checks every test user
    against every business table (it never touches AWS).
- **Rostering rules** default to 10 h rest, 48 h a week and late after 10 minutes; file 15
  overrides them.
- **People added later** are added in the app (**Admin → People → Add a person**, ADR
  011): it creates the Cognito login and shows a username login's temporary password
  once.
- **Logins for imported people** (ADR 013): in the console, the customer's **Logins**.
  - **Username logins**: **Create N username logins**. The temporary passwords are shown
    once and can be downloaded once as a CSV; nothing keeps them. Hand them over in
    person; people change them at first sign-in (at least 10 characters). Accounts
    without email cannot recover their own password: an outlet manager or user admin
    resets it in the app.
  - **Test customers only**: the Test<Role>!12 option sets permanent pattern passwords.
    The console refuses it for any other customer.
  - **Email logins**: **Send N invitations**. The worker sends at most 40 invitations a
    day (for all customers together) and sends the rest automatically as the allowance
    frees up. People sign in with **email** and the code they are sent.
- **Email limit.** Cognito's default sender allows about 50 emails a day for the whole
  pool, sign-in codes and invitations together; invitations use at most 40 of them
  (ADR 013). That is enough for one outlet. If you need more, move to SES (it costs
  credits and needs domain verification) and raise `platform.invite_daily_limit()` in a
  migration.

### 7. Load the test customers on production

The two test customers (`docs/onboarding/test-data`, ADR 009) through the Platform Admin
console, exactly as a real customer would be loaded. Each is created as a **test
customer** (the `Test<Role>!12` passwords are allowed only for those, and the flag cannot
be changed later) with the **same first account owner as its `07_users.csv`**: a username
login without email, so there is no second owner after the import and no email is sent.
Tested end to end on an empty database with the same console functions and worker.

Codes and usernames are unique across all customers, so each customer can be created
once. Nothing here uses the dev seed (no shifts or punches are loaded).

**1. Build the two zips** on your workstation, from the repository root (one command
each; re-running one rebuilds its zip). Only the numbered files are included, so the
passwords file (`TEST_LOGINS_do_not_commit.csv`) and the README never are:

```sh
(cd docs/onboarding/test-data/test-company && zip -q -FS ~/test-company.zip [0-9][0-9]_*.csv)
(cd docs/onboarding/test-data/test-solo-bar-co && zip -q -FS ~/test-solo-bar-co.zip [0-9][0-9]_*.csv)
```

`test-company.zip` holds 18 files, `test-solo-bar-co.zip` 17.

**2. Create each customer**: `/platform` → **New customer**. Fill in exactly:

| Field               | Test Company                     | Test Solo Bar Co                   |
| ------------------- | -------------------------------- | ---------------------------------- |
| Company name        | `Test Company`                   | `Test Solo Bar Co.` (with the dot) |
| Customer code       | `TEST-COMPANY`                   | `TEST-SOLO-COMPANY`                |
| Country / Currency  | `India` / `INR`                  | `India` / `INR`                    |
| Time zone           | `Asia/Kolkata`                   | `Asia/Kolkata`                     |
| Test customer       | ticked                           | ticked                             |
| Owner name          | `Test Account Owner`             | `Test Bar Manager`                 |
| Owner signs in with | Username and password (no email) | Username and password (no email)   |
| Owner username      | `test.account-owner`             | `test.solo.bar-manager`            |

Type the owner username yourself: the field starts empty, and **Use suggested** would
give `<code>.owner`, which is **not** the owner in these files. There is no email field
for a username owner. **Create customer** shows a check with the owner's username and
sign-in type in large text: it must read `test.account-owner` (or
`test.solo.bar-manager`) and "Username and password: no email is sent". Then **Confirm
and create**; the job page reaches `done` within seconds and says no email is sent.
If the customer's existing owner is not in the files, the import's dry run stops with a
problem naming both usernames (see "Fixing an extra account owner" below).
(Test Solo Bar Co's owner is its bar manager: the import gives them the Bar Manager job
role and keeps them Account Owner through file 08.)

**3. Import**: the customer's page → **Import setup files** → choose the zip →
**Upload and dry run**. The dry run should report no problems and:

- **Test Company**: "Dry run: applying would make 1915 changes." Per table (new / changed):
  org places 32 / 1 (the company root gets the file's values), delivery places 16,
  links 17, location settings 5, job roles 53, job role access 85, users 106 (the owner
  exists already), workers 106 / 1 (the owner's), extra access 3, suppliers 7, items 71,
  item locations 329, opening stock 328 (its zero-quantity Angostura Bitters
  line at Bar 3.0 is reported unchanged), unit conversions 71, prep items 10, prep
  locations 34, menu items 37, menu prices 111, recipes 47, prep procedures 24, leave types
  5, leave balances 321, roster settings 1, shift templates 90, events 4. **2 approval-coverage warnings**, both
  expected: `test.account-owner`'s own LEAVE and SHIFT_SWAP at TEST-COMPANY have no
  approver but them and are approved at the top of the chain (ADR 010).
- **Test Solo Bar Co**: "Dry run: applying would make 399 changes." Per table: org places
  4 / 1, delivery places 4, links 3, location settings 1, job roles 7, job role access 12,
  users 6, workers 6 / 1, extra access 1 (the owner's Account Owner), suppliers 2, items
  49, item locations 53, opening stock 52 (its zero-quantity Angostura Bitters line is
  reported unchanged), unit conversions 49, prep items 7, prep locations 7, menu items
  27, menu prices 27, recipes 34, prep procedures 14, leave types 5, leave balances 21,
  roster settings 1, shift templates 5. **5 approval-coverage warnings**, all expected, all for
  `test.solo.bar-manager` (the only manager): their own LEAVE, PURCHASE_ORDER,
  ROLE_CHANGE, SHIFT_SWAP and STOCK_ADJUSTMENT are approved at the top of the chain.

Anything else (a problem listed, different counts): stop, don't apply, and send me the
report.

**4. Apply**: **Apply** on the dry run. The apply job reports "Applied: 1915 changes."
(Test Solo Bar Co: 399). Then **The dry run this applied** → **Apply** again: it must say
"Applied. No changes: everything in these files was already loaded."

**5. Logins**: the customer's page → **Logins**.

- Username logins: "0 of 107 have a login; 107 waiting" (Test Solo Bar Co: 0 of 7). Tick
  **Set passwords by the Test<Role>!12 rule** → **Create 107 username logins** (7). Test
  Company takes about a minute. Every password is `Test` + the job title without spaces
  - `!12` (`TestAccountOwner!12`, `TestBarManager!12`) and is kept at sign-in; the list
    and the one-time CSV show them, and `TEST_LOGINS_do_not_commit.csv` has the same. If it
    stops part-way with an error, press the button again: it goes on with those still
    waiting.
- Email invitations: 0 waiting. The test customers have no email logins, so nothing is
  sent and the daily email allowance is untouched.

**6. Check**: sign out of the console, open `https://<domainName>`, sign in as
`test.account-owner` / `TestAccountOwner!12` (and `test.solo.bar-manager` /
`TestBarManager!12`); each sees only their own customer. In `/platform` both customers
show as `active` and `test`, with 107 and 7 active people.

### Fixing an extra account owner

A customer created in the console with a first owner whose username is not in its
`07_users.csv` ends up with two owners after the import (the console's and the file's).
The import's dry run now stops with a problem naming both; for a customer already in that
state:

**1. See the owners** (read-only: the session refuses any write). From your workstation:

```sh
cat > /tmp/owners.json <<'JSON'
{"commands":["docker exec -u postgres -e PGOPTIONS='-c default_transaction_read_only=on' outlet-ops-pg psql -d outlet_ops -X -P pager=off -c \"select u.username, u.login_type, u.status, u.created_at, u.last_sign_in_at, u.cognito_sub is not null as has_login, ra.source, n.code as at_place from core.role_assignment ra join core.security_group g on g.id = ra.group_id and g.code = 'ACCOUNT_OWNER' join core.app_user u on u.id = ra.user_id join core.hierarchy_node n on n.id = ra.node_id join core.tenant t on t.id = ra.tenant_id and t.code = 'TEST-COMPANY' order by u.created_at\""]}
JSON
id=$(aws ssm send-command --profile outlet-ops --region ap-south-1 \
  --instance-ids <InstanceId> --document-name AWS-RunShellScript \
  --parameters file:///tmp/owners.json --query Command.CommandId --output text)
sleep 5
aws ssm get-command-invocation --profile outlet-ops --region ap-south-1 \
  --instance-id <InstanceId> --command-id "$id" --query StandardOutputContent --output text
```

(`TEST-COMPANY` is the customer code; change it for another customer.) The console shows
the same on the customer's page under **Account owners**.

**2. Remove the extra owner** in the console: `/platform` → the customer → **Account
owners** → **Remove <username>** → a reason → type the username → **Remove owner**. It is
deleted if they never signed in and nothing refers to them (a console-created owner that
was never used), otherwise deactivated with Account Owner revoked (and their login, if
any, disabled and signed out everywhere). The last owner can't be removed. The platform
audit records it with the reason, and the data audit log records every row.

**3. Check**: the query in step 1 lists only the file's owner; the **Logins** page no
longer lists the removed person; a new dry run of the same zip reports no problems and
no changes.

## Operating

**Shell access.** Use SSM Session Manager:
`aws ssm start-session --target <InstanceId>`. There is no SSH or key pair.

**Logs.**

- `journalctl -u outlet-ops-web`
- `-u outlet-ops-wf-execute`
- `-u outlet-ops-attendance-nightly`
- `-u outlet-ops-caddy`
- `-u outlet-ops-pg-backup`
- `docker logs outlet-ops-pg`

**Status.** `systemctl list-timers 'outlet-ops-*'`

### Backups

- **Logical backups.** `outlet-ops-pg-backup.timer` streams
  `pg_dump -Fc` → `s3://<BackupBucket>/pg/YYYY/MM/DD/outlet_ops-<ts>.dump` four times
  a day. S3 lifecycle deletes them after 30 days. To take one now:
  `systemctl start outlet-ops-pg-backup`.
- **Volume snapshots.** DLM snapshots the data volume (tag
  `Backup=outlet-ops-daily`) every day at 18:30 UTC (00:00 IST) and keeps 7.
- **Before the Free plan ends,** and before any risky change, download a dump off
  AWS: `aws s3 cp s3://<BackupBucket>/pg/<key> .`

### Restore drill: monthly, and after any backup change

```sh
aws ssm start-session --target <InstanceId>
sudo /opt/outlet-ops/current/deploy/restore-drill.sh            # latest dump
sudo /opt/outlet-ops/current/deploy/restore-drill.sh pg/2026/10/01/outlet_ops-...dump
```

The drill restores the dump into a scratch database, `outlet_ops_restore_drill`. It
leaves out pg_cron objects, which can only live in `outlet_ops`. It then prints key row
counts (live vs restored) and the latest migration version, and drops the scratch
database. **Record the date and result.** The drill fails if the restore errors or
returns nothing.

### Full restore (disaster recovery)

- **From a `pg_dump`** (data loss up to 6 hours):
  1. Stop the writers:
     `systemctl stop outlet-ops-web outlet-ops-wf-execute.timer outlet-ops-pg-backup.timer outlet-ops-attendance-nightly.timer`.
  2. Take a safety dump of the current state if the database is readable.
  3. Recreate the database:
     `docker exec -u postgres outlet-ops-pg psql -c 'drop database outlet_ops with (force)' -c 'create database outlet_ops'`.
  4. Restore:
     `aws s3 cp s3://<BackupBucket>/<key> /tmp/r.dump && docker cp /tmp/r.dump outlet-ops-pg:/tmp/ && docker exec -u postgres outlet-ops-pg pg_restore --exit-on-error -d outlet_ops /tmp/r.dump`.
  5. Re-run the latest deploy, **Actions → Deploy** on the same commit. It re-applies
     role grants and any newer migrations and restarts everything.
- **From an EBS snapshot** (data loss up to 24 hours, whole volume):
  1. Create a volume from the snapshot in the same AZ.
  2. Stop the instance and detach the old data volume. Keep it until you have verified
     the restore.
  3. Attach the new volume as `/dev/sdf` and start the instance.
  4. Because the stack manages the attachment, record the swap in ADR 005's operations
     notes. The next `cdk deploy` would otherwise try to re-attach the original
     volume ID. Alternatively, update the stack to import the new volume.
- **Instance replaced** (a new AMI or instance type): the data volume is separate and
  kept, and the new instance mounts it by label. Then run **Deploy** again.

### Rotating passwords

```sh
infra/scripts/create-secrets.sh --rotate db/app_rw     # or db/migrator, db/wf_executor, web/session_secret
```

Then run **Actions → Deploy** again. It re-fetches parameters, runs `ALTER ROLE ...
PASSWORD` and restarts the services. Rotating `web/session_secret` signs everyone out.

## Upgrading after the Free plan (RDS migration path)

**Decide by 15 February 2027.** Once the account is on a paid plan:

1. Create RDS for PostgreSQL 16 (`db.t4g.micro`, Single-AZ to start) in **private
   subnets** of this VPC. That means adding isolated subnets in two AZs, which a DB
   subnet group needs.
   - Use a parameter group with `rds.force_ssl=1` and
     `shared_preload_libraries=pg_cron`.
   - The security group allows 5432 only from the instance's security group.
   - Turn on automated backups (7 days, point-in-time restore).
2. Create `migrator`, `app_rw` and `wf_executor` with the same bootstrap SQL
   (`deploy/bootstrap-db.sh`), using the RDS master user once. Keep `migrator` without
   the app-role grants.
3. Take the downtime window:
   1. Stop the writers.
   2. `pg_dump -Fc`, then `pg_restore` into RDS as the master user.
   3. Point the credentials at RDS. `db_url` in `deploy/lib.sh` becomes the RDS
      endpoint with `sslmode=verify-full` and the RDS CA bundle.
   4. Deploy.
   5. Verify, then stop the local Postgres container.
4. Optional, once the budget allows:
   - Move the executor to the wf-execute Lambda (it needs SSM and Secrets access, so a
     NAT or interface endpoints).
   - Move the web tier to a container or Amplify service with a VPC connector.
   - Secrets Manager rotation.

   Each of these adds cost; check Budgets first.

## SMS in India (later)

Phone OTP for frontline staff (LLD) is deferred. Sending SMS to Indian numbers requires
**DLT registration** under TRAI rules before any carrier delivers it.

1. **Register as a Principal Entity** on a DLT portal (Jio, Airtel, Vodafone Idea or
   BSNL). You need company PAN/GST documents and a fee. Allow about 1–2 weeks.
2. **Register a sender ID (header)**, for example `OUTOPS`, and the exact **OTP
   message template** in the content category _Service Implicit_. Approval takes a few
   days.
3. In AWS End User Messaging SMS (formerly Pinpoint), request an **India sender ID**
   and enter the DLT Entity ID and Template ID. Leave the sandbox with a spending limit
   request. Allow 1–2 weeks more.
4. Configure Cognito SMS (an IAM role for SNS) and add `phone_number` sign-in.

**Cost:** every OTP SMS to India costs money (a few US cents each at the time of
writing), and SNS SMS is **not allowed on the Free plan**. Do this only after upgrading.
Until then, use email OTP or username + password.

## Tearing down

`pnpm cdk destroy` in `infra/` removes almost everything. These are **kept** on purpose
and keep costing until you delete them by hand:

- the data volume
- the backup bucket
- the Cognito user pool (it also has deletion protection)
- the SSM SecureString parameters (free)

Also delete the DLM snapshots.
