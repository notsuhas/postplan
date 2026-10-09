-- window.storage for sites: personal keys belong to one viewer, shared keys (ownerId '') to the site.
-- `bytes` is the UTF-8 size of key + value, summed for the per-viewer and per-site quotas.
CREATE TABLE `site_kv` (
	`siteId` text NOT NULL REFERENCES `sites`(`id`) ON DELETE cascade,
	`ownerId` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`bytes` integer NOT NULL,
	`updatedAt` text NOT NULL,
	PRIMARY KEY (`siteId`, `ownerId`, `key`)
);
--> statement-breakpoint
-- ownerId can't be a foreign key ('' marks shared rows), so a deleted user's personal rows go here.
CREATE TRIGGER `site_kv_user_delete` AFTER DELETE ON `users` BEGIN
	DELETE FROM `site_kv` WHERE `ownerId` = OLD.`id`;
END;
