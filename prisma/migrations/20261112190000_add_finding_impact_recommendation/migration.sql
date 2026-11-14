-- Concise finding fields for developer-facing review rendering.
-- Nullable so existing rows and older model outputs remain valid.
ALTER TABLE "findings" ADD COLUMN "impact" TEXT;
ALTER TABLE "findings" ADD COLUMN "recommendation" TEXT;
ALTER TABLE "findings" ADD COLUMN "guideline" TEXT;
