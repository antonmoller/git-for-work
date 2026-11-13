CREATE TABLE `event` (
	`aseq` integer PRIMARY KEY,
	`id` text NOT NULL UNIQUE,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`trajectory` text,
	`member` text,
	`body` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `meta` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
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
