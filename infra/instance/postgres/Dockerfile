# Postgres 16 with pg_cron (ltree ships in contrib). Built on the instance by
# deploy/deploy.sh; only apt packages, no application build (ADR 005).
FROM postgres:16
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-16-cron \
 && rm -rf /var/lib/apt/lists/*
