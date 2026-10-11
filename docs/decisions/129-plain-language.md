# 129. Plain words, measured

Date: 2026-10-11. Status: accepted.

## Decision

The app's words read at **Flesch-Kincaid grade 6 or lower**. `lib/plain-language.test.ts`
reads every screen's text from its source (`lib/ui-text.ts`) and checks:

- each screen with 30 words or more grades 6 or lower;
- the app as a whole, and the error messages, grade 6 or lower;
- no sentence is longer than 20 words.

A label alone ("Notifications") is not graded on its own. New text that fails is rewritten:
shorter sentences, everyday words.
