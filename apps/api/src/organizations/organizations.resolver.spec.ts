// `jest` is not a global under ESM -- Jest injects describe/it/expect but
// not the jest object itself, so it has to be imported explicitly.
import { jest } from '@jest/globals';
import { OrganizationsResolver } from './organizations.resolver';
import { OrganizationsService } from './organizations.service';
import type { AuthTokenPayload } from '../auth/types/auth-token-payload';

describe('OrganizationsResolver', () => {
  let resolver: OrganizationsResolver;
  let mockOrganizationsService: { findById: jest.Mock };

  beforeEach(() => {
    mockOrganizationsService = { findById: jest.fn() };
    resolver = new OrganizationsResolver(
      mockOrganizationsService as unknown as OrganizationsService,
    );
  });

  it("looks up the organization by the caller's orgId, not their user id (sub)", async () => {
    const expectedOrg = { id: 'org-1', name: 'Acme', kycStatus: 'VERIFIED' };
    mockOrganizationsService.findById.mockResolvedValue(expectedOrg);
    const user: AuthTokenPayload = {
      sub: 'user-1',
      orgId: 'org-1',
      role: 'ADMIN',
    };

    const result = await resolver.myOrganization(user);

    expect(mockOrganizationsService.findById).toHaveBeenCalledWith('org-1');
    expect(mockOrganizationsService.findById).not.toHaveBeenCalledWith(
      'user-1',
    );
    expect(result).toBe(expectedOrg);
  });
});
