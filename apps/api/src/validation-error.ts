import { BadRequestException, ValidationError } from '@nestjs/common';

/**
 * Turns class-validator's findings into an error that says what is wrong.
 *
 * WITHOUT THIS, EVERY DTO REJECTION IS THE STRING "Bad Request Exception".
 * Verified on the wire, not assumed: a malformed phone number produced
 * `{ message: "Bad Request Exception", extensions: { code: "BAD_USER_INPUT" } }`
 * and nothing else. The constraint that failed, and the field it failed on,
 * were both discarded.
 *
 * That matters for two separate reasons.
 *
 * The buyer's reason: `apps/web` picks its error copy from the message, so an
 * edge rejection was indistinguishable from any other failure and landed on
 * the generic "something went wrong" copy — for the one class of error the
 * buyer can actually act on. Moving validation to the edge without fixing this
 * would have traded a fast rejection for a useless one.
 *
 * The operator's reason: a 400 that names no field is a support ticket.
 *
 * The messages are SAFE TO EXPOSE HERE because they describe the caller's own
 * input against a schema GraphQL already publishes through introspection. That
 * is not general licence — if a DTO ever validates something whose shape is not
 * public, this needs a whitelist rather than a join.
 */
export function validationException(
  errors: ValidationError[],
): BadRequestException {
  return new BadRequestException(flattenConstraints(errors).join(' '));
}

/**
 * Every constraint message, including nested ones.
 *
 * Nested DTOs report through `children`, so a flat read of `constraints`
 * returns an empty list for them — an error that says nothing at all, which is
 * the state this function exists to end.
 */
function flattenConstraints(errors: ValidationError[]): string[] {
  const messages: string[] = [];
  for (const error of errors) {
    if (error.constraints) messages.push(...Object.values(error.constraints));
    if (error.children?.length) {
      messages.push(...flattenConstraints(error.children));
    }
  }
  return messages;
}
