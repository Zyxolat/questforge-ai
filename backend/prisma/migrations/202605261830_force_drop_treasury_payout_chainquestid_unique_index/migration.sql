ALTER TABLE "TreasuryPayout"
DROP CONSTRAINT IF EXISTS "TreasuryPayout_chainQuestId_key";

DO $$
DECLARE
  treasury_index RECORD;
BEGIN
  FOR treasury_index IN
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'TreasuryPayout'
      AND indexdef ILIKE 'CREATE UNIQUE INDEX%'
      AND indexdef ILIKE '%("chainQuestId")%'
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I', treasury_index.indexname);
  END LOOP;
END $$;
