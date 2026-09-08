# Human-selected feedback workflow

## Purpose

Postplan will let reviewers explicitly hand selected comment messages to an agent without changing normal human review threads. Agents never scan arbitrary open comments; they only list durable feedback batches that a reviewer sent.

## Workflow

Authenticated reviewers may select individual, non-deleted comments from open threads or choose **Send all open to agent**. Sending snapshots stable comment IDs and the site's current content version into a queued batch. The UI shows only `N comments queued · Undo`. The batch is not claimable until five seconds after creation. Undo during that window cancels it without touching comments.

An agent lists claimable batches, atomically claims one, replies through the existing thread reply API, deploys a version that references the batch, and completes the batch. Batch states are `queued`, `claimed`, `completed`, and `cancelled`. A conditional database update makes claim exclusive. Completion requires the claiming actor, while existing comment resolution authorization remains unchanged.

## Data model

- `feedback_batches`: site, reviewed version, lifecycle timestamps, creator and claimant, optional completed deployment version, and an idempotency key.
- `feedback_batch_items`: batch/comment pairs. The comment row remains authoritative; selection does not mutate the thread or message.
- `action_ledger`: append-only actor/action/site/version records containing the authorization path, target identifier, idempotency key, timestamp, and bounded JSON metadata.
- `idempotency_records`: actor-scoped operation keys and serialized successful results for publish, rollback, feedback send, undo, and claim.
- Version records gain optional change notes and feedback batch linkage.
- Comment threads gain the content version where the anchor was created.
- Expiring share links store only a token hash, expiry, creator, revocation time, and site.

All new foreign keys follow existing deletion semantics. Human-authored content, locators, notes, and filenames remain untrusted and are rendered as text.

## API and authorization

Feedback routes live under `/api/sites/:space/:site/feedback`. Readable-site access is sufficient to send a batch because reviewers must be able to hand off their own review. Listing and claiming use the caller's existing access and API-key capability ceiling. Only the claimant can complete a claimed batch. Owners retain all existing moderation powers; no new resolution rule is introduced.

Every idempotent mutation accepts `Idempotency-Key`. Repeating the same actor/action/key returns the stored success. Reusing a key with a different operation or payload fails closed. Claim uses an atomic `UPDATE ... WHERE status = 'queued' AND claimableAt <= now` and records the result in the same database batch.

The feedback JSON contract includes batch state/version and, per item: stable comment and thread IDs, page/file path, anchor type/status, quote, normalized text or element context, author display name, body, and creation timestamp.

## CLI and agent contract

Add:

- `postplan feedback list [space/site] [--json]`
- `postplan feedback claim <batch-id> [--json]`
- `postplan feedback complete <batch-id> [--version N] [--json]`
- `postplan shares list <space/site> [--json]`
- `postplan shares grant|revoke ...`
- `postplan shares link create|list|revoke ...`

Deploy and rollback accept notes and idempotency options; deploy can reference a claimed feedback batch. Machine output uses explicit structs rather than loose maps. The canonical skill and `llms.txt` state that only sent feedback may be consumed and that replies go through the original thread IDs.

## Versions, anchors, and interaction modes

Version history will show added, removed, and changed filenames. A bounded diff endpoint reads immutable version objects and returns unified text diffs only for recognized text files below a size cap; binary or oversized files receive metadata-only results.

Thread payloads preserve the creation version and complete text/element locator. The annotation client reports whether each painted locator still resolves. The rail displays a clear **Anchor missing in this version** state without deleting or rewriting the stored locator.

Interactive HTML defaults to Experience mode. Comment mode enables selection, comment shortcuts, and anchor interactions. The parent sends the mode over the existing origin-checked postMessage channel; the untrusted content frame receives no app credentials.

## Sharing

CLI user/group share management reuses the existing owner-only share API. Expiring possession links add a narrow anonymous grant without changing hostnames: an app-origin link resolves an opaque token, verifies live expiry/revocation, then opens the normal viewer/content flow. Links are site-scoped, not version-scoped, and never create immutable review URLs.

## Landing page

`/` is a public marketing route regardless of authentication. `/login` remains the authentication entry and may redirect an already-authenticated user to the requested destination. Dashboard routes remain protected by their existing loaders.

## Verification

Each behavior is introduced test-first. Final verification covers API/database races and authorization, stable CLI JSON, generated artifacts, frontend interaction tests, full repository checks, and T3 Preview exercises for selection/send/undo, CLI claim/reply/deploy/complete, missing anchors, and Experience/Comment mode.
