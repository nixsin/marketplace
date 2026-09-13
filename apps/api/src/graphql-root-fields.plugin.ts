import { ROOT_FIELDS_KEY, rootFieldNames } from './graphql-cache';

/**
 * Records which SCHEMA fields an operation resolves, for the cache-policy
 * decision in app.setup.ts.
 *
 * WHY A PLUGIN AND NOT THE RESPONSE BODY, which is where this started:
 * the serialised `data` object is keyed by ALIAS, not by schema field, so
 * `{ product: productsPaged(...) }` lands under `data.product`. Reading
 * the body therefore let a caller alias a listing into the stale-tolerant
 * policy -- the exact bypass the strict policy exists to prevent, and the
 * reverse works too. The parsed operation keeps `name` and `alias` as
 * separate nodes, so it is the only place the real field is knowable.
 *
 * `didResolveOperation` rather than an earlier hook: it runs after parse
 * and validation, so the document is well-formed and the operation
 * actually selected (a document may define several) has been picked.
 *
 * DELIBERATELY NOT TYPED AS `ApolloServerPlugin`, and this is not
 * laziness. @apollo/server publishes both ESM and CJS type declarations,
 * whose `HeaderMap` each carry a private `__identity` field -- so the two
 * are NOMINALLY incompatible and annotating with the type this file
 * resolves fails to satisfy the one ApolloDriverConfig resolves:
 *
 *   Types have separate declarations of a private property '__identity'.
 *
 * Structural typing at the registration site is what actually matters,
 * and the local interfaces below pin the shape this code depends on
 * without importing either copy.
 */

/** The slice of graphql's AST this needs. */
interface RootSelectionNode {
  kind: string;
  name?: { value?: string };
}

/** What app.module's own `context` factory builds. */
interface GraphqlContext {
  req?: Record<string, unknown>;
}

interface DidResolveOperationArgs {
  operation?: { selectionSet?: { selections?: readonly RootSelectionNode[] } };
  contextValue?: GraphqlContext;
}

export const graphqlRootFieldsPlugin = {
  requestDidStart() {
    return Promise.resolve({
      didResolveOperation({
        operation,
        contextValue,
      }: DidResolveOperationArgs) {
        const req = contextValue?.req;
        if (!req) return Promise.resolve();
        // Null when the fields cannot be known from the selection set
        // alone -- a root fragment spread, say. Stored as-is rather than
        // coerced to an empty array: cachePolicyFor treats both as strict,
        // and collapsing them would hide which case occurred.
        req[ROOT_FIELDS_KEY] = rootFieldNames(
          operation?.selectionSet?.selections,
        );
        return Promise.resolve();
      },
    });
  },
};
