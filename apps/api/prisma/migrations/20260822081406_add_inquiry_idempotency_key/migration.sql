-- Additive and nullable, so existing rows survive untouched.
--
-- A lost response is indistinguishable from a failed one, so without this a
-- retry creates a second inquiry AND sends the seller a second WhatsApp
-- message. The client supplies one key per submission and reuses it across
-- retries; the unique index is what actually stops the duplicate, rather than
-- trusting the client to notice.
--
-- Nullable rather than backfilled: rows written before this had no key, and
-- in Postgres NULLs do not collide in a unique index, so they coexist without
-- inventing identifiers that never identified anything.
ALTER TABLE "Inquiry" ADD COLUMN "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Inquiry_idempotencyKey_key" ON "Inquiry"("idempotencyKey");
