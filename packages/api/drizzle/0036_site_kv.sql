-- window.storage for sites: each viewer's own keys, gone with the site or the user.
-- `bytes` is the UTF-8 size of key + value, so a viewer's quota is one indexed sum.
CREATE TABLE `site_kv` (
	`siteId` text NOT NULL REFERENCES `sites`(`id`) ON DELETE cascade,
	`userId` text NOT NULL REFERENCES `users`(`id`) ON DELETE cascade,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`bytes` integer NOT NULL,
	`updatedAt` text NOT NULL,
	PRIMARY KEY (`siteId`, `userId`, `key`)
);
