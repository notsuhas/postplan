-- window.storage for sites: personal keys belong to one viewer, shared keys (ownerId '') to the site.
CREATE TABLE `site_kv` (
	`siteId` text NOT NULL REFERENCES `sites`(`id`) ON DELETE cascade,
	`ownerId` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updatedAt` text NOT NULL,
	PRIMARY KEY (`siteId`, `ownerId`, `key`)
);
