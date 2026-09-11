# Homepage Authentication CTA Design

## Problem

The public homepage intentionally remains visible to authenticated visitors, but its action panel
does not resolve the current session. As a result, a signed-in visitor sees “Sign in with Google,”
an action that is both redundant and misleading.

## Design

The homepage loader will resolve public configuration and current identity independently. A
successful `GET /api/auth/me` marks the visitor as authenticated. A `401` or an unavailable
identity request leaves the homepage in its existing signed-out state so the public page remains
resilient.

When authenticated, the action panel will contain one primary link labeled “Go to dashboard” that
navigates to `/dashboard`. Google sign-in, bootstrap setup, development login, and signed-out
session copy will not render in that state. The homepage remains public and does not redirect.

The `/login` route keeps its current behavior: authenticated visitors are redirected to the safe
`next` destination or `/dashboard`.

## Boundaries

- No API, cookie, or session semantics change.
- No authenticated user details are rendered on the public homepage.
- Signed-out, setup, and local-development flows remain unchanged.
- Failure to resolve identity fails open to the public signed-out homepage rather than breaking it.

## Verification

Component tests will prove that authenticated loader data renders only the dashboard action and
signed-out loader data retains Google sign-in. Loader tests will prove that `/` reports a valid
session without redirecting and degrades to signed out when identity resolution fails. The focused
web tests, typecheck, lint, formatting, full repository tests, production build, and Go CLI tests
will run before handoff.
