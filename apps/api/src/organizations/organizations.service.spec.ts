import { NotFoundException } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { PrismaService } from '../prisma/prisma.service';

describe('OrganizationsService', () => {
  let service: OrganizationsService;
  let prisma: {
    organization: { create: jest.Mock; findUnique: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      organization: { create: jest.fn(), findUnique: jest.fn() },
    };
    service = new OrganizationsService(prisma as unknown as PrismaService);
  });

  describe('create', () => {
    it('delegates to prisma.organization.create with the given input', async () => {
      const input = {
        name: 'Apollo Diagnostics',
        type: 'BUYER' as const,
      };
      const created = { id: 'org_1', ...input };
      prisma.organization.create.mockResolvedValue(created);

      const result = await service.create(input);

      expect(prisma.organization.create).toHaveBeenCalledWith({
        data: input,
      });
      expect(result).toBe(created);
    });
  });

  describe('findById', () => {
    it('returns the organization when found', async () => {
      const org = { id: 'org_1', name: 'Apollo Diagnostics' };
      prisma.organization.findUnique.mockResolvedValue(org);

      const result = await service.findById('org_1');

      expect(prisma.organization.findUnique).toHaveBeenCalledWith({
        where: { id: 'org_1' },
      });
      expect(result).toBe(org);
    });

    it('throws NotFoundException when no organization matches', async () => {
      prisma.organization.findUnique.mockResolvedValue(null);

      await expect(service.findById('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
