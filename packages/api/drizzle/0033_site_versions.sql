CREATE TABLE `site_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`siteId` text NOT NULL,
	`version` integer NOT NULL,
	`description` text,
	`restoredFrom` integer,
	`createdBy` text,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_versions_site_version_unq` ON `site_versions` (`siteId`,`version`);
--> statement-breakpoint
CREATE INDEX `site_versions_site` ON `site_versions` (`siteId`);
--> statement-breakpoint
CREATE TABLE `site_version_files` (
	`id` text PRIMARY KEY NOT NULL,
	`versionId` text NOT NULL,
	`path` text NOT NULL,
	`storageKey` text NOT NULL,
	`mimeType` text,
	`size` integer,
	`etag` text,
	FOREIGN KEY (`versionId`) REFERENCES `site_versions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_version_files_version_path_unq` ON `site_version_files` (`versionId`,`path`);
