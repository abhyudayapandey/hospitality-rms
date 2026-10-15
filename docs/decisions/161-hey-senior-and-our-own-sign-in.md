# 161. Hey Senior, and our own sign-in screen

Date: 2026-10-15. Status: accepted.

## Context

The product's working name was Outlet Ops (PRD open question 3). The owner chose **Hey Senior**:
Senior is the colleague who has seen it all and never leaves. A marketing site was drafted with
Senior's mark (round glasses, a moustache and a smile on the brand teal, #1f5f57) and figure.
The app's sign-in was one button that sent people to Cognito's own page, in AWS's default look,
on an amazoncognito.com address; the app's icon files were missing (the manifest named
`/icons/*.png`, which did not exist). Changing your own password also used USER_PASSWORD_AUTH,
which the Web client does not allow (it allows USER_AUTH, USER_SRP_AUTH and refresh).

## Decision

1. **The name people see is Hey Senior** everywhere they see one: the app's title and install
   name, the sign-in screen, messages that name the app ("Allow the camera for Hey Senior",
   "Ask the Hey Senior team to switch it on", "Can't reach Hey Senior"), push alerts, the
   printed logins sheet, the team console, the audit's "the Hey Senior team", and Cognito's
   invitation email ("Your Hey Senior account"). The AI agent's group reads "Senior, the
   assistant". Code, packages (`@outlet-ops/*`), the database, the server's services, the AWS
   resources and the web address keep their names: renaming them changes nothing people see
   and could make AWS replace live resources. No new domain is used yet.
2. **The logo is Senior's mark**: `public/icon.svg`, the app icons (192, 512, a maskable 512
   with the mark inside the safe zone, and a 180 px Apple icon, made from the SVG with sharp)
   and the browser theme colour #1f5f57. Senior's figure is `public/senior.svg`.
3. **The landing screen is the sign-in screen** (`/login`): the mark and name, "People come and
   go. Senior stays.", Senior's figure, and the sign-in form on the page. No Hindi copy in the
   app.
4. **Our own sign-in screen** replaces Cognito's page for customers. The server calls Cognito's
   user API as the public Web client (`lib/auth/sign-in.ts`, plain HTTPS, no AWS credentials):
   the login (username or email) with the password, or an emailed code (USER_AUTH, the pool's
   first factors); a first sign-in's own password (NEW_PASSWORD_REQUIRED); and Forgot password
   (ForgotPassword and ConfirmForgotPassword). Cognito keeps the passwords, the password policy
   and its lockout; the app passes them through and never stores, logs or returns them.
   Cognito's short-lived Session for the next step rides in a hidden field, as Cognito's own
   browser libraries keep it. A wrong login and a wrong password read the same.
5. **Limits**: the client address limit as before, plus 10 password or code tries per login
   per 15 minutes and 5 emails (codes, resets) per login per hour (`LIMITS`), on top of
   Cognito's own.
6. **One way to start a session** (`startSession`): our screen and the Hosted UI callback both
   verify the ID token, find the person and set the same cookies. Sessions refresh with
   REFRESH_TOKEN_AUTH on the user API, which works for tokens from either. The Hosted UI routes
   stay for the team console (authenticator-app MFA) and as a fallback.
7. **Changing your own password** signs in with USER_AUTH and the PASSWORD challenge, which the
   Web client allows.
8. **The website** is in `website/`: one static page, unhosted for now, with the name and mark.

## Consequences

- Cognito's invitation email changes in the stack: a `cdk deploy` (an in-place update of the
  user pool) before the app deploy.
- People who have never seen the new screen type the same login and password; nothing about
  their accounts changes.
- The team console still uses Cognito's page in its default look; branding it is left for later.

## Addendum: the sign-in screen is tested in a browser

The first live sign-ins read "Sign-in failed" on a right password: the action caught Next.js's
redirect to Home. Unit tests stubbed Cognito one call at a time, and e2e had no Cognito, so
nothing ran a good sign-in end to end. Now the e2e `signin` project does. Its own standalone
server talks to `e2e/signin/fake-cognito.mjs`, a stand-in for Cognito's user API on this
machine. It answers the same calls and signs ID tokens with its own key. The app is pointed at
it by `COGNITO_IDP_ENDPOINT`, which is accepted only as `http://127.0.0.1` or
`http://localhost` (`localIdpEndpoint`), and is never set anywhere else. The tests type into
the real form: a right password, a wrong one, an emailed code, a first sign-in's own
password, and Forgot password. Each sign-in must land on Home. With the redirect fix taken
out, four of the five fail.
