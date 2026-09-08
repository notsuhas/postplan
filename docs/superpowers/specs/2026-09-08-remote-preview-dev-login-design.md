# Remote Preview Dev Login Design

## Problem

Local development enables `POST /api/auth/dev-login` when `APP_URL` is an HTTP
localhost URL. The endpoint currently creates only the production-style
`__Host-postplan_session` cookie. That cookie is always `Secure`, which is valid
on HTTP localhost but is rejected when a remote development workspace is opened
through an HTTP private address such as a Tailscale IP. The login request returns
200, the browser stores no session, and the next authenticated request returns
401.

## Design

Keep the existing `__Host-postplan_session` cookie and production behavior
unchanged. Add a separate signed development-session cookie without the
`__Host-` prefix. `dev-login` may select that cookie only when all of these are
true:

- `APP_URL` passes the existing localhost-development guard.
- The browser request origin uses plain HTTP.
- The browser request origin is not localhost, where the existing secure cookie
  already works.

Session reads will consider the development cookie only while `APP_URL` passes
the localhost-development guard. Logout will clear it under the same guard. No
other login path may issue the development cookie, and a deployed instance can
neither issue nor consume it.

The browser origin, rather than the API proxy's rewritten host, determines which
cookie is usable. A missing or malformed `Origin` falls back to the existing
secure cookie behavior.

## Security Boundaries

- Production cookie name, `Secure`, `HttpOnly`, `SameSite=Lax`, and `Path=/`
  attributes remain unchanged.
- The development cookie remains `HttpOnly`, signed, `SameSite=Lax`, and
  `Path=/`; only `Secure` and the reserved `__Host-` prefix differ.
- The fallback is inert unless the server is configured with an HTTP localhost
  `APP_URL`, which is already the condition that exposes passwordless dev login.
- The fallback is not generalized to production, OAuth, bootstrap, or CLI
  authentication.

## Verification

Add API regression coverage that proves:

1. HTTP localhost dev login keeps issuing the secure `__Host-` cookie.
2. HTTP remote-preview dev login issues the scoped development cookie and that
   cookie authenticates `/api/auth/me`.
3. A production `APP_URL` does not accept the development cookie.
4. Logout clears the development cookie in local development.

Then run the focused API tests, repository typecheck/lint/format checks, and the
full relevant test suite. Finally, use the T3 Code preview over the remote HTTP
address to click dev login and confirm the dashboard loads as the dev user.
