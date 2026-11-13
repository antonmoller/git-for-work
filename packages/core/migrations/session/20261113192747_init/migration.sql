CREATE TABLE `meta` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `step` (
	`seq` integer PRIMARY KEY,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`trajectory` text,
	`member` text NOT NULL,
	`text` text,
	`key` text,
	`title` text,
	`version` integer,
	`entry` integer,
	`data` text,
	`prev` text NOT NULL,
	`hash` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `trajectory` (
	`id` text PRIMARY KEY,
	`intent` text NOT NULL,
	`for_handle` text NOT NULL,
	`for_name` text NOT NULL,
	`member` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer
);
