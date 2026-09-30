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

### 6. Onboard the customer and users

The production database has no dev seed.

- **Customer data** (ADR 009). Prepare the customer's onboarding files in the layout of
  `docs/onboarding/test-data` (structure, job roles, people, stock, leave, shifts), with
  real names and no test rows. Load them with the onboarding loader. The Platform Admin
  console will call the same library; until it ships, use the CLI from a workstation
  connected to the instance's Postgres through an SSM port-forwarding session, as
  `migrator`:
  ```sh
  MIGRATOR_DATABASE_URL=postgres://migrator:<password>@127.0.0.1:<port>/outlet_ops \
    pnpm --filter @outlet-ops/onboarding load <folder>            # dry run: fix every problem
  MIGRATOR_DATABASE_URL=... pnpm --filter @outlet-ops/onboarding load <folder> --apply
  ```
  The loader creates the customer, gives it the product access, the workflow definitions
  and an AI agent user, and derives everyone's access from their job role. Check the
  printed access (`--access`) against the customer's expectations before `--apply`.
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
  once. People loaded from files still need their logins created as below until the
  console's logins screen ships.
- **Cognito users.** Create each person in the user pool with the username from file 07,
  then link the `sub` to their `core.app_user` row (as `migrator`, until the console does
  it: `update core.app_user set cognito_sub = '<sub>' where username = '<username>'` in the
  customer's tenant).
  - **Staff with email (email OTP):**
    ```sh
    aws cognito-idp admin-create-user --user-pool-id <UserPoolId> --username priya \
      --user-attributes Name=email,Value=priya@example.com Name=email_verified,Value=true \
      --message-action SUPPRESS
    ```
    They pick **email** on the sign-in page and enter the code.
  - **Staff without email (username + password):**
    ```sh
    aws cognito-idp admin-create-user --user-pool-id <UserPoolId> --username ravi.k
    ```
    Cognito generates a temporary password. Hand it over in person; they must change it
    at first sign-in. The minimum length is 10. Accounts without email cannot recover
    their own password. An outlet manager resets it: for now with
    `aws cognito-idp admin-set-user-password --permanent false`, later from the admin
    module.
- **Email limit.** Cognito's default sender allows 50 emails a day, which is enough for
  one outlet's OTPs. If you need more, move to SES. SES costs credits and needs domain
  verification.

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
