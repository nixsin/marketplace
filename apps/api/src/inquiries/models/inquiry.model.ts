import { Field, ID, ObjectType } from '@nestjs/graphql';

// InquiryStatus is deliberately NOT registered as a GraphQL enum. Nothing
// public exposes it, and registering it would publish the delivery state
// machine -- PENDING, SENT, FAILED -- through introspection for a field that
// no longer exists.

/**
 * What a buyer gets back after submitting an inquiry.
 *
 * Deliberately narrow. It carries no seller identity, no seller contact
 * details, and no echo of the buyer's own message. The mutation is
 * unauthenticated, so everything returned here is readable by whoever called
 * it -- and a response that included the seller's number would turn this
 * endpoint into a contact-harvesting API, which is exactly what #91 story 6
 * exists to prevent.
 *
 * `status` is NOT exposed, and that is the correction that made the rest of
 * this honest. It was here from the capture change, where it was harmless
 * because every row was PENDING and the field said nothing. Delivery turned it
 * into a real outcome -- SENT, FAILED -- still handed to an unauthenticated
 * caller, so this type reported delivery while the change claimed not to, and
 * anyone could probe whether a given seller is currently reachable.
 *
 * Reporting delivery to the buyer is its own change, because the confirmation
 * copy is the single highest-risk part of this feature: three separate review
 * rounds on the unsplit version were about copy claiming more than the API
 * knew. When it lands it adds `delivered` -- one deliberate field, meaning
 * "the provider accepted it" and nothing more -- rather than leaking the
 * internal state machine.
 *
 * Until then the buyer is told their inquiry was recorded, which stays true
 * whether or not the send succeeded. Under-claiming is the safe direction.
 */
@ObjectType()
export class Inquiry {
  @Field(() => ID)
  id: string;

  @Field()
  createdAt: Date;
}
