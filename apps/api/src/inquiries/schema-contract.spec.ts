import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The committed schema.gql must match what the resolvers actually expose.
 *
 * Nest generates it at BOOT, not at build, so adding a `@Field()` and running
 * `pnpm build` leaves the checked-in file stale and everything still passes.
 * That happened: `idempotencyKey` became required on the DTO and the web
 * client always sent it, while schema.gql omitted it entirely -- so any
 * tooling or deployment consuming the committed schema would have rejected
 * the client's own input.
 *
 * Asserted as text rather than by importing the schema, because importing it
 * would regenerate it and the staleness is exactly what needs catching.
 */
describe('committed GraphQL schema', () => {
  const schema = readFileSync(join(__dirname, '..', 'schema.gql'), 'utf8');

  it.each([
    ['CreateInquiryInput', 'idempotencyKey: String!'],
    ['CreateInquiryInput', 'buyerPhone: String!'],
    ['Product', 'hasInquiryContact: Boolean!'],
  ])('%s exposes %s', (_type, field) => {
    expect(schema).toContain(field);
  });

  it('never exposes the seller WhatsApp number', () => {
    // hasInquiryContact is a boolean precisely so a scraper cannot harvest
    // seller numbers; a field slipping into the schema would undo that
    // silently, and the delivery change makes the number more valuable to
    // harvest, not less.
    expect(schema.toLowerCase()).not.toContain('whatsappnumber');
  });

  it('claims no delivery, because nothing delivers yet', () => {
    // A `delivered` boolean here would be hardwired false. The web
    // confirmation reads off what the API actually knows, so an always-false
    // field is worse than an absent one: it invites copy that pretends to
    // report an outcome nothing produced.
    expect(schema).not.toContain('delivered');
  });
});
