# Feedback Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit human-to-agent feedback batches plus deployment, audit, diff, anchor, interaction-mode, sharing, and landing-page foundations.

**Architecture:** Extend the existing D1/Drizzle, Hono, React viewer, and Go CLI boundaries. Keep comments authoritative and immutable during handoff; batches reference comment IDs, version history references deployments, and a shared idempotency/ledger service wraps durable mutations.

**Tech Stack:** Bun 1.4, TypeScript, Hono, Drizzle/D1, React Router, Go 1.26, Cloudflare Workers/R2.

## Global Constraints

- Treat uploaded files, rendered sites, comments, filenames, notes, and locators as untrusted input.
- Keep app credentials out of the content origin.
- Use the existing Postplan content hostname and stable site URLs.
- Do not add mentions, MCP, Docker, Postgres, Kubernetes, per-version domains, or immutable review URLs.
- Run `bun run build:generated` after changing generated inputs.

---

### Task 1: Persistence and durable mutation primitives

**Files:** Modify `packages/api/src/db/schema.ts`; create `packages/api/drizzle/0034_feedback_workflow.sql`, `packages/api/src/db/idempotency.ts`, `packages/api/src/db/action-ledger.ts`, and focused database tests.

**Interfaces:** Produce feedback/version/share-link tables plus `runIdempotentMutation()` and `recordAction()` helpers.

- [ ] Write failing schema and helper tests for actor/action/key replay, payload conflicts, and append-only ledger rows.
- [ ] Run the focused tests and confirm failures are caused by missing tables/helpers.
- [ ] Add the migration, Drizzle declarations, and minimal helpers.
- [ ] Run focused tests green and commit `feat(api): add workflow persistence`.

### Task 2: Feedback batch API

**Files:** Create `packages/api/src/db/feedback.ts`, `packages/api/src/routes/feedback.ts`, route tests; modify `packages/api/src/index.ts` and comment wire types.

**Interfaces:** Produce send, undo, list, claim, and complete endpoints with stable `FeedbackBatchView` JSON.

- [ ] Write failing tests for explicit selection, all-open expansion, five-second delay, undo, exclusive claim, claimant-only completion, untouched unsent comments, stable locator payloads, and authorization.
- [ ] Run focused tests red.
- [ ] Implement repository operations and routes using conditional updates and idempotency records.
- [ ] Run focused tests green and commit `feat(api): add feedback batches`.

### Task 3: Deployment notes, linkage, ledger, and diffs

**Files:** Modify upload/version routes and tests, storage helpers, and web/CLI version models.

**Interfaces:** Publish/rollback accept `Idempotency-Key`; versions expose `notes`, `feedbackBatchId`, filename changes, and a bounded text-diff endpoint.

- [ ] Write failing tests for replay-safe publish/rollback, ledger rows, feedback linkage, notes, changed filenames, unified text output, and binary/size limits.
- [ ] Run focused tests red.
- [ ] Implement mutation wrapping, version metadata, and safe R2-backed text diffing.
- [ ] Run focused tests green and commit `feat(versions): add notes and text diffs`.

### Task 4: CLI feedback and version workflow

**Files:** Modify `packages/cli/internal/argparse`, `run.go`, `help.go`, `deploy.go`, `versions.go`; create `feedback.go` and tests.

**Interfaces:** Add stable typed JSON for feedback list/claim/complete and deploy flags `--notes`, `--feedback-batch`, and `--idempotency-key`.

- [ ] Write failing dispatch/request/JSON tests for every command and flag.
- [ ] Run focused Go tests red.
- [ ] Implement minimal typed clients and human output.
- [ ] Run focused Go tests green and commit `feat(cli): add feedback workflow`.

### Task 5: Review selection and Undo UI

**Files:** Modify `ReviewRail.tsx`, `ThreadCard.tsx`, viewer route, comment client/types, and component tests.

**Interfaces:** Add selected comment IDs, Send selected, Send all open, compact five-second Undo toast, and batch API calls.

- [ ] Write failing component/pure-client tests for selection, send payload, compact toast copy, Undo timing, and unsent-thread preservation.
- [ ] Run focused web tests red.
- [ ] Implement accessible selection controls and mutation state.
- [ ] Run focused tests green and commit `feat(review): queue selected feedback`.

### Task 6: Anchors and Experience/Comment mode

**Files:** Modify annotation client/protocol, viewer route/top bar/rail, anchor wire types, and tests.

**Interfaces:** Add `postplan:mode` and anchor-resolution events; expose creation version and missing status in thread cards.

- [ ] Write failing reducer/protocol/component tests for Experience default, Comment activation, restored interaction, exact locator preservation, and missing-anchor labels.
- [ ] Run focused tests red.
- [ ] Implement parent/frame mode switching and resolution reporting over the trusted channel.
- [ ] Run focused tests green and commit `feat(review): add explicit comment mode`.

### Task 7: Share CLI and expiring links

**Files:** Add share-link schema/API tests and routes; modify share access/token logic; add Go `shares.go`, help, and tests.

**Interfaces:** Add owner-only list/grant/revoke commands and create/list/revoke expiring site links with hashed secrets.

- [ ] Write failing API tests for expiry, revocation, site scope, no version pinning, and existing-host redirects; write CLI request/JSON tests.
- [ ] Run focused TypeScript and Go tests red.
- [ ] Implement share endpoints, live access checks, and CLI commands by reusing existing share models.
- [ ] Run focused tests green and commit `feat(sharing): add CLI and expiring links`.

### Task 8: Public landing route

**Files:** Modify `packages/web/src/router.tsx`, landing/login route modules, and router/loader tests.

**Interfaces:** `/` always renders public marketing; `/login` alone redirects authenticated visitors.

- [ ] Write a failing route/loader regression test for authenticated `/`.
- [ ] Run it red.
- [ ] Split public landing behavior from login redirect behavior.
- [ ] Run focused tests green and commit `fix(web): keep landing page public`.

### Task 9: Agent docs and release notes

**Files:** Modify `packages/cli/internal/cli/SKILL.md`, `llms.txt`, API docs, README, and add a release note.

**Interfaces:** Document explicit-send-only consumption, commands, JSON, and safety boundaries.

- [ ] Add/update documentation contract tests where available.
- [ ] Update canonical sources without mentioning unsent-comment consumption.
- [ ] Run `bun run build:generated` and confirm generated files match.
- [ ] Commit `docs: document feedback handoff`.

### Task 10: End-to-end verification and PR

**Files:** No intended source changes beyond fixes exposed by verification.

- [ ] Run relevant suites, `bun run test`, `bun run typecheck`, `bun run lint`, `bun run format:check`, `bun run build:web`, and `go test ./...` from `packages/cli`.
- [ ] Start local API/content/web services and attach T3 Preview at `http://localhost:5173`.
- [ ] Exercise select/send/Undo, claim/reply/deploy/complete, missing-anchor and Experience/Comment flows.
- [ ] Confirm `git diff --check`, ignored secrets, and logical commit history.
- [ ] Verify `gh auth status`, push the feature branch, create the PR, and verify its head branch and checks.
