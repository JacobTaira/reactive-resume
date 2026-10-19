ALTER TABLE "application" ADD COLUMN "capture_identity" text;--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "capture" jsonb;--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "preparation" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "application_capture_identity_unique" ON "application" ("user_id", "capture_identity");--> statement-breakpoint
CREATE INDEX "application_queue_created_idx" ON "application" ("user_id", "created_at", "id");
