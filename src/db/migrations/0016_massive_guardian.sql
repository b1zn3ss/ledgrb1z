CREATE TABLE "merchant_aliases" (
	"id" text PRIMARY KEY NOT NULL,
	"household_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"provider" text,
	"normalized_alias" text NOT NULL,
	"normalization_version" integer NOT NULL,
	"source" text NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "merchant_aliases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "merchant_identifiers" (
	"id" text PRIMARY KEY NOT NULL,
	"household_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"provider" text NOT NULL,
	"identifier_type" text NOT NULL,
	"identifier_hash" text NOT NULL,
	"source" text NOT NULL,
	"confidence" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "merchant_identifiers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "transaction_merchant_identity_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"household_id" text NOT NULL,
	"transaction_id" text NOT NULL,
	"merchant_id" text,
	"source" text NOT NULL,
	"outcome" text NOT NULL,
	"identifier_id" text,
	"alias_id" text,
	"decision_priority" integer NOT NULL,
	"evidence" jsonb NOT NULL,
	"engine_version" text NOT NULL,
	"previous_decision_id" text,
	"fingerprint" text NOT NULL,
	"decided_at" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_identity_decision_semantics_check" CHECK ((
        ("transaction_merchant_identity_decisions"."source" = 'manual'
          AND "transaction_merchant_identity_decisions"."evidence"->>'kind' = 'manual'
          AND (("transaction_merchant_identity_decisions"."outcome" = 'assigned' AND "transaction_merchant_identity_decisions"."merchant_id" IS NOT NULL)
            OR ("transaction_merchant_identity_decisions"."outcome" = 'cleared' AND "transaction_merchant_identity_decisions"."merchant_id" IS NULL)))
        OR ("transaction_merchant_identity_decisions"."source" IN ('provider_merchant', 'provider_counterparty')
          AND "transaction_merchant_identity_decisions"."evidence"->>'kind' = 'provider'
          AND "transaction_merchant_identity_decisions"."outcome" = 'assigned'
          AND "transaction_merchant_identity_decisions"."merchant_id" IS NOT NULL)
        OR ("transaction_merchant_identity_decisions"."source" = 'approved_alias'
          AND "transaction_merchant_identity_decisions"."evidence"->>'kind' = 'alias'
          AND "transaction_merchant_identity_decisions"."outcome" = 'assigned'
          AND "transaction_merchant_identity_decisions"."merchant_id" IS NOT NULL)
        OR ("transaction_merchant_identity_decisions"."source" = 'verified_canonical_name'
          AND "transaction_merchant_identity_decisions"."evidence"->>'kind' = 'canonical_name'
          AND "transaction_merchant_identity_decisions"."outcome" = 'assigned'
          AND "transaction_merchant_identity_decisions"."merchant_id" IS NOT NULL)
        OR ("transaction_merchant_identity_decisions"."source" IN ('manual', 'pending_inheritance')
          AND "transaction_merchant_identity_decisions"."evidence"->>'kind' = 'inheritance'
          AND "transaction_merchant_identity_decisions"."outcome" = 'inherited')
        OR ("transaction_merchant_identity_decisions"."source" = 'legacy_unknown'
          AND "transaction_merchant_identity_decisions"."evidence"->>'kind' = 'legacy'
          AND "transaction_merchant_identity_decisions"."outcome" IN ('legacy_snapshot', 'conflict_preserved')
          AND "transaction_merchant_identity_decisions"."merchant_id" IS NOT NULL)
        OR ("transaction_merchant_identity_decisions"."source" = 'legacy_unknown'
          AND "transaction_merchant_identity_decisions"."evidence"->>'kind' = 'unresolved'
          AND "transaction_merchant_identity_decisions"."outcome" IN ('unresolved', 'ambiguous')
          AND "transaction_merchant_identity_decisions"."merchant_id" IS NULL)
      ))
);
--> statement-breakpoint
ALTER TABLE "transaction_merchant_identity_decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "identity_status" text DEFAULT 'legacy_unverified' NOT NULL;--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "category_default_approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "merchant_identity_decision_id" text;--> statement-breakpoint
ALTER TABLE "merchant_aliases" ADD CONSTRAINT "merchant_aliases_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_aliases" ADD CONSTRAINT "merchant_aliases_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_identifiers" ADD CONSTRAINT "merchant_identifiers_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_identifiers" ADD CONSTRAINT "merchant_identifiers_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_merchant_identity_decisions" ADD CONSTRAINT "transaction_merchant_identity_decisions_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_merchant_identity_decisions" ADD CONSTRAINT "transaction_merchant_identity_decisions_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_active_global_merchant_alias" ON "merchant_aliases" USING btree ("household_id","normalization_version","normalized_alias") WHERE "merchant_aliases"."provider" IS NULL AND "merchant_aliases"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_active_provider_merchant_alias" ON "merchant_aliases" USING btree ("household_id","provider","normalization_version","normalized_alias") WHERE "merchant_aliases"."provider" IS NOT NULL AND "merchant_aliases"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_merchant_aliases_household_merchant" ON "merchant_aliases" USING btree ("household_id","merchant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_active_merchant_identifier" ON "merchant_identifiers" USING btree ("household_id","provider","identifier_type","identifier_hash") WHERE "merchant_identifiers"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_merchant_identifiers_household_merchant" ON "merchant_identifiers" USING btree ("household_id","merchant_id");--> statement-breakpoint
CREATE INDEX "idx_merchant_identity_decisions_household_transaction" ON "transaction_merchant_identity_decisions" USING btree ("household_id","transaction_id","recorded_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_merchant_identity_decision_fingerprint" ON "transaction_merchant_identity_decisions" USING btree ("household_id","transaction_id","fingerprint");--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_merchant_identity_decision_id_transaction_merchant_identity_decisions_id_fk" FOREIGN KEY ("merchant_identity_decision_id") REFERENCES "public"."transaction_merchant_identity_decisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "household_isolation" ON "merchant_aliases" AS PERMISSIVE FOR ALL TO public USING (household_id = current_setting('app.household_id', true)) WITH CHECK (household_id = current_setting('app.household_id', true));--> statement-breakpoint
CREATE POLICY "household_isolation" ON "merchant_identifiers" AS PERMISSIVE FOR ALL TO public USING (household_id = current_setting('app.household_id', true)) WITH CHECK (household_id = current_setting('app.household_id', true));--> statement-breakpoint
CREATE POLICY "household_isolation" ON "transaction_merchant_identity_decisions" AS PERMISSIVE FOR ALL TO public USING (household_id = current_setting('app.household_id', true)) WITH CHECK (household_id = current_setting('app.household_id', true));--> statement-breakpoint
ALTER TABLE "merchants"
  ADD CONSTRAINT "merchant_identity_status_check"
  CHECK ("identity_status" IN ('legacy_unverified','provider_verified','user_verified','retired'));--> statement-breakpoint
ALTER TABLE "transaction_merchant_identity_decisions"
  ADD CONSTRAINT "merchant_identity_decision_source_check"
  CHECK ("source" IN ('manual','provider_merchant','provider_counterparty','approved_alias','verified_canonical_name','pending_inheritance','legacy_unknown'));--> statement-breakpoint
ALTER TABLE "transaction_merchant_identity_decisions"
  ADD CONSTRAINT "merchant_identity_decision_outcome_check"
  CHECK ("outcome" IN ('assigned','cleared','unresolved','ambiguous','conflict_preserved','inherited','legacy_snapshot'));--> statement-breakpoint
CREATE FUNCTION validate_merchant_registry_ownership() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM merchants m
    WHERE m.id = NEW.merchant_id AND m.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'merchant registry merchant/household mismatch';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER validate_merchant_alias_ownership_trigger
BEFORE INSERT OR UPDATE OF "household_id", "merchant_id" ON "merchant_aliases"
FOR EACH ROW EXECUTE FUNCTION validate_merchant_registry_ownership();--> statement-breakpoint
CREATE TRIGGER validate_merchant_identifier_ownership_trigger
BEFORE INSERT OR UPDATE OF "household_id", "merchant_id" ON "merchant_identifiers"
FOR EACH ROW EXECUTE FUNCTION validate_merchant_registry_ownership();--> statement-breakpoint
CREATE FUNCTION guard_merchant_alias_identity() RETURNS trigger AS $$
BEGIN
  IF OLD.household_id IS DISTINCT FROM NEW.household_id
    OR OLD.merchant_id IS DISTINCT FROM NEW.merchant_id
    OR OLD.provider IS DISTINCT FROM NEW.provider
    OR OLD.normalized_alias IS DISTINCT FROM NEW.normalized_alias
    OR OLD.normalization_version IS DISTINCT FROM NEW.normalization_version
    OR OLD.source IS DISTINCT FROM NEW.source
    OR OLD.approved_by IS DISTINCT FROM NEW.approved_by
    OR OLD.approved_at IS DISTINCT FROM NEW.approved_at
  THEN
    RAISE EXCEPTION 'merchant alias identity is immutable; revoke and insert instead';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER guard_merchant_alias_identity_trigger
BEFORE UPDATE ON "merchant_aliases"
FOR EACH ROW EXECUTE FUNCTION guard_merchant_alias_identity();--> statement-breakpoint
CREATE FUNCTION guard_merchant_identifier_identity() RETURNS trigger AS $$
BEGIN
  IF OLD.household_id IS DISTINCT FROM NEW.household_id
    OR OLD.merchant_id IS DISTINCT FROM NEW.merchant_id
    OR OLD.provider IS DISTINCT FROM NEW.provider
    OR OLD.identifier_type IS DISTINCT FROM NEW.identifier_type
    OR OLD.identifier_hash IS DISTINCT FROM NEW.identifier_hash
    OR OLD.source IS DISTINCT FROM NEW.source
  THEN
    RAISE EXCEPTION 'merchant identifier identity is immutable; revoke and insert instead';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER guard_merchant_identifier_identity_trigger
BEFORE UPDATE ON "merchant_identifiers"
FOR EACH ROW EXECUTE FUNCTION guard_merchant_identifier_identity();--> statement-breakpoint
CREATE FUNCTION validate_merchant_identity_decision_insert() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM transactions t
    WHERE t.id = NEW.transaction_id AND t.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'merchant identity decision transaction/household mismatch';
  END IF;
  IF NEW.merchant_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM merchants m
    WHERE m.id = NEW.merchant_id AND m.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'merchant identity decision merchant/household mismatch';
  END IF;
  IF NEW.previous_decision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM transaction_merchant_identity_decisions d
    WHERE d.id = NEW.previous_decision_id
      AND d.transaction_id = NEW.transaction_id
      AND d.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'merchant identity previous decision mismatch';
  END IF;
  IF NEW.identifier_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM merchant_identifiers i
    WHERE i.id = NEW.identifier_id
      AND i.household_id = NEW.household_id
      AND i.merchant_id = NEW.merchant_id
  ) THEN
    RAISE EXCEPTION 'merchant identity identifier snapshot mismatch';
  END IF;
  IF NEW.alias_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM merchant_aliases a
    WHERE a.id = NEW.alias_id
      AND a.household_id = NEW.household_id
      AND a.merchant_id = NEW.merchant_id
  ) THEN
    RAISE EXCEPTION 'merchant identity alias snapshot mismatch';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER validate_merchant_identity_decision_insert_trigger
BEFORE INSERT ON "transaction_merchant_identity_decisions"
FOR EACH ROW EXECUTE FUNCTION validate_merchant_identity_decision_insert();--> statement-breakpoint
CREATE FUNCTION guard_merchant_identity_decision_history() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'merchant identity decision history is immutable';
  END IF;
  IF TG_OP = 'DELETE' AND pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'merchant identity decision history is append-only';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER guard_merchant_identity_decision_history_trigger
BEFORE UPDATE OR DELETE ON "transaction_merchant_identity_decisions"
FOR EACH ROW EXECUTE FUNCTION guard_merchant_identity_decision_history();--> statement-breakpoint
CREATE FUNCTION validate_transaction_merchant_ownership() RETURNS trigger AS $$
BEGIN
  IF NEW.merchant_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM merchants m
    WHERE m.id = NEW.merchant_id AND m.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'transaction merchant/household mismatch';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER validate_transaction_merchant_ownership_trigger
BEFORE INSERT OR UPDATE OF "merchant_id", "household_id" ON "transactions"
FOR EACH ROW EXECUTE FUNCTION validate_transaction_merchant_ownership();--> statement-breakpoint
CREATE FUNCTION validate_transaction_merchant_identity_pointer() RETURNS trigger AS $$
BEGIN
  IF NEW.merchant_identity_decision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM transaction_merchant_identity_decisions d
    WHERE d.id = NEW.merchant_identity_decision_id
      AND d.transaction_id = NEW.id
      AND d.household_id = NEW.household_id
      AND d.merchant_id IS NOT DISTINCT FROM NEW.merchant_id
  ) THEN
    RAISE EXCEPTION 'invalid transaction merchant identity decision pointer';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER validate_transaction_merchant_identity_pointer_trigger
BEFORE INSERT OR UPDATE OF "merchant_identity_decision_id", "merchant_id", "household_id", "id" ON "transactions"
FOR EACH ROW EXECUTE FUNCTION validate_transaction_merchant_identity_pointer();
