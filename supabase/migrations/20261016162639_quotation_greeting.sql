-- BizCost: a quotation's greeting as typed (M3 Step 7, the owner's document requests of 2026-10-16;
-- generated); null prints the business's language's own («السادة / <name>،», "Dear <name>,"). A sent
-- revision keeps it with the rest of its row (guard_quotation compares whole rows).
ALTER TABLE "app"."quotations" ADD COLUMN "greeting" text;--> statement-breakpoint
ALTER TABLE "app"."quotations" ADD CONSTRAINT "quotations_greeting_check" CHECK (btrim(greeting) <> '' and char_length(greeting) <= 200);