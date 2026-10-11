# 126. A stale app reloads on its next tap

Date: 2026-10-11. Status: accepted.

## Context

After a deploy, a phone with the app open showed the old Me screen for a few seconds: the
client's cached copy of the next screen came from the older build.

## Decision

When the app knows its build is older than the server's (ADR 055), the next tap on a link
inside the app loads that page in full (`location.assign`) instead of a client-side change.
"Reload" is still offered.
