CREATE TABLE `access` (
	`id` text PRIMARY KEY,
	`allowed` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspace` (
	`slug` text PRIMARY KEY,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`rules` text NOT NULL
);
