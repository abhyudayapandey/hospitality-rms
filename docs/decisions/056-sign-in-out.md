# 056 — Sign out at once; one "Sign in" button

Status: accepted · 2026-10-06 (no migration)

On a phone, sign-out took seconds and showed the last screen until the sign-in page loaded.
The button ran three steps one after another:

1. clear the caches;
2. wait while the server revoked the Cognito token;
3. leave through Cognito's sign-out page.

The sign-in page offered "Sign in with your phone", but people also sign in with an email.

## Decision

1. **The screen is covered at once.** Sign out and Sign out of all devices put a full-screen
   "Signing you out…" over the app the moment they are tapped (`components/leaving-screen.tsx`).
2. **Nothing waits on Cognito.**
   - The caches are cleared while the server clears the session.
   - The server answers at once and revokes the Cognito refresh token just after
     (`after()`), as it does Cognito's global sign-out.
   - The sessions in our database are revoked before the answer, as before, so a signed-out
     session stops working at once.
3. **The page is replaced, not added to:** Back does not return to the app.
4. **The sign-in screen** shows the app's mark, what it is for and one **Sign in** button.
   Cognito then asks for the phone number or email and the code or password. One line says
   who to ask for help.

The Cognito sign-out page is kept. Without it, the next person on a shared phone would be
signed in as the last one.
