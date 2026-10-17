# Postgres 16 with pg_cron (ltree ships in contrib). Built on the instance by
# deploy/deploy.sh; only apt packages, no application build (ADR 005).
# Pinned to a minor version and bumped on purpose (ADR 170); postgres-up.sh builds with --pull,
# so the same tag's security rebuilds still arrive.
FROM postgres:16.15
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-16-cron \
 && rm -rf /var/lib/apt/lists/*
