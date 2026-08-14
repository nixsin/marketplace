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
  description: string;
  imageUrl: string;
}

const IMG = {
  imaging: '/products/diagnostic-imaging.svg',
  monitoring: '/products/patient-monitoring.svg',
  surgical: '/products/surgical-instruments.svg',
  lab: '/products/lab-equipment.svg',
  disposables: '/products/disposables.svg',
};

const products: SeedProduct[] = [
  {
    name: 'Portable Digital X-Ray Machine — DR-200',
    brand: 'MedTech Systems',
    category: 'Diagnostic Imaging',
    deviceClass: 'C',
    certifications: ['ISO 13485', 'CDSCO Registered'],
    location: 'Chennai, TN',
    imageUrl: IMG.imaging,
    description:
      'A lightweight, trolley-mounted digital radiography unit built for wards, ICUs, and rural outreach camps where patients can’t easily be moved to a fixed imaging suite. The flat-panel detector delivers diagnostic-quality images in under 8 seconds, with dose output tuned for pediatric and adult exposure presets. Battery runtime supports a full day of bedside rounds between charges, and the collapsible arm folds down for transport in a standard ambulance. Includes a 1-year on-site warranty and operator training at installation.',
  },
  {
    name: 'Portable Ultrasound Scanner — US-Pro 7',
    brand: 'MedTech Systems',
    category: 'Diagnostic Imaging',
    deviceClass: 'B',
    certifications: ['ISO 13485', 'CE Marked'],
    location: 'Chennai, TN',
    imageUrl: IMG.imaging,
    description:
      'A handheld point-of-care ultrasound system with a 7-inch daylight-readable display, supporting abdominal, cardiac, and musculoskeletal presets out of the box. Convex and linear probe options are sold separately. Designed for OPD and emergency triage settings where a full radiology-department cart isn’t practical. DICOM export over Wi-Fi, 4-hour battery life, and a wipeable housing rated for standard hospital disinfectants.',
  },
  {
    name: 'Multi-Parameter Patient Monitor — VS-500',
    brand: 'MedTech Systems',
    category: 'Patient Monitoring',
    deviceClass: 'B',
    certifications: ['CDSCO Registered'],
    location: 'Chennai, TN',
    imageUrl: IMG.monitoring,
    description:
      'Bedside monitor tracking ECG, SpO2, NIBP, respiration, and temperature on a single 12-inch color display, with configurable high/low alarm thresholds per parameter. Trend data is stored locally for 72 hours and can be exported via USB for chart review. Suited for general wards, step-down units, and pre-/post-operative recovery bays. Wall-mount and trolley mount both included.',
  },
  {
    name: 'Surgical Electrocautery Unit — ES-100',
    brand: 'MedTech Systems',
    category: 'Surgical Instruments',
    deviceClass: 'C',
    certifications: ['ISO 13485', 'CDSCO Registered'],
    location: 'Chennai, TN',
    imageUrl: IMG.surgical,
    description:
      'A monopolar/bipolar electrosurgical generator with adjustable cut and coagulation power (up to 300W), an isolated patient return-electrode monitoring circuit, and audible tone feedback for mode changes. Footswitch and handswitch pencils included. Built for general surgery and minor OT procedures where a full integrated OT tower isn’t required.',
  },
  {
    name: 'Automated Hematology Analyzer — HA-3D',
    brand: 'MedTech Systems',
    category: 'Lab Equipment',
    deviceClass: 'B',
    certifications: ['ISO 13485'],
    location: 'Chennai, TN',
    imageUrl: IMG.lab,
    description:
      '3-part differential hematology analyzer processing up to 60 samples/hour from a 20µL whole-blood aspiration. Reports the standard CBC panel plus a 3-part WBC differential, with onboard QC tracking (Levey-Jennings charts) and a built-in thermal printer. Sized for a diagnostic lab bench, not a hospital-scale core lab.',
  },
  {
    name: 'Anesthesia Workstation — AW-Elite',
    brand: 'MedTech Systems',
    category: 'Surgical Instruments',
    deviceClass: 'D',
    certifications: ['ISO 13485', 'CDSCO Registered', 'CE Marked'],
    location: 'Chennai, TN',
    imageUrl: IMG.surgical,
    description:
      'A fully integrated anesthesia delivery system with electronic gas mixing, an integrated ventilator supporting volume- and pressure-controlled modes, and continuous agent/O2/CO2 monitoring on a single touchscreen. Includes a backup mechanical bag-valve mode for power-loss scenarios. Installation requires a certified biomedical engineer—arranged as part of delivery.',
  },
  {
    name: 'Digital Otoscope — DO-Mini',
    brand: 'MedTech Systems',
    category: 'Diagnostic Imaging',
    deviceClass: 'A',
    certifications: ['CDSCO Registered'],
    location: 'Chennai, TN',
    imageUrl: IMG.imaging,
    description:
      'A pocket-sized digital otoscope with a built-in camera and LED illumination, streaming live view to a paired tablet or laptop over USB-C. Useful for OPD ENT screening and telemedicine consults where a still or video capture needs to go into the patient record. Disposable speculum tips sold separately in packs of 100.',
  },
  {
    name: 'Infusion Pump — IP-200',
    brand: 'MedTech Systems',
    category: 'Patient Monitoring',
    deviceClass: 'C',
    certifications: ['ISO 13485', 'CDSCO Registered'],
    location: 'Chennai, TN',
    imageUrl: IMG.monitoring,
    description:
      'A volumetric infusion pump with a pre-loaded drug library covering common IV medications and dose-rate limits, free-flow protection on door release, and a 6-hour internal battery for patient transport between wards. Occlusion and air-in-line alarms are configurable per ward protocol.',
  },
  {
    name: 'Surgical Nitrile Gloves (Box of 100)',
    brand: 'MedTech Systems',
    category: 'Disposables & Consumables',
    certifications: ['ISO 13485'],
    location: 'Chennai, TN',
    imageUrl: IMG.disposables,
    description:
      'Powder-free, textured-grip nitrile examination gloves in a sterile-packed box of 100, available in sizes S–XL. AQL 1.5, latex-free — suited for staff with latex sensitivity as well as general ward and procedure-room use. Sold by the case (10 boxes) or individually for smaller clinics.',
  },
  {
    name: 'Biochemistry Analyzer — BC-500',
    brand: 'MedTech Systems',
    category: 'Lab Equipment',
    deviceClass: 'B',
    certifications: ['ISO 13485', 'CDSCO Registered'],
    location: 'Chennai, TN',
    imageUrl: IMG.lab,
    description:
      'A semi-automated clinical chemistry analyzer supporting 40+ common assay parameters (liver panel, renal panel, lipid profile, glucose) with a reagent-open architecture, meaning it isn’t locked to a single reagent vendor. Throughput of 200 tests/hour, onboard QC, and LIS connectivity via RS-232.',
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

  // Reseed cleanly so schema/content changes (description, imageUrl) always
  // apply, rather than being skipped by a "does it already exist" check.
  await prisma.product.deleteMany({ where: { sellerId: seller.id } });
  await prisma.product.createMany({
    data: products.map((p) => ({ ...p, sellerId: seller.id })),
  });

  console.log(
    `Seeded: seller=${seller.name}, products=${products.length}`,
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
