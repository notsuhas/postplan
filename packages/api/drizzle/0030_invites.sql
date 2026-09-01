-- Email-pinned invite gate. Replaces the Google-Workspace `hd` claim check dropped when auth moved
-- to WorkOS: WorkOS brokers Google for ANY account, so "who may sign in" can no longer be inferred
-- from the email domain and has to be an explicit allowlist.
--
-- The email IS the primary key — inviting an address is the whole invite, so there is no token to
-- leak, expire or re-send. Admins (SUPERADMIN_EMAIL + ADMIN_EMAILS) bypass the gate but still get a
-- row on first sign-in, so a People view can tell "invited, never signed in" from "signed in".
--
-- usedAt is coalesced on write (keeps the FIRST sign-in), workosUserId is always refreshed —
-- revocation deletes that WorkOS user, so a stale id would revoke the wrong account or none.
-- Epoch-millis integers here rather than the ISO-8601 text used elsewhere, matching how the
-- callback stamps them without a round-trip through Date.
CREATE TABLE `invites` (
	`email` text PRIMARY KEY NOT NULL,
	`invitedBy` text NOT NULL,
	`createdAt` integer NOT NULL,
	`usedAt` integer,
	`workosUserId` text
);
