CREATE TABLE IF NOT EXISTS `invites` (
	`email` text PRIMARY KEY NOT NULL,
	`invitedBy` text NOT NULL,
	`createdAt` integer NOT NULL,
	`usedAt` integer,
	`workosUserId` text
);
--> statement-breakpoint
INSERT OR IGNORE INTO `invites` (`email`, `invitedBy`, `createdAt`, `usedAt`)
SELECT `email`, 'migration', CAST(strftime('%s', 'now') AS integer) * 1000, CAST(strftime('%s', 'now') AS integer) * 1000
FROM `users`
WHERE `role` <> 'superadmin';
