CREATE TYPE "public"."allowance_run_status" AS ENUM('succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."allowance_status" AS ENUM('active', 'paused');--> statement-breakpoint
CREATE TYPE "public"."goal_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."spend_request_status" AS ENUM('pending', 'approved', 'declined');--> statement-breakpoint
CREATE TABLE "allowance_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"schedule_id" uuid NOT NULL,
	"period_key" text NOT NULL,
	"status" "allowance_run_status" NOT NULL,
	"amount_minor" integer NOT NULL,
	"transaction_id" uuid,
	"error_code" text,
	"attempts" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "allowance_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"child_member_id" uuid NOT NULL,
	"amount_minor" integer NOT NULL,
	"spend_basis_points" integer NOT NULL,
	"weekday" integer NOT NULL,
	"time_zone" text NOT NULL,
	"status" "allowance_status" DEFAULT 'active' NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"retry_at" timestamp with time zone,
	"created_by_member_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "allowance_schedules_ranges" CHECK ("allowance_schedules"."amount_minor" > 0 and "allowance_schedules"."amount_minor" <= 1000000 and "allowance_schedules"."spend_basis_points" between 0 and 10000 and "allowance_schedules"."weekday" between 0 and 6)
);
--> statement-breakpoint
CREATE TABLE "card_controls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"frozen" boolean DEFAULT false NOT NULL,
	"daily_limit_minor" integer DEFAULT 5000 NOT NULL,
	"online" boolean DEFAULT true NOT NULL,
	"atm" boolean DEFAULT false NOT NULL,
	"in_app" boolean DEFAULT true NOT NULL,
	"provider" text DEFAULT 'sandbox' NOT NULL,
	"provider_status" text DEFAULT 'applied' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_controls_limit_range" CHECK ("card_controls"."daily_limit_minor" >= 0 and "card_controls"."daily_limit_minor" <= 100000)
);
--> statement-breakpoint
CREATE TABLE "provider_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"family_id" uuid,
	"type" text NOT NULL,
	"payload" jsonb,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "savings_goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"owner_member_id" uuid NOT NULL,
	"title" text NOT NULL,
	"target_minor" integer NOT NULL,
	"target_date" date,
	"status" "goal_status" DEFAULT 'active' NOT NULL,
	"created_by_member_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "savings_goals_target_range" CHECK ("savings_goals"."target_minor" > 0 and "savings_goals"."target_minor" <= 1000000)
);
--> statement-breakpoint
CREATE TABLE "spend_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"requester_member_id" uuid NOT NULL,
	"title" text NOT NULL,
	"reason" text,
	"amount_minor" integer NOT NULL,
	"status" "spend_request_status" DEFAULT 'pending' NOT NULL,
	"approval_id" uuid,
	"decided_by_member_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spend_requests_amount_range" CHECK ("spend_requests"."amount_minor" > 0 and "spend_requests"."amount_minor" <= 1000000)
);
--> statement-breakpoint
ALTER TABLE "allowance_runs" ADD CONSTRAINT "allowance_runs_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allowance_runs" ADD CONSTRAINT "allowance_runs_schedule_id_allowance_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."allowance_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allowance_runs" ADD CONSTRAINT "allowance_runs_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allowance_schedules" ADD CONSTRAINT "allowance_schedules_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allowance_schedules" ADD CONSTRAINT "allowance_schedules_child_member_id_family_members_id_fk" FOREIGN KEY ("child_member_id") REFERENCES "public"."family_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allowance_schedules" ADD CONSTRAINT "allowance_schedules_created_by_member_id_family_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."family_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_controls" ADD CONSTRAINT "card_controls_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_controls" ADD CONSTRAINT "card_controls_member_id_family_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."family_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_events" ADD CONSTRAINT "provider_events_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_goals" ADD CONSTRAINT "savings_goals_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_goals" ADD CONSTRAINT "savings_goals_owner_member_id_family_members_id_fk" FOREIGN KEY ("owner_member_id") REFERENCES "public"."family_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_goals" ADD CONSTRAINT "savings_goals_created_by_member_id_family_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."family_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_requests" ADD CONSTRAINT "spend_requests_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_requests" ADD CONSTRAINT "spend_requests_requester_member_id_family_members_id_fk" FOREIGN KEY ("requester_member_id") REFERENCES "public"."family_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_requests" ADD CONSTRAINT "spend_requests_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_requests" ADD CONSTRAINT "spend_requests_decided_by_member_id_family_members_id_fk" FOREIGN KEY ("decided_by_member_id") REFERENCES "public"."family_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "allowance_runs_period_key" ON "allowance_runs" USING btree ("schedule_id","period_key");--> statement-breakpoint
CREATE UNIQUE INDEX "allowance_schedules_child_key" ON "allowance_schedules" USING btree ("child_member_id");--> statement-breakpoint
CREATE INDEX "allowance_schedules_due_idx" ON "allowance_schedules" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "card_controls_member_key" ON "card_controls" USING btree ("member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_events_provider_event_key" ON "provider_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE INDEX "savings_goals_owner_idx" ON "savings_goals" USING btree ("owner_member_id");--> statement-breakpoint
CREATE INDEX "spend_requests_requester_idx" ON "spend_requests" USING btree ("requester_member_id");