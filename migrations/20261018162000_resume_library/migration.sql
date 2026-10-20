CREATE TABLE "resume_folder" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"parent_id" text
);
--> statement-breakpoint
CREATE TABLE "company_research" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"company" text NOT NULL,
	"company_key" text NOT NULL,
	"website" text DEFAULT '' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"core_values" text[] DEFAULT '{}' NOT NULL,
	"culture" text DEFAULT '' NOT NULL,
	"hiring_priorities" text[] DEFAULT '{}' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"sources" jsonb DEFAULT '[]' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "resume" ADD COLUMN "folder_id" text;
--> statement-breakpoint
ALTER TABLE "resume" ADD COLUMN "source_resume_id" text;
--> statement-breakpoint
ALTER TABLE "resume" ADD COLUMN "company_id" text;
--> statement-breakpoint
ALTER TABLE "resume" ADD COLUMN "profile" jsonb DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE "resume_folder" ADD CONSTRAINT "resume_folder_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "resume_folder" ADD CONSTRAINT "resume_folder_parent_id_resume_folder_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "resume_folder"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "company_research" ADD CONSTRAINT "company_research_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "resume" ADD CONSTRAINT "resume_folder_id_resume_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "resume_folder"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "resume" ADD CONSTRAINT "resume_source_resume_id_resume_id_fkey" FOREIGN KEY ("source_resume_id") REFERENCES "resume"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "resume" ADD CONSTRAINT "resume_company_id_company_research_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company_research"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX "resume_folder_user_id_parent_id_index" ON "resume_folder" ("user_id", "parent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "company_research_user_id_company_key_index" ON "company_research" ("user_id", "company_key");
--> statement-breakpoint
CREATE INDEX "company_research_user_id_updated_at_index" ON "company_research" ("user_id", "updated_at" DESC);
--> statement-breakpoint
CREATE INDEX "resume_user_id_folder_id_index" ON "resume" ("user_id", "folder_id");
