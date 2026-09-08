# Remote Preview Dev Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make passwordless development login work when the localhost-configured app is viewed through an HTTP T3 remote-preview address without weakening production sessions.

**Architecture:** Keep the production `__Host-` cookie path unchanged. Centralize browser-session cookie detection in `lib/session.ts`, issue a separately named signed development cookie only for non-localhost HTTP browser origins while `APP_URL` is HTTP localhost, and let auth, CSRF, analytics, and logout recognize that cookie only in the same local configuration.

**Tech Stack:** TypeScript, Hono signed cookies, Bun tests, Cloudflare Workers KV

## Global Constraints

- Use Bun 1.4 and Go 1.26.
- Treat request origins and cookies as untrusted input.
- Never weaken or rename the production `__Host-postplan_session` cookie.
- The insecure development cookie must be inert unless `APP_URL` is HTTP localhost.
- Preserve unrelated local changes.

---

### Task 1: Scoped remote-preview development session

**Files:**
- Modify: `packages/api/src/lib/session.ts`
- Modify: `packages/api/src/routes/auth.ts`
- Modify: `packages/api/src/middleware/auth.ts`
- Modify: `packages/api/src/middleware/analytics.ts`
- Test: `packages/api/src/routes/__tests__/auth-workos.test.ts`
- Test: `packages/api/src/middleware/__tests__/csrf.test.ts`

**Interfaces:**
- Produces: `createDevLoginSession(c, user)`, which selects the secure production cookie for localhost/HTTPS origins and the scoped development cookie for non-localhost HTTP origins.
- Produces: `sessionCookiePresent(c)`, the shared predicate used by credential tagging, CSRF, and analytics.
- Preserves: `createSession(c, user)` for OAuth, bootstrap, tests, and every production login path.

- [ ] **Step 1: Write failing route tests**

Extend the dev-login route tests to assert that a request with
`Origin: http://100.119.18.105:5173` under `APP_URL=http://localhost:5173`
receives `postplan_dev_session`, does not receive that cookie under a production
`APP_URL`, and can authenticate `/api/auth/me` when the cookie is replayed.

- [ ] **Step 2: Write a failing CSRF test**

Assert that `postplan_dev_session=tampered` counts as browser-cookie
authentication only in localhost development and therefore rejects an unsafe
request with a foreign origin.

- [ ] **Step 3: Verify RED**

Run:

```bash
bun test packages/api/src/routes/__tests__/auth-workos.test.ts packages/api/src/middleware/__tests__/csrf.test.ts
```

Expected: FAIL because remote-preview dev login still emits only the secure
`__Host-` cookie and middleware does not recognize the development cookie.

- [ ] **Step 4: Implement the minimal session boundary**

In `lib/session.ts`, keep the existing cookie options for production, add a
signed `postplan_dev_session` cookie with `HttpOnly`, `SameSite=Lax`, and
`Path=/`, and select it only when `APP_URL` is HTTP localhost while the parsed
request `Origin` is non-localhost HTTP. Read, detect, and delete this cookie only
under the localhost `APP_URL` guard. Export `sessionCookiePresent(c)` so callers
do not duplicate cookie-name logic.

In `routes/auth.ts`, call `createDevLoginSession` only from `/dev-login`.
In both middleware modules, replace direct production-cookie checks with
`sessionCookiePresent(c)`.

- [ ] **Step 5: Verify GREEN and regression coverage**

Run:

```bash
bun test packages/api/src/routes/__tests__/auth-workos.test.ts packages/api/src/routes/__tests__/auth-logout.test.ts packages/api/src/middleware/__tests__/csrf.test.ts packages/api/src/middleware/__tests__/analytics.test.ts packages/api/src/middleware/__tests__/auth-credential.test.ts
```

Expected: PASS.

- [ ] **Step 6: Verify repository quality gates**

Run:

```bash
bun run typecheck
bun run lint
bun run format:check
bun test packages/api/src
```

Expected: all commands exit 0.

- [ ] **Step 7: Verify the real T3 workflow**

Restart the local development stack with Vite bound to `0.0.0.0`, navigate the
T3 preview to the remote workspace HTTP address, clear prior cookies, click
`dev login`, and verify the browser reaches `/dashboard` with `/api/auth/me`
returning 200.

- [ ] **Step 8: Commit and update PR #3**

```bash
git add packages/api/src/lib/session.ts packages/api/src/routes/auth.ts packages/api/src/middleware/auth.ts packages/api/src/middleware/analytics.ts packages/api/src/routes/__tests__/auth-workos.test.ts packages/api/src/middleware/__tests__/csrf.test.ts docs/superpowers/plans/2026-09-08-remote-preview-dev-login.md
git commit -m "fix(auth): support remote dev previews"
git push origin feature/human-feedback-bundles
```

Verify PR #3 points at the pushed head and its required checks complete.
