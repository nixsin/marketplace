-- Purely additive: a nullable column and an index. Safe against existing rows.
--
-- Hashed, never the raw IP. The per-phone rate limit is keyed on a value the
-- caller types, so rotating E.164 numbers defeated it entirely -- on an
-- unauthenticated endpoint that sends outbound WhatsApp messages, that made
-- the limits decorative. This adds a dimension the caller does not choose.
--
-- A raw IP would be personal data under DPDP sitting in a table operators read
-- to triage leads. A hash still counts repeats, which is all the limiter needs.
ALTER TABLE "Inquiry" ADD COLUMN "ipHash" TEXT;

-- CreateIndex
CREATE INDEX "Inquiry_ipHash_createdAt_idx" ON "Inquiry"("ipHash", "createdAt");
