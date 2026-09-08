ALTER TABLE `comment_threads` ADD `createdVersion` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `site_versions` ADD `changeNotes` text;
--> statement-breakpoint
ALTER TABLE `site_versions` ADD `feedbackBatchId` text;
--> statement-breakpoint
CREATE TABLE `feedback_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`siteId` text NOT NULL,
	`siteVersion` integer NOT NULL,
	`status` text NOT NULL DEFAULT 'queued',
	`createdBy` text,
	`claimedBy` text,
	`idempotencyKey` text NOT NULL,
	`requestHash` text NOT NULL,
	`claimableAt` text NOT NULL,
	`claimedAt` text,
	`completedAt` text,
	`cancelledAt` text,
	`completedVersion` integer,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`claimedBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feedback_batches_actor_key_unq` ON `feedback_batches` (`createdBy`,`idempotencyKey`);
--> statement-breakpoint
CREATE INDEX `feedback_batches_status_claimable` ON `feedback_batches` (`status`,`claimableAt`);
--> statement-breakpoint
CREATE INDEX `feedback_batches_site_created` ON `feedback_batches` (`siteId`,`createdAt`);
--> statement-breakpoint
CREATE TABLE `feedback_batch_items` (
	`batchId` text NOT NULL,
	`commentId` text NOT NULL,
	FOREIGN KEY (`batchId`) REFERENCES `feedback_batches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`commentId`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE cascade,
	PRIMARY KEY (`batchId`,`commentId`)
);
--> statement-breakpoint
CREATE INDEX `feedback_batch_items_comment` ON `feedback_batch_items` (`commentId`);
--> statement-breakpoint
CREATE TABLE `idempotency_records` (
	`actorId` text NOT NULL,
	`action` text NOT NULL,
	`key` text NOT NULL,
	`requestHash` text NOT NULL,
	`statusCode` integer NOT NULL,
	`response` text NOT NULL,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`actorId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	PRIMARY KEY (`actorId`,`action`,`key`)
);
--> statement-breakpoint
CREATE TABLE `action_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`actorId` text,
	`action` text NOT NULL,
	`siteId` text,
	`siteVersion` integer,
	`authorization` text NOT NULL,
	`targetId` text,
	`idempotencyKey` text,
	`metadata` text,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`actorId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `action_ledger_site_created` ON `action_ledger` (`siteId`,`createdAt`);
--> statement-breakpoint
CREATE INDEX `action_ledger_actor_created` ON `action_ledger` (`actorId`,`createdAt`);
--> statement-breakpoint
CREATE TABLE `site_share_links` (
	`id` text PRIMARY KEY NOT NULL,
	`siteId` text NOT NULL,
	`tokenHash` text NOT NULL,
	`createdBy` text,
	`expiresAt` text NOT NULL,
	`revokedAt` text,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_share_links_token_unq` ON `site_share_links` (`tokenHash`);
--> statement-breakpoint
CREATE INDEX `site_share_links_site_created` ON `site_share_links` (`siteId`,`createdAt`);
