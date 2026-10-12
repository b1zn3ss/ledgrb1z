CREATE TABLE "plaid_onboarding_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"household_id" text NOT NULL,
	"encrypted_public_token" text NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plaid_onboarding_attempts" ADD CONSTRAINT "plaid_onboarding_attempts_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_plaid_onboarding_attempts_household" ON "plaid_onboarding_attempts" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "idx_plaid_onboarding_attempts_status" ON "plaid_onboarding_attempts" USING btree ("status");