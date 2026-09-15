CREATE TYPE "public"."interview_status" AS ENUM('active', 'complete');--> statement-breakpoint
ALTER TYPE "public"."learning_source_kind" ADD VALUE 'youtube';--> statement-breakpoint
ALTER TYPE "public"."learning_source_kind" ADD VALUE 'text';--> statement-breakpoint
CREATE TABLE "cheatsheets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"owner_member_id" uuid NOT NULL,
	"document_id" uuid,
	"title" text NOT NULL,
	"blocks" jsonb NOT NULL,
	"created_by_member_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "class_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"weekday" integer NOT NULL,
	"starts_at" text NOT NULL,
	"ends_at" text NOT NULL,
	"location" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "class_sessions_weekday_check" CHECK ("class_sessions"."weekday" between 0 and 6),
	CONSTRAINT "class_sessions_times_check" CHECK ("class_sessions"."starts_at" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and "class_sessions"."ends_at" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and "class_sessions"."ends_at" > "class_sessions"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "interview_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"document_id" uuid,
	"title" text NOT NULL,
	"status" "interview_status" DEFAULT 'active' NOT NULL,
	"question_count" integer NOT NULL,
	"questions" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "learning_evidence" ADD COLUMN "client_ref" uuid;--> statement-breakpoint
ALTER TABLE "learning_sources" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "cheatsheets" ADD CONSTRAINT "cheatsheets_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cheatsheets" ADD CONSTRAINT "cheatsheets_owner_member_id_family_members_id_fk" FOREIGN KEY ("owner_member_id") REFERENCES "public"."family_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cheatsheets" ADD CONSTRAINT "cheatsheets_document_id_learning_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."learning_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cheatsheets" ADD CONSTRAINT "cheatsheets_created_by_member_id_family_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."family_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_member_id_family_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."family_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_sessions" ADD CONSTRAINT "interview_sessions_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_sessions" ADD CONSTRAINT "interview_sessions_member_id_family_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."family_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_sessions" ADD CONSTRAINT "interview_sessions_document_id_learning_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."learning_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cheatsheets_owner_idx" ON "cheatsheets" USING btree ("owner_member_id");--> statement-breakpoint
CREATE INDEX "class_sessions_member_idx" ON "class_sessions" USING btree ("member_id","weekday");--> statement-breakpoint
CREATE INDEX "interview_sessions_member_idx" ON "interview_sessions" USING btree ("member_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "learning_evidence_client_ref_key" ON "learning_evidence" USING btree ("member_id","client_ref") WHERE "learning_evidence"."client_ref" is not null;