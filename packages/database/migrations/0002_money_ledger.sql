CREATE TYPE "public"."account_purpose" AS ENUM('family_wallet', 'external_funding', 'spend', 'save');--> statement-breakpoint
CREATE TYPE "public"."entry_direction" AS ENUM('debit', 'credit');--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"direction" "entry_direction" NOT NULL,
	"amount_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_amount_positive" CHECK ("ledger_entries"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"command_id" uuid,
	"created_by_member_id" uuid,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "money_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"owner_member_id" uuid,
	"purpose" "account_purpose" NOT NULL,
	"currency" text DEFAULT 'AUD' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_money_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."money_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_created_by_member_id_family_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."family_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_accounts" ADD CONSTRAINT "money_accounts_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_accounts" ADD CONSTRAINT "money_accounts_owner_member_id_family_members_id_fk" FOREIGN KEY ("owner_member_id") REFERENCES "public"."family_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_entries_account_idx" ON "ledger_entries" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_transaction_idx" ON "ledger_entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_transactions_idempotency_key" ON "ledger_transactions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "ledger_transactions_family_created_idx" ON "ledger_transactions" USING btree ("family_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "money_accounts_family_purpose_key" ON "money_accounts" USING btree ("family_id","purpose") WHERE "money_accounts"."owner_member_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "money_accounts_member_purpose_key" ON "money_accounts" USING btree ("family_id","owner_member_id","purpose") WHERE "money_accounts"."owner_member_id" is not null;