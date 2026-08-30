import { Reflector } from '@nestjs/core';
import { Roles, ROLES_KEY } from './roles.decorator';

/**
 * The decorator RolesGuard reads. Its own spec covers the guard's decision;
 * this covers the other half of that contract -- that the metadata is
 * written under the key the guard looks up, with the roles it was given.
 * The two are only useful together, and a rename on either side would
 * otherwise fail open: no metadata reads as no restriction.
 */
describe('Roles', () => {
  it('writes the roles under the key the guard reads', () => {
    class Target {
      @Roles('ADMIN')
      adminOnly(this: void) {}
    }

    expect(new Reflector().get(ROLES_KEY, Target.prototype.adminOnly)).toEqual([
      'ADMIN',
    ]);
  });

  it('carries every role it was given, in order', () => {
    class Target {
      @Roles('ADMIN', 'STAFF')
      either(this: void) {}
    }

    expect(new Reflector().get(ROLES_KEY, Target.prototype.either)).toEqual([
      'ADMIN',
      'STAFF',
    ]);
  });
});
