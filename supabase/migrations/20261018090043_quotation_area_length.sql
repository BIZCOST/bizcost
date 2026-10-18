-- BizCost: an area's name is at most 40 characters (the owner's round of 2026-10-18, D-299; generated):
-- the PDF writes it up the side of its lines, smaller and on two lines when it is long.
ALTER TABLE "app"."quotation_lines" DROP CONSTRAINT "quotation_lines_area_check";--> statement-breakpoint
ALTER TABLE "app"."quotation_lines" ADD CONSTRAINT "quotation_lines_area_check" CHECK (btrim(area) <> '' and char_length(area) <= 40);