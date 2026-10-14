# 146. Where an ask is, in the reader's words; asks given before Collect

Date: 2026-10-14. Status: accepted. Migration `20261229200000_ask_words_and_old_gives`.

## Context

The walk of Sana Shaikh's soda ask found two things:

1. Calvin, the bar manager who gives it, read "At the Bar Store: Calvin Rodrigues will give it
   to you". The sentence was written for whoever asked, and every reader saw it.
2. An ask Calvin gave before the Collect step (ADR 142) went live had no Collect task. Sana's
   page said "Given by Calvin Rodrigues. Take it to the Bar." with no button, so she could never
   close it.

## Decision

1. **The reader's words** (`inv.ask_giver_words`). Whoever asked reads "Calvin Rodrigues will
   give it to you". The head who gives it reads "give it to Sana Shaikh". Anyone else who
   follows it reads "Calvin Rodrigues will give it to Sana Shaikh".
2. **An ask given with no Collect task** still offers whoever asked "Transfer to <Dept> done"
   on its page (`inv.my_collect` returns it with no task; `inv.collect_staff_ask` closes the ask
   without one). Nobody else may close it, and only once.

## Consequences

No old ask is changed by the migration. Each one closes when whoever asked taps the button.
