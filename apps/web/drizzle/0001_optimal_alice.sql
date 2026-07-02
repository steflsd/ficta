DROP INDEX "threads_user_updated_idx";--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "org_id" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
CREATE INDEX "threads_scope_updated_idx" ON "threads" USING btree ("user_id","org_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
-- Backfill: existing threads default to org_id='local'. Pre-org WorkOS threads (any non-local user) move to
-- their author's personal workspace, matching the requireScope() `user:<id>` fallback.
UPDATE "threads" SET "org_id" = 'user:' || "user_id" WHERE "user_id" <> 'local';--> statement-breakpoint
-- The former single instance-settings row (keyed "default") is the local/none-mode workspace's settings.
UPDATE "instance_settings" SET "id" = 'local' WHERE "id" = 'default';