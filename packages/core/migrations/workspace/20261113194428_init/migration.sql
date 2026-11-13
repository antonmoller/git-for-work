CREATE TABLE `claim` (
	`key` text PRIMARY KEY,
	`title` text,
	`session` text NOT NULL,
	`trajectory` text,
	`intent` text,
	`holder` text NOT NULL,
	`member` text NOT NULL,
	`since` integer NOT NULL,
	`last_active` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cursor` (
	`session` text PRIMARY KEY,
	`seq` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `drain` (
	`id` integer PRIMARY KEY,
	`seq` integer NOT NULL,
	`hash` text NOT NULL,
	`in_flight` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `entry` (
	`seq` integer PRIMARY KEY,
	`id` text NOT NULL UNIQUE,
	`aggregate` text NOT NULL,
	`aseq` integer NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`by` text NOT NULL,
	`member` text,
	`session` text,
	`trajectory` text,
	`keys` text NOT NULL,
	`to` text,
	`version` integer,
	`body` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `field` (
	`key` text NOT NULL,
	`field` text NOT NULL,
	`value` text,
	`version` integer NOT NULL,
	CONSTRAINT `field_pk` PRIMARY KEY(`key`, `field`)
);
--> statement-breakpoint
CREATE TABLE `presence` (
	`session` text PRIMARY KEY,
	`owner` text NOT NULL,
	`members` text NOT NULL,
	`last_active` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sequence` (
	`aggregate` text PRIMARY KEY,
	`aseq` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task` (
	`id` integer PRIMARY KEY,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`from_trajectory` text,
	`to` text,
	`taker` text,
	`taken_at` integer,
	`done_at` integer
);
--> statement-breakpoint
CREATE TABLE `trajectory` (
	`id` text PRIMARY KEY,
	`session` text NOT NULL,
	`intent` text NOT NULL,
	`owner` text NOT NULL,
	`for_handle` text NOT NULL,
	`for_name` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`steps` integer NOT NULL,
	`tools` integer NOT NULL,
	`writes` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `url` (
	`key` text PRIMARY KEY,
	`title` text,
	`version` integer,
	`content` text,
	`written_at` integer,
	`written_by` text,
	`seq` integer
);
--> statement-breakpoint
CREATE TABLE `version` (
	`key` text NOT NULL,
	`version` integer NOT NULL,
	`seq` integer NOT NULL,
	`at` integer NOT NULL,
	`actor` text NOT NULL,
	`session` text,
	`trajectory` text,
	`intent` text,
	`why` text,
	`base` integer,
	`content` text NOT NULL,
	`changed` text NOT NULL,
	`before` text NOT NULL,
	`after` text NOT NULL,
	`revert_of` integer,
	`reads` text NOT NULL,
	CONSTRAINT `version_pk` PRIMARY KEY(`key`, `version`)
);
--> statement-breakpoint
CREATE TABLE `waiter` (
	`id` integer PRIMARY KEY,
	`keys` text NOT NULL,
	`titles` text NOT NULL,
	`session` text NOT NULL,
	`trajectory` text,
	`intent` text,
	`actor` text NOT NULL,
	`member` text NOT NULL,
	`since` integer NOT NULL,
	`deadline` integer NOT NULL,
	`status` text NOT NULL,
	`seq` integer
);
--> statement-breakpoint
CREATE INDEX `claim_session` ON `claim` (`session`);--> statement-breakpoint
CREATE UNIQUE INDEX `entry_aggregate_aseq` ON `entry` (`aggregate`,`aseq`);--> statement-breakpoint
CREATE INDEX `entry_session` ON `entry` (`session`,`seq`);--> statement-breakpoint
CREATE INDEX `entry_trajectory` ON `entry` (`trajectory`,`seq`);--> statement-breakpoint
CREATE INDEX `entry_kind` ON `entry` (`kind`,`seq`);--> statement-breakpoint
CREATE INDEX `entry_to` ON `entry` (`to`);--> statement-breakpoint
CREATE INDEX `entry_at` ON `entry` (`at`);