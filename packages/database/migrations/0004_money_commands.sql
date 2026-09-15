CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."chore_destination" AS ENUM('spend', 'save');--> statement-breakpoint
CREATE TYPE "public"."chore_status" AS ENUM('open', 'submitted', 'redo', 'paid', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."money_command_status" AS ENUM('executing', 'executed', 'approval_pending', 'rejected');--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"command_hash" text NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"requested_by_member_id" uuid,
	"decided_by_member_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"assigned_member_id" uuid NOT NULL,
	"created_by_member_id" uuid,
	"title" text NOT NULL,
	"detail" text,
	"reward_minor" integer NOT NULL,
	"destination" "chore_destination" DEFAULT 'spend' NOT NULL,
	"status" "chore_status" DEFAULT 'open' NOT NULL,
	"redo_note" text,
	"submitted_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chores_reward_range" CHECK ("chores"."reward_minor" >= 0 and "chores"."reward_minor" <= 100000)
);
--> statement-breakpoint
CREATE TABLE "money_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"actor_member_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "money_command_status" NOT NULL,
	"display" jsonb,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_command_id_money_commands_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."money_commands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requested_by_member_id_family_members_id_fk" FOREIGN KEY ("requested_by_member_id") REFERENCES "public"."family_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_member_id_family_members_id_fk" FOREIGN KEY ("decided_by_member_id") REFERENCES "public"."family_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chores" ADD CONSTRAINT "chores_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chores" ADD CONSTRAINT "chores_assigned_member_id_family_members_id_fk" FOREIGN KEY ("assigned_member_id") REFERENCES "public"."family_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chores" ADD CONSTRAINT "chores_created_by_member_id_family_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."family_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_commands" ADD CONSTRAINT "money_commands_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_commands" ADD CONSTRAINT "money_commands_actor_member_id_family_members_id_fk" FOREIGN KEY ("actor_member_id") REFERENCES "public"."family_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_command_key" ON "approvals" USING btree ("command_id");--> statement-breakpoint
CREATE INDEX "approvals_family_status_idx" ON "approvals" USING btree ("family_id","status");--> statement-breakpoint
CREATE INDEX "chores_family_idx" ON "chores" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "chores_assigned_idx" ON "chores" USING btree ("assigned_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "money_commands_actor_key" ON "money_commands" USING btree ("family_id","actor_member_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "money_commands_family_created_idx" ON "money_commands" USING btree ("family_id","created_at");--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_command_id_money_commands_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."money_commands"("id") ON DELETE set null ON UPDATE no action;