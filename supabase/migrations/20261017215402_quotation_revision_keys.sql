-- BizCost: a quotation's revisions count n + 1 over the live ones (M3 Step 7 review, D-296; generated):
-- a discarded draft revision's count is used again, so revision 1 is followed by revision 2 even after a
-- revision 2 draft was discarded. The two keys hold among the live revisions only.
ALTER TABLE "app"."quotations" DROP CONSTRAINT "quotations_seq_key";--> statement-breakpoint
ALTER TABLE "app"."quotations" DROP CONSTRAINT "quotations_revision_key";--> statement-breakpoint
CREATE UNIQUE INDEX "quotations_seq_key" ON "app"."quotations" USING btree ("business_id","seq","revision") WHERE deleted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "quotations_revision_key" ON "app"."quotations" USING btree ("business_id","root_id","revision") WHERE deleted_at is null;
