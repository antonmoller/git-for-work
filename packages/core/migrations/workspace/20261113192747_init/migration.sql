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
CREATE TABLE `entry` (
	`seq` integer PRIMARY KEY,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`actor` text NOT NULL,
	`member` text,
	`session` text,
	`trajectory` text,
	`keys` text NOT NULL,
	`title` text,
	`version` integer,
	`base` integer,
	`content` text,
	`fields` text NOT NULL,
	`revert_of` integer,
	`text` text,
	`to` text,
	`ref` integer,
	`task` integer,
	`prev` text NOT NULL,
	`hash` text NOT NULL
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
CREATE INDEX `entry_session` ON `entry` (`session`);--> statement-breakpoint
CREATE INDEX `entry_to` ON `entry` (`to`);--> statement-breakpoint
CREATE INDEX `entry_at` ON `entry` (`at`);