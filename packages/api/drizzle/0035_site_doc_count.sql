-- Triggers keep document quotas accurate even when FK cascades delete documents.
ALTER TABLE `sites` ADD COLUMN `docCount` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TRIGGER `documents_doc_count_insert` AFTER INSERT ON `documents` BEGIN
	UPDATE `sites` SET `docCount` = `docCount` + 1 WHERE `id` = NEW.`siteId`;
END;
--> statement-breakpoint
CREATE TRIGGER `documents_doc_count_delete` AFTER DELETE ON `documents` BEGIN
	UPDATE `sites` SET `docCount` = `docCount` - 1 WHERE `id` = OLD.`siteId`;
END;
--> statement-breakpoint
UPDATE `sites` SET `docCount` = (SELECT count(*) FROM `documents` WHERE `documents`.`siteId` = `sites`.`id`)
WHERE `id` IN (SELECT `siteId` FROM `documents`);
