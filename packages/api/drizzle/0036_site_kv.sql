-- window.storage for sites: personal keys belong to one viewer, shared keys (ownerId '') to the site.
-- `bytes` is the UTF-8 size of key + value; sites.kvBytes / kvCount are kept by triggers (as docCount
-- is) so the site quota is checked without scanning.
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
ALTER TABLE `sites` ADD COLUMN `kvBytes` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `sites` ADD COLUMN `kvCount` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TRIGGER `site_kv_insert` AFTER INSERT ON `site_kv` BEGIN
	UPDATE `sites` SET `kvBytes` = `kvBytes` + NEW.`bytes`, `kvCount` = `kvCount` + 1 WHERE `id` = NEW.`siteId`;
END;
--> statement-breakpoint
CREATE TRIGGER `site_kv_update` AFTER UPDATE ON `site_kv` BEGIN
	UPDATE `sites` SET `kvBytes` = `kvBytes` - OLD.`bytes` + NEW.`bytes` WHERE `id` = NEW.`siteId`;
END;
--> statement-breakpoint
CREATE TRIGGER `site_kv_delete` AFTER DELETE ON `site_kv` BEGIN
	UPDATE `sites` SET `kvBytes` = `kvBytes` - OLD.`bytes`, `kvCount` = `kvCount` - 1 WHERE `id` = OLD.`siteId`;
END;
--> statement-breakpoint
-- ownerId can't be a foreign key ('' marks shared rows), so a deleted user's personal rows go here.
CREATE TRIGGER `site_kv_user_delete` AFTER DELETE ON `users` BEGIN
	DELETE FROM `site_kv` WHERE `ownerId` = OLD.`id`;
END;
