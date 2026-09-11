# Homepage Authentication CTA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show authenticated homepage visitors a dashboard action instead of redundant sign-in controls.

**Architecture:** Extend the existing landing/login route loader data with an `authenticated` flag derived from `/api/auth/me`. Keep `/login` redirects and public-config resilience intact, and render mutually exclusive authenticated and signed-out action-panel states.

**Tech Stack:** React 19, React Router 8, TypeScript, Bun test, Testing Library

## Global Constraints

- Use Bun 1.4 and Go 1.26.
- Preserve the public homepage instead of redirecting authenticated visitors.
- Preserve signed-out Google, bootstrap, and development login behavior.
- Treat identity request failures as signed out on `/`.
- Preserve unrelated local changes.

---

### Task 1: Session-aware homepage action

**Files:**
- Modify: `packages/web/src/routes/login.tsx`
- Create: `packages/web/src/routes/__tests__/login.test.tsx`

**Interfaces:**
- Produces: `LoginPageData`, containing the existing `PublicConfig` fields plus `authenticated: boolean`.
- Preserves: `/login` redirects authenticated visitors to a safe destination.

- [x] **Step 1: Write failing behavior tests**

Create route/component tests that feed authenticated loader data into `Component` and assert that
“Go to dashboard” links to `/dashboard` while “Sign in with Google” is absent. Add the inverse
signed-out assertion and loader assertions for successful and rejected `/api/auth/me` requests.

- [x] **Step 2: Run tests to verify RED**

Run:

```bash
cd packages/web && bun test src/routes/__tests__/login.test.tsx
```

Expected: FAIL because the loader data has no authentication state and the component always renders
the configured Google sign-in control.

- [x] **Step 3: Implement the minimal route behavior**

In `login.tsx`, export `LoginPageData`, resolve `/api/auth/me` for `/`, preserve the existing
authenticated `/login` redirect, and return `authenticated: false` when identity resolution fails.
Render a primary React Router `Link` to `/dashboard` when authenticated; otherwise render the
existing authentication/setup controls and session-expiry copy.

- [x] **Step 4: Run tests to verify GREEN**

Run:

```bash
cd packages/web && bun test src/routes/__tests__/login.test.tsx
```

Expected: all homepage CTA tests pass.

- [x] **Step 5: Verify repository gates**

Run:

```bash
bun run test
bun run typecheck
bun run lint
bun run format:check
bun run build:web
(cd packages/cli && go test ./...)
```

Expected: every command exits 0.

- [ ] **Step 6: Commit and deliver**

Stage the design, plan, route, and tests; commit with `fix(web): reflect homepage session`; push the
feature branch; open a PR; verify CI; merge; verify deployment and live homepage behavior; then
update local `main`, remove the merged branch, and confirm a clean worktree.
