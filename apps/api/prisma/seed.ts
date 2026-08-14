import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import type { DeviceClass } from '../generated/prisma/enums';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

interface SeedProduct {
  name: string;
  brand: string;
  category: string;
  deviceClass?: DeviceClass;
  certifications: string[];
  location: string;
}

const products: SeedProduct[] = [
  {
    name: 'Portable Digital X-Ray Machine — DR-200',
    brand: 'MedTech Systems',
    category: 'Diagnostic Imaging',
    deviceClass: 'C',
    certifications: ['ISO 13485', 'CDSCO Registered'],
    location: 'Chennai, TN',
  },
  {
    name: 'Portable Ultrasound Scanner — US-Pro 7',
    brand: 'MedTech Systems',
    category: 'Diagnostic Imaging',
    deviceClass: 'B',
    certifications: ['ISO 13485', 'CE Marked'],
    location: 'Chennai, TN',
  },
  {
    name: 'Multi-Parameter Patient Monitor — VS-500',
    brand: 'MedTech Systems',
    category: 'Patient Monitoring',
    deviceClass: 'B',
    certifications: ['CDSCO Registered'],
    location: 'Chennai, TN',
  },
  {
    name: 'Surgical Electrocautery Unit — ES-100',
    brand: 'MedTech Systems',
    category: 'Surgical Instruments',
    deviceClass: 'C',
    certifications: ['ISO 13485', 'CDSCO Registered'],
    location: 'Chennai, TN',
  },
  {
    name: 'Automated Hematology Analyzer — HA-3D',
    brand: 'MedTech Systems',
    category: 'Lab Equipment',
    deviceClass: 'B',
    certifications: ['ISO 13485'],
    location: 'Chennai, TN',
  },
  {
    name: 'Anesthesia Workstation — AW-Elite',
    brand: 'MedTech Systems',
    category: 'Surgical Instruments',
    deviceClass: 'D',
    certifications: ['ISO 13485', 'CDSCO Registered', 'CE Marked'],
    location: 'Chennai, TN',
  },
  {
    name: 'Digital Otoscope — DO-Mini',
    brand: 'MedTech Systems',
    category: 'Diagnostic Imaging',
    deviceClass: 'A',
    certifications: ['CDSCO Registered'],
    location: 'Chennai, TN',
  },
  {
    name: 'Infusion Pump — IP-200',
    brand: 'MedTech Systems',
    category: 'Patient Monitoring',
    deviceClass: 'C',
    certifications: ['ISO 13485', 'CDSCO Registered'],
    location: 'Chennai, TN',
  },
  {
    name: 'Surgical Nitrile Gloves (Box of 100)',
    brand: 'MedTech Systems',
    category: 'Disposables & Consumables',
    certifications: ['ISO 13485'],
    location: 'Chennai, TN',
  },
  {
    name: 'Biochemistry Analyzer — BC-500',
    brand: 'MedTech Systems',
    category: 'Lab Equipment',
    deviceClass: 'B',
    certifications: ['ISO 13485', 'CDSCO Registered'],
    location: 'Chennai, TN',
  },
];

async function main() {
  const seller = await prisma.organization.upsert({
    where: { gstin: '33AAACM1234A1Z5' },
    update: {},
    create: {
      name: 'MedTech Systems Pvt Ltd',
      gstin: '33AAACM1234A1Z5',
      type: 'SELLER',
      kycStatus: 'APPROVED',
    },
  });

  let created = 0;
  for (const p of products) {
    const existing = await prisma.product.findFirst({
      where: { sellerId: seller.id, name: p.name },
    });
    if (!existing) {
      await prisma.product.create({ data: { ...p, sellerId: seller.id } });
      created++;
    }
  }

  console.log(
    `Seeded: seller=${seller.name}, products created this run=${created}, total in list=${products.length}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
