-- Three-step so this is safe against a table that already has rows.
-- Prisma's generated version added the column NOT NULL with no default and
-- refused to run, correctly: there is no sensible static default for a
-- bundle id.
--
-- Backfilling each existing row with its OWN id is not a placeholder, it is
-- the honest value: every inquiry that existed before bundles was a single
-- product asked about on its own, which is exactly a bundle of one.

-- 1. Add it nullable so existing rows survive.
ALTER TABLE "Inquiry" ADD COLUMN "bundleId" TEXT;

-- 2. Each pre-existing inquiry becomes its own bundle.
UPDATE "Inquiry" SET "bundleId" = "id" WHERE "bundleId" IS NULL;

-- 3. Now it can be required.
ALTER TABLE "Inquiry" ALTER COLUMN "bundleId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "Inquiry_bundleId_idx" ON "Inquiry"("bundleId");
