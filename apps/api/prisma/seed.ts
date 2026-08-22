import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import type { DeviceClass } from '../generated/prisma/enums';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

// This dataset is a TEST FIXTURE as much as a demo catalogue. The browser
// suite asserts against it, so the products below deliberately exercise
// every conditional branch the UI has -- a missing image, an absent device
// class, an empty certifications array, a very long name, a very long and a
// very short description, many badges, special characters, a non-Latin
// script, an unbreakable token, and every seller KYC state. Each is also a
// plausible listing, so the demo catalogue does not read as a test harness.
//
// ORDER AND IDENTITY ARE FROZEN ON PURPOSE. findPaged sorts by
// [createdAt desc, id desc]. Before this, every product shared one createdAt
// (a single createMany) and every id was a cuid() -- so page composition
// rested entirely on cuid v1 happening to embed a monotonic counter. That is
// an accident, not a guarantee: cuid2 is random, and the day Prisma's
// default changes, pages reshuffle on every reseed and the visual baselines
// fail for no code reason. Explicit ids and distinct, descending timestamps
// make the intended order actually do the ordering.
interface SeedProduct {
  id: string;
  name: string;
  brand: string;
  category: string;
  deviceClass?: DeviceClass;
  certifications: string[];
  location: string;
  description: string;
  // Nullable: a real listing may carry no photo, and the card renders a
  // different layout without one.
  imageUrl: string | null;
  // Category-specific specs. Absent on most; the detail page has a distinct
  // empty state for that, and a nested value exercises its stringify path.
  // Typed as real JSON rather than `unknown` -- Prisma's Json column takes
  // InputJsonValue, which `unknown` is not assignable to.
  details?: Record<string, JsonValue>;
  // Which seeded seller owns it -- lets one product exercise a KYC state or
  // a missing GSTIN without duplicating the whole catalogue.
  seller?: 'approved' | 'pending' | 'unverified';
}

type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

// Fixed instant, so reseeding never changes ordering or page composition.
const SEED_EPOCH = new Date('2026-01-01T00:00:00.000Z');

const IMG = {
  imaging: '/products/diagnostic-imaging.svg',
  monitoring: '/products/patient-monitoring.svg',
  surgical: '/products/surgical-instruments.svg',
  lab: '/products/lab-equipment.svg',
  disposables: '/products/disposables.svg',
};

const products: SeedProduct[] = [
  {
    id: 'seed-product-01',
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
    id: 'seed-product-02',
    // SCENARIO: very long name. Wrapping in the card <h2> and the detail
    // page heading. Long names are ordinary in this category.
    name: 'Portable Ultrasound Scanner — US-Pro 7 with Phased-Array, Linear and Convex Probe Bundle (Cardiac / Vascular / Abdominal Imaging)',
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
    id: 'seed-product-03',
    name: 'Multi-Parameter Patient Monitor — VS-500',
    brand: 'MedTech Systems',
    category: 'Patient Monitoring',
    deviceClass: 'B',
    certifications: ['CDSCO Registered'],
    location: 'Chennai, TN',
    // SCENARIO: no image. The card drops its entire image column.
    imageUrl: null,
    description:
      'Bedside monitor tracking ECG, SpO2, NIBP, respiration, and temperature on a single 12-inch color display, with configurable high/low alarm thresholds per parameter. Trend data is stored locally for 72 hours and can be exported via USB for chart review. Suited for general wards, step-down units, and pre-/post-operative recovery bays. Wall-mount and trolley mount both included.',
  },
  {
    id: 'seed-product-04',
    name: 'Surgical Electrocautery Unit — ES-100',
    brand: 'MedTech Systems',
    category: 'Surgical Instruments',
    // SCENARIO: no certifications and no device class together.
    certifications: [],
    location: 'Chennai, TN',
    imageUrl: IMG.surgical,
    description:
      'A monopolar/bipolar electrosurgical generator with adjustable cut and coagulation power (up to 300W), an isolated patient return-electrode monitoring circuit, and audible tone feedback for mode changes. Footswitch and handswitch pencils included. Built for general surgery and minor OT procedures where a full integrated OT tower isn’t required.',
  },
  {
    id: 'seed-product-05',
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
    id: 'seed-product-06',
    name: 'Anesthesia Workstation — AW-Elite',
    brand: 'MedTech Systems',
    category: 'Surgical Instruments',
    deviceClass: 'D',
    // SCENARIO: many certifications. Badge-row wrapping.
    certifications: [
      'ISO 13485',
      'CDSCO Registered',
      'CE Marked',
      'FDA 510(k)',
      'IEC 60601-1',
      'RoHS Compliant',
    ],
    location: 'Chennai, TN',
    imageUrl: IMG.surgical,
    description:
      'A fully integrated anesthesia delivery system with electronic gas mixing, an integrated ventilator supporting volume- and pressure-controlled modes, and continuous agent/O2/CO2 monitoring on a single touchscreen. Includes a backup mechanical bag-valve mode for power-loss scenarios. Installation requires a certified biomedical engineer—arranged as part of delivery.',
  },
  {
    id: 'seed-product-07',
    // SCENARIO: quotes, slashes, parens, ampersand and an em-dash in one
    // name. Exercises escaping end to end.
    name: 'Digital Otoscope — DO-Mini 6" S/S 316L (Reusable & Autoclavable)',
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
    id: 'seed-product-08',
    // SCENARIO: non-Latin script. Font fallback, line height, wrapping --
    // and realistic for this market, doubly covered on /hi.
    name: 'इन्फ्यूजन पंप — IP-200 (सिरिंज एवं वॉल्यूमेट्रिक)',
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
    id: 'seed-product-09',
    name: 'Surgical Nitrile Gloves (Box of 100)',
    brand: 'MedTech Systems',
    category: 'Disposables & Consumables',
    certifications: ['ISO 13485'],
    location: 'Chennai, TN',
    imageUrl: IMG.disposables,
    // SCENARIO: very short description. Minimum card height, and how it
    // aligns beside a tall neighbour.
    description: 'Powder-free nitrile, size S–XL. Box of 100.',
  },
  {
    id: 'seed-product-10',
    // SCENARIO: a long unbreakable token. The classic horizontal-overflow
    // bug -- pairs with the mobile overflow assertion.
    name: 'Biochemistry Analyzer — BC-500 / PN-BC500-XR-2026-REV-C-ASSY-001122334455',
    brand: 'MedTech Systems',
    category: 'Lab Equipment',
    deviceClass: 'B',
    certifications: ['ISO 13485', 'CDSCO Registered'],
    location: 'Chennai, TN',
    imageUrl: IMG.lab,
    description:
      'A semi-automated clinical chemistry analyzer supporting 40+ common assay parameters (liver panel, renal panel, lipid profile, glucose) with a reagent-open architecture, meaning it isn’t locked to a single reagent vendor. Throughput of 200 tests/hour, onboard QC, and LIS connectivity via RS-232.',
  },
  {
    id: 'seed-product-11',
    // SCENARIO: rich `details` JSON. The detail page's spec table.
    name: 'Autoclave Steriliser — AC-80L',
    brand: 'MedTech Systems',
    category: 'Lab Equipment',
    deviceClass: 'B',
    certifications: ['ISO 13485', 'CE Marked'],
    location: 'Pune, MH',
    imageUrl: IMG.lab,
    details: {
      'Chamber Volume': '80 L',
      'Cycle Time': '18 minutes',
      'Max Temperature': '134 °C',
      'Power Rating': '3.5 kW',
    },
    description:
      'A front-loading steam steriliser sized for a mid-volume clinic or dental practice, with pre-programmed cycles for wrapped instruments, unwrapped instruments and liquids. Prints a cycle log for audit records.',
  },
  {
    id: 'seed-product-12',
    // SCENARIO: nested object inside `details`. Exercises the detail page's
    // JSON.stringify fallback -- without it this renders "[object Object]".
    name: 'Ventilator — VT-900 ICU',
    brand: 'MedTech Systems',
    category: 'Patient Monitoring',
    deviceClass: 'D',
    certifications: ['ISO 13485', 'CDSCO Registered', 'CE Marked'],
    location: 'Bengaluru, KA',
    imageUrl: IMG.monitoring,
    details: {
      Modes: ['SIMV', 'PRVC', 'CPAP'],
      'Tidal Volume': { min: '20 mL', max: '2000 mL' },
      'Battery Backup': '4 hours',
    },
    description:
      'An ICU ventilator supporting invasive and non-invasive modes with integrated graphics for pressure, flow and volume waveforms.',
  },
  {
    id: 'seed-product-13',
    // SCENARIO: very long seller and location strings. Meta-line truncation.
    name: 'Examination Couch — EC-3 Hydraulic',
    brand:
      'Sri Venkateswara Surgical & Hospital Equipment Manufacturing Co. (India) Private Limited',
    category: 'Surgical Instruments',
    certifications: ['ISO 13485'],
    location: 'Thiruvananthapuram District, Kerala, India',
    imageUrl: IMG.surgical,
    description:
      'A three-section hydraulic examination couch with foot-pedal height adjustment and a removable headrest.',
  },
  {
    id: 'seed-product-14',
    // SCENARIO: seller awaiting KYC. The detail page's `warning` badge
    // variant -- only `success` was ever seeded before.
    name: 'Pulse Oximeter — PO-50 Fingertip',
    brand: 'Coastal Medical Devices',
    category: 'Patient Monitoring',
    deviceClass: 'A',
    certifications: ['CDSCO Registered'],
    location: 'Kochi, KL',
    imageUrl: IMG.monitoring,
    seller: 'pending',
    description:
      'A fingertip pulse oximeter with OLED display, reporting SpO2 and pulse rate with a plethysmograph trace.',
  },
  {
    id: 'seed-product-15',
    // SCENARIO: seller with no GSTIN and a rejected KYC. Exercises both the
    // absent-GSTIN branch and the `destructive` badge variant.
    name: 'Nebuliser — NB-10 Compressor',
    brand: 'Northline Traders',
    category: 'Disposables & Consumables',
    certifications: [],
    location: 'Ludhiana, PB',
    imageUrl: null,
    seller: 'unverified',
    description:
      'A compressor nebuliser supplied with adult and paediatric masks, a mouthpiece and a spare filter set.',
  },
  {
    id: 'seed-product-16',
    name: 'Surgical Headlight — SL-2 LED',
    brand: 'MedTech Systems',
    category: 'Surgical Instruments',
    deviceClass: 'A',
    certifications: ['ISO 13485', 'CE Marked'],
    location: 'Chennai, TN',
    imageUrl: IMG.surgical,
    description:
      'A rechargeable LED surgical headlight with adjustable spot size and a belt-mounted battery pack rated for a full operating list.',
  },
];

async function main() {
  // Three sellers, not one: the detail page renders a different KYC badge
  // variant per status and hides the GSTIN line when absent, and only the
  // APPROVED-with-GSTIN path was ever seeded. Upserted by a stable key so
  // reseeding is idempotent.
  const approved = await prisma.organization.upsert({
    where: { gstin: '33AAACM1234A1Z5' },
    // Set in BOTH branches on purpose: `update: {}` means an already-seeded
    // row would never gain a newly added column, so a reseed on an existing
    // database would silently leave this seller unable to receive inquiries.
    update: { whatsappNumber: '+919876500001' },
    create: {
      name: 'MedTech Systems Pvt Ltd',
      gstin: '33AAACM1234A1Z5',
      type: 'SELLER',
      kycStatus: 'APPROVED',
      whatsappNumber: '+919876500001',
    },
  });
  const pending = await prisma.organization.upsert({
    where: { gstin: '32AABCC5678D1Z9' },
    update: { whatsappNumber: '+919876500002' },
    create: {
      name: 'Coastal Medical Devices',
      gstin: '32AABCC5678D1Z9',
      type: 'SELLER',
      kycStatus: 'PENDING',
      whatsappNumber: '+919876500002',
    },
  });
  // No GSTIN: the detail page must omit that line entirely rather than
  // render an empty one. Also deliberately has NO whatsappNumber, so the
  // fixture exercises canReceiveInquiries === false -- the inquiry form must
  // be absent entirely rather than present and always failing (#91).
  const unverified = await prisma.organization.upsert({
    where: { gstin: '03ZZZZZ0000Z1Z0' },
    update: {},
    create: {
      name: 'Northline Traders',
      gstin: '03ZZZZZ0000Z1Z0',
      type: 'SELLER',
      kycStatus: 'REJECTED',
    },
  });
  const sellers = { approved, pending, unverified };

  // Reseed cleanly so schema/content changes always apply, rather than
  // being skipped by a "does it already exist" check.
  await prisma.product.deleteMany({
    where: { sellerId: { in: Object.values(sellers).map((o) => o.id) } },
  });
  await prisma.product.createMany({
    // One minute apart, descending, so array order IS page order under
    // findPaged's [createdAt desc, id desc]. Without distinct timestamps
    // every row ties on createdAt and the sort falls through to id -- which
    // only ever worked because cuid v1 embeds a monotonic counter.
    data: products.map(({ seller, ...p }, index) => ({
      ...p,
      sellerId: sellers[seller ?? 'approved'].id,
      createdAt: new Date(SEED_EPOCH.getTime() - index * 60_000),
    })),
  });

  console.log(
    `Seeded: ${Object.keys(sellers).length} sellers, ${products.length} products`,
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
