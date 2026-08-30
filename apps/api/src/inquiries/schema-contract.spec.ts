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
  const schema = readFileSync(
    join(import.meta.dirname, '..', 'schema.gql'),
    'utf8',
  );

  /**
   * The body of one named type, so a field can be asserted to be ON it.
   *
   * The first version of this test took a type name and then ignored it,
   * asserting only that the string appeared somewhere in the file -- so a
   * field moved to an unrelated type would have kept it green, which is
   * close to the only failure worth catching here. Throws rather than
   * returning empty on a missing type: an absent block would otherwise make
   * every field assertion for it fail with "does not contain", pointing at
   * the field instead of at the type that vanished.
   */
  function typeBlock(name: string): string {
    const match = new RegExp(
      `^(?:type|input|enum) ${name} \\{$([\\s\\S]*?)^\\}$`,
      'm',
    ).exec(schema);
    if (!match) throw new Error(`${name} is not declared in schema.gql`);
    return match[1];
  }

  it.each([
    ['CreateInquiryInput', 'idempotencyKey: String!'],
    ['CreateInquiryInput', 'buyerPhone: String!'],
    ['CreateInquiryInput', 'productId: ID!'],
    ['Product', 'hasInquiryContact: Boolean!'],
    ['Mutation', 'createInquiry(input: CreateInquiryInput!): Inquiry!'],
  ])('%s exposes %s', (type, field) => {
    expect(typeBlock(type)).toContain(field);
  });

  it('never exposes the seller WhatsApp number', () => {
    // hasInquiryContact is a boolean precisely so a scraper cannot harvest
    // seller numbers; a field slipping into the schema would undo that
    // silently, and the delivery change makes the number more valuable to
    // harvest, not less.
    //
    // Checked against the WHOLE file rather than one type: the point is that
    // the number is on no type at all.
    expect(schema.toLowerCase()).not.toContain('whatsappnumber');
  });

  it('does not publish the delivery state machine at all', () => {
    // Registering InquiryStatus as a GraphQL enum published PENDING/SENT/
    // FAILED through introspection for a field that reported a real delivery
    // outcome to an anonymous caller. Both are gone.
    expect(schema).not.toContain('enum InquiryStatus');
    expect(schema).not.toContain('status: InquiryStatus');
  });

  it('still claims no delivery to the BUYER, though delivery now happens', () => {
    // Rows reach SENT and FAILED as of this change, and a seller's phone
    // actually rings -- but none of that is exposed yet. Reporting the
    // outcome is its own change, because the confirmation copy is where three
    // separate review rounds on the unsplit version went wrong. Until then
    // the buyer is told their inquiry was recorded, which stays true either
    // way.
    expect(schema).not.toContain('delivered');
  });

  it('returns nothing from the mutation but an id and a time', () => {
    // The mutation is unauthenticated, so every field on Inquiry is readable
    // by whoever called it. Asserted on the full field list rather than by
    // naming forbidden ones, because the risk is a field nobody thought of.
    expect(
      typeBlock('Inquiry')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    ).toEqual(['createdAt: DateTime!', 'id: ID!']);
  });
});
