import { CurrentUser } from './current-user.decorator';

/**
 * The param decorator that hands a resolver the authenticated user.
 *
 * `createParamDecorator` returns the decorator, not the extractor, so the
 * function that actually runs per request is only reachable through Nest's
 * own metadata -- which is why it read as uncovered while the decorator
 * itself was "used". Pulled out and invoked directly here: the extraction
 * is the part that can be wrong, and getting it wrong means a resolver
 * silently receives undefined instead of the caller.
 */
describe('CurrentUser', () => {
  /**
   * The factory Nest stores behind the decorator. Reached via the same
   * metadata key Nest uses; if a future version changes that key this
   * throws rather than silently testing nothing.
   */
  function extractor() {
    const decorated = CurrentUser();
    class Target {
      // The parameter exists only to give the decorator an argument
      // position to decorate; nothing ever reads it.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      method(this: void, _user: unknown) {}
    }
    decorated(Target.prototype, 'method', 0);

    const params = Reflect.getMetadata(
      '__routeArguments__',
      Target,
      'method',
    ) as Record<string, { factory: (data: unknown, ctx: unknown) => unknown }>;
    const entry = Object.values(params ?? {})[0];
    if (!entry?.factory) {
      throw new Error('could not reach the CurrentUser factory via metadata');
    }
    return entry.factory;
  }

  /** A GraphQL execution context carrying `req`, which is what Nest passes. */
  function gqlContext(req: unknown) {
    return {
      getType: () => 'graphql',
      getArgs: () => [undefined, undefined, { req }, undefined],
      getArgByIndex: (i: number) =>
        [undefined, undefined, { req }, undefined][i],
      getHandler: () => undefined,
      getClass: () => undefined,
    };
  }

  it('returns the user attached to the request', () => {
    const user = { sub: 'u1', orgId: 'o1', role: 'ADMIN' };

    expect(extractor()(undefined, gqlContext({ user }))).toBe(user);
  });

  it('returns undefined when the request carries no user', () => {
    // Reached when a resolver forgets its guard. Returning undefined
    // rather than throwing is what lets the guard own that decision --
    // but a resolver must not mistake it for an authenticated caller.
    expect(extractor()(undefined, gqlContext({}))).toBeUndefined();
  });
});
