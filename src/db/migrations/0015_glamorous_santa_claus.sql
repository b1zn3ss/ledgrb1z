CREATE TABLE "transaction_classification_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"household_id" text NOT NULL,
	"transaction_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"transaction_split_id" text,
	"category_id" text,
	"source" text NOT NULL,
	"rule_id" text,
	"merchant_id" text,
	"decision_priority" integer NOT NULL,
	"outcome" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"engine_version" text NOT NULL,
	"fingerprint" text NOT NULL,
	"decided_at" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "classification_decision_subject_check" CHECK (
      ("transaction_classification_decisions"."subject_type" = 'transaction' AND "transaction_classification_decisions"."transaction_split_id" IS NULL)
      OR ("transaction_classification_decisions"."subject_type" = 'split' AND "transaction_classification_decisions"."transaction_split_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "transaction_classification_decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transaction_splits" ADD COLUMN "classification_decision_id" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "classification_decision_id" text;--> statement-breakpoint
ALTER TABLE "transaction_classification_decisions" ADD CONSTRAINT "transaction_classification_decisions_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_classification_decisions" ADD CONSTRAINT "transaction_classification_decisions_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_classification_decisions_household_transaction" ON "transaction_classification_decisions" USING btree ("household_id","transaction_id","recorded_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_classification_decision_transaction_fingerprint" ON "transaction_classification_decisions" USING btree ("household_id","transaction_id","fingerprint") WHERE "transaction_classification_decisions"."subject_type" = 'transaction' AND "transaction_classification_decisions"."transaction_split_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_classification_decision_split_fingerprint" ON "transaction_classification_decisions" USING btree ("household_id","transaction_id","transaction_split_id","fingerprint") WHERE "transaction_classification_decisions"."subject_type" = 'split' AND "transaction_classification_decisions"."transaction_split_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "transaction_splits" ADD CONSTRAINT "transaction_splits_classification_decision_id_transaction_classification_decisions_id_fk" FOREIGN KEY ("classification_decision_id") REFERENCES "public"."transaction_classification_decisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_classification_decision_id_transaction_classification_decisions_id_fk" FOREIGN KEY ("classification_decision_id") REFERENCES "public"."transaction_classification_decisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Fail closed rather than snapshotting a category owned by another household.
-- Historical assignments are preserved verbatim; an operator must investigate
-- any pre-existing ownership violation before retrying this migration.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "transactions" t
		JOIN "categories" c ON c."id" = t."category_id"
		WHERE c."household_id" <> t."household_id"
		UNION ALL
		SELECT 1
		FROM "transaction_splits" s
		JOIN "transactions" t ON t."id" = s."transaction_id"
		JOIN "categories" c ON c."id" = s."category_id"
		WHERE c."household_id" <> t."household_id"
	) THEN
		RAISE EXCEPTION 'legacy classification category/household mismatch';
	END IF;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
-- Backfill only the classification state that is observable at migration time.
-- decided_at stays NULL because updated_at is not reliable historical evidence.
INSERT INTO "transaction_classification_decisions" (
	"id", "household_id", "transaction_id", "subject_type", "category_id",
	"source", "decision_priority", "outcome", "evidence", "engine_version",
	"fingerprint", "decided_at"
)
SELECT
	'legacy-txn:' || t."id", t."household_id", t."id", 'transaction', t."category_id",
	CASE WHEN t."category_source" IN ('manual','rule','merchant_default','pfc','ai','ai_low_confidence')
		THEN t."category_source" ELSE 'legacy_unknown' END,
	CASE t."category_source"
		WHEN 'manual' THEN 400 WHEN 'rule' THEN 300 WHEN 'merchant_default' THEN 200
		WHEN 'pfc' THEN 100 ELSE 0 END,
	'legacy_snapshot',
	jsonb_build_object(
		'version', 1,
		'kind', 'legacy',
		'category', CASE WHEN t."category_id" IS NULL THEN NULL ELSE
			jsonb_build_object('id', t."category_id", 'name', c."name") END,
		'observedCategorySource', t."category_source",
		'historicalDecisionTimeKnown', false
	),
	'legacy-observed-v1', 'legacy-v1:transaction:' || t."id", NULL
FROM "transactions" t
LEFT JOIN "categories" c
	ON c."id" = t."category_id" AND c."household_id" = t."household_id"
WHERE t."category_id" IS NOT NULL
	OR (t."category_source" IS NOT NULL AND NOT (
		t."category_source" = 'manual' AND EXISTS (
			SELECT 1 FROM "transaction_splits" s WHERE s."transaction_id" = t."id"
		)
	));--> statement-breakpoint
UPDATE "transactions" t
SET "classification_decision_id" = 'legacy-txn:' || t."id"
WHERE EXISTS (
	SELECT 1 FROM "transaction_classification_decisions" d
	WHERE d."id" = 'legacy-txn:' || t."id"
);--> statement-breakpoint
INSERT INTO "transaction_classification_decisions" (
	"id", "household_id", "transaction_id", "subject_type", "transaction_split_id",
	"category_id", "source", "decision_priority", "outcome", "evidence",
	"engine_version", "fingerprint", "decided_at"
)
SELECT
	'legacy-split:' || s."id", t."household_id", t."id", 'split', s."id",
	s."category_id", 'manual', 400, 'legacy_snapshot',
	jsonb_build_object(
		'version', 1,
		'kind', 'legacy',
		'category', jsonb_build_object('id', s."category_id", 'name', c."name"),
		'observedCategorySource', 'manual',
		'historicalDecisionTimeKnown', false
	),
	'legacy-observed-v1', 'legacy-v1:split:' || s."id", NULL
FROM "transaction_splits" s
JOIN "transactions" t ON t."id" = s."transaction_id"
JOIN "categories" c ON c."id" = s."category_id" AND c."household_id" = t."household_id";--> statement-breakpoint
UPDATE "transaction_splits" s
SET "classification_decision_id" = 'legacy-split:' || s."id";--> statement-breakpoint
ALTER TABLE "transaction_classification_decisions"
	ADD CONSTRAINT "classification_decision_source_check"
	CHECK ("source" IN ('manual','rule','merchant_default','pfc','ai','ai_low_confidence','legacy_unknown'));--> statement-breakpoint
ALTER TABLE "transaction_classification_decisions"
	ADD CONSTRAINT "classification_decision_outcome_check"
	CHECK ("outcome" IN ('applied','inherited','legacy_snapshot','inheritance_limited'));--> statement-breakpoint
CREATE FUNCTION validate_classification_decision_insert() RETURNS trigger AS $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM transactions t
		WHERE t.id = NEW.transaction_id AND t.household_id = NEW.household_id
	) THEN
		RAISE EXCEPTION 'classification decision transaction/household mismatch';
	END IF;
	IF NEW.subject_type = 'split' AND NOT EXISTS (
		SELECT 1 FROM transaction_splits s
		WHERE s.id = NEW.transaction_split_id AND s.transaction_id = NEW.transaction_id
	) THEN
		RAISE EXCEPTION 'classification decision split/transaction mismatch';
	END IF;
	IF NEW.category_id IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM categories c
		WHERE c.id = NEW.category_id AND c.household_id = NEW.household_id
	) THEN
		RAISE EXCEPTION 'classification decision category/household mismatch';
	END IF;
	IF NEW.rule_id IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM category_rules r
		WHERE r.id = NEW.rule_id AND r.household_id = NEW.household_id
			AND r.category_id = NEW.category_id
	) THEN
		RAISE EXCEPTION 'classification decision rule/household mismatch';
	END IF;
	IF NEW.merchant_id IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM merchants m
		WHERE m.id = NEW.merchant_id AND m.household_id = NEW.household_id
			AND m.category_id = NEW.category_id
	) THEN
		RAISE EXCEPTION 'classification decision merchant/household mismatch';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER validate_classification_decision_insert_trigger
BEFORE INSERT ON "transaction_classification_decisions"
FOR EACH ROW EXECUTE FUNCTION validate_classification_decision_insert();--> statement-breakpoint
CREATE FUNCTION guard_classification_decision_history() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'UPDATE' THEN
		RAISE EXCEPTION 'classification decision history is immutable';
	END IF;
	-- Direct deletion is prohibited. FK cascades from hard transaction or
	-- household deletion are the only supported history deletion path.
	IF TG_OP = 'DELETE' AND pg_trigger_depth() <= 1 THEN
		RAISE EXCEPTION 'classification decision history is append-only';
	END IF;
	RETURN OLD;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER guard_classification_decision_history_trigger
BEFORE UPDATE OR DELETE ON "transaction_classification_decisions"
FOR EACH ROW EXECUTE FUNCTION guard_classification_decision_history();--> statement-breakpoint
CREATE FUNCTION validate_transaction_classification_pointer() RETURNS trigger AS $$
BEGIN
	IF NEW.classification_decision_id IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM transaction_classification_decisions d
		WHERE d.id = NEW.classification_decision_id
			AND d.transaction_id = NEW.id
			AND d.household_id = NEW.household_id
			AND d.subject_type = 'transaction'
			AND d.transaction_split_id IS NULL
	) THEN
		RAISE EXCEPTION 'invalid transaction classification decision pointer';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER validate_transaction_classification_pointer_trigger
BEFORE INSERT OR UPDATE OF "classification_decision_id", "household_id", "id" ON "transactions"
FOR EACH ROW EXECUTE FUNCTION validate_transaction_classification_pointer();--> statement-breakpoint
CREATE FUNCTION validate_split_classification_pointer() RETURNS trigger AS $$
BEGIN
	IF NEW.classification_decision_id IS NOT NULL AND NOT EXISTS (
		SELECT 1
		FROM transaction_classification_decisions d
		JOIN transactions t ON t.id = NEW.transaction_id
		WHERE d.id = NEW.classification_decision_id
			AND d.transaction_id = NEW.transaction_id
			AND d.household_id = t.household_id
			AND d.subject_type = 'split'
			AND d.transaction_split_id = NEW.id
	) THEN
		RAISE EXCEPTION 'invalid split classification decision pointer';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER validate_split_classification_pointer_trigger
BEFORE INSERT OR UPDATE OF "classification_decision_id", "transaction_id", "id" ON "transaction_splits"
FOR EACH ROW EXECUTE FUNCTION validate_split_classification_pointer();--> statement-breakpoint
CREATE POLICY "household_isolation" ON "transaction_classification_decisions" AS PERMISSIVE FOR ALL TO public USING (household_id = current_setting('app.household_id', true)) WITH CHECK (household_id = current_setting('app.household_id', true));
