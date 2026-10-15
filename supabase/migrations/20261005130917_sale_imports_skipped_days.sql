-- BizCost: the days an import left out when it was finalized because another import already had
-- them (overlap "skip", M3 Step 4; drizzle-kit generated, then commented), so the import still says
-- which of its days were not posted once its staged rows are cleared.
ALTER TABLE "app"."sale_imports" ADD COLUMN "skipped_days" date[];