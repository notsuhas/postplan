CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`name` text NOT NULL,
	`hash` text NOT NULL,
	`grants` text NOT NULL,
	`createdAt` text NOT NULL,
	`expiresAt` text NOT NULL,
	`revokedAt` text,
	`lastUsedAt` text,
	`displaySuffix` text,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_unique` ON `api_keys` (`hash`);--> statement-breakpoint
CREATE INDEX `api_keys_user_created` ON `api_keys` (`userId`,`createdAt`);--> statement-breakpoint
CREATE TABLE `change_log` (
	`siteId` text NOT NULL,
	`seq` integer NOT NULL,
	`collection` text NOT NULL,
	`docId` text NOT NULL,
	`createdBy` text NOT NULL,
	`type` text NOT NULL,
	`at` text NOT NULL,
	PRIMARY KEY(`siteId`, `seq`),
	FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `comment_reactions` (
	`commentId` text NOT NULL,
	`userId` text NOT NULL,
	`emoji` text NOT NULL,
	`createdAt` text NOT NULL,
	PRIMARY KEY(`commentId`, `userId`, `emoji`),
	FOREIGN KEY (`commentId`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `comment_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`siteId` text NOT NULL,
	`filePath` text NOT NULL,
	`anchorType` text DEFAULT 'text' NOT NULL,
	`quote` text,
	`anchor` text,
	`contentHash` text,
	`anchorStatus` text DEFAULT 'anchored' NOT NULL,
	`start` integer,
	`end` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`resolvedBy` text,
	`resolvedAt` text,
	`createdBy` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resolvedBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `threads_site_file_status` ON `comment_threads` (`siteId`,`filePath`,`status`);--> statement-breakpoint
CREATE INDEX `threads_site_status_updated` ON `comment_threads` (`siteId`,`status`,`updatedAt`);--> statement-breakpoint
CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`threadId` text NOT NULL,
	`authorId` text,
	`body` text NOT NULL,
	`createdAt` text NOT NULL,
	`editedAt` text,
	`deletedAt` text,
	`audioKey` text,
	FOREIGN KEY (`threadId`) REFERENCES `comment_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`authorId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `comments_thread_created` ON `comments` (`threadId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `comments_author_deleted_created` ON `comments` (`authorId`,`deletedAt`,`createdAt`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`siteId` text NOT NULL,
	`collection` text NOT NULL,
	`docId` text NOT NULL,
	`json` text NOT NULL,
	`createdBy` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `documents_site_collection_creator` ON `documents` (`siteId`,`collection`,`createdBy`);--> statement-breakpoint
CREATE UNIQUE INDEX `documents_site_collection_doc_unq` ON `documents` (`siteId`,`collection`,`docId`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`action` text,
	`userId` text,
	`siteId` text,
	`siteLabel` text,
	`cliVersion` text,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `events_type_created` ON `events` (`type`,`createdAt`);--> statement-breakpoint
CREATE INDEX `events_site_created` ON `events` (`siteId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `events_user_created` ON `events` (`userId`,`createdAt`);--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`siteId` text NOT NULL,
	`path` text NOT NULL,
	`storageKey` text NOT NULL,
	`mimeType` text,
	`size` integer,
	`etag` text,
	`contentHash` text,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `files_storageKey_unique` ON `files` (`storageKey`);--> statement-breakpoint
CREATE UNIQUE INDEX `files_site_path_unq` ON `files` (`siteId`,`path`);--> statement-breakpoint
CREATE TABLE `invites` (
	`email` text PRIMARY KEY NOT NULL,
	`invitedBy` text NOT NULL,
	`createdAt` integer NOT NULL,
	`usedAt` integer,
	`workosUserId` text
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`recipientId` text NOT NULL,
	`type` text NOT NULL,
	`actorId` text,
	`siteId` text,
	`siteLabel` text,
	`threadId` text,
	`commentId` text,
	`filePath` text,
	`snippet` text,
	`readAt` text,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`recipientId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actorId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`threadId`) REFERENCES `comment_threads`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`commentId`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `notifications_recipient_read_created` ON `notifications` (`recipientId`,`readAt`,`createdAt`);--> statement-breakpoint
CREATE INDEX `notifications_recipient_created` ON `notifications` (`recipientId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `notifications_comment` ON `notifications` (`commentId`);--> statement-breakpoint
CREATE INDEX `notifications_read_created` ON `notifications` (`readAt`,`createdAt`);--> statement-breakpoint
CREATE TABLE `purged_event_counts` (
	`type` text PRIMARY KEY NOT NULL,
	`count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `site_group_shares` (
	`siteId` text NOT NULL,
	`spaceId` text NOT NULL,
	PRIMARY KEY(`siteId`, `spaceId`),
	FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`spaceId`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `site_group_shares_space` ON `site_group_shares` (`spaceId`);--> statement-breakpoint
CREATE TABLE `site_stars` (
	`siteId` text NOT NULL,
	`userId` text NOT NULL,
	`createdAt` text NOT NULL,
	PRIMARY KEY(`siteId`, `userId`),
	FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `site_stars_user` ON `site_stars` (`userId`);--> statement-breakpoint
CREATE TABLE `site_summaries` (
	`id` text PRIMARY KEY NOT NULL,
	`siteId` text NOT NULL,
	`summary` text NOT NULL,
	`contentVersion` integer NOT NULL,
	`promptVersion` integer NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`generatedBy` text,
	`truncated` integer DEFAULT false NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`generatedBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_summaries_siteId_unique` ON `site_summaries` (`siteId`);--> statement-breakpoint
CREATE TABLE `site_user_shares` (
	`siteId` text NOT NULL,
	`userId` text NOT NULL,
	`role` text DEFAULT 'viewer' NOT NULL,
	PRIMARY KEY(`siteId`, `userId`),
	FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `site_user_shares_user` ON `site_user_shares` (`userId`);--> statement-breakpoint
CREATE TABLE `sites` (
	`id` text PRIMARY KEY NOT NULL,
	`spaceId` text NOT NULL,
	`slug` text NOT NULL,
	`title` text,
	`description` text,
	`visibility` text DEFAULT 'team' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`ownerId` text NOT NULL,
	`contentVersion` integer DEFAULT 0 NOT NULL,
	`lastReplacedBy` text,
	`forkedFrom` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	FOREIGN KEY (`spaceId`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`forkedFrom`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `sites_owner` ON `sites` (`ownerId`);--> statement-breakpoint
CREATE INDEX `sites_status_visibility_updated` ON `sites` (`status`,`visibility`,`updatedAt`);--> statement-breakpoint
CREATE UNIQUE INDEX `sites_space_slug_unq` ON `sites` (`spaceId`,`slug`);--> statement-breakpoint
CREATE TABLE `space_members` (
	`spaceId` text NOT NULL,
	`userId` text NOT NULL,
	PRIMARY KEY(`spaceId`, `userId`),
	FOREIGN KEY (`spaceId`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `space_members_user` ON `space_members` (`userId`);--> statement-breakpoint
CREATE TABLE `spaces` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`createdBy` text NOT NULL,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `spaces_slug_unique` ON `spaces` (`slug`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`googleId` text,
	`avatarUrl` text,
	`role` text DEFAULT 'member' NOT NULL,
	`createdAt` text NOT NULL,
	`lastSeenReleaseAt` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_googleId_unique` ON `users` (`googleId`);
