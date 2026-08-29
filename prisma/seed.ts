import { PrismaClient, UserRole, AgencyPlan } from '@prisma/client';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

async function main() {
  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@growphil.com';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'admin123';
  const clientEmail = 'client@company.com';
  const clientPassword = 'client123';
  const superEmail = 'superadmin@growphil.com';

  console.log('[Seed] Seeding initial agency, client, and user accounts...');

  const passwordHashAdmin = await bcrypt.hash(adminPassword, 10);
  const passwordHashClient = await bcrypt.hash(clientPassword, 10);
  const passwordHashSuper = await bcrypt.hash(adminPassword, 10);

  // 1. Create default Agency
  const agency = await prisma.agency.upsert({
    where: { email: 'agency@growphil.com' },
    update: {
      emailVerified: true,
      subscriptionStatus: 'ACTIVE',
      subscriptionPlan: 'PROFESSIONAL',
    },
    create: {
      name: 'GrowPhil Marketing Agency',
      email: 'agency@growphil.com',
      plan: AgencyPlan.pro,
      isActive: true,
      emailVerified: true,
      emailVerifiedAt: new Date(),
      subscriptionStatus: 'ACTIVE',
      subscriptionPlan: 'PROFESSIONAL',
      trialStartDate: new Date(),
      trialEndDate: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000),
      isTrialExpired: false,
    },
  });

  // 2. Create default Agency Admin (admin@growphil.com) linked to Agency
  const agencyAdmin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {
      role: UserRole.agency_admin,
      agencyId: agency.id,
      passwordHash: passwordHashAdmin,
    },
    create: {
      email: adminEmail,
      role: UserRole.agency_admin,
      agencyId: agency.id,
      passwordHash: passwordHashAdmin,
    },
  });

  // 3. Create default Client linked to Agency
  const client = await prisma.client.upsert({
    where: { email: 'info@company.com' },
    update: {},
    create: {
      agencyId: agency.id,
      businessName: 'Acme Corporates',
      email: 'info@company.com',
      metaAdSpend: 15000.00,
    },
  });

  // 4. Create default Client Owner (client@company.com) linked to Client and Agency
  const clientOwner = await prisma.user.upsert({
    where: { email: clientEmail },
    update: {
      role: UserRole.client_owner,
      agencyId: agency.id,
      clientId: client.id,
      passwordHash: passwordHashClient,
    },
    create: {
      email: clientEmail,
      role: UserRole.client_owner,
      agencyId: agency.id,
      clientId: client.id,
      passwordHash: passwordHashClient,
    },
  });

  // 5. Create default Super Admin (superadmin@growphil.com)
  const superAdmin = await prisma.user.upsert({
    where: { email: superEmail },
    update: {
      role: UserRole.super_admin,
      passwordHash: passwordHashSuper,
    },
    create: {
      email: superEmail,
      role: UserRole.super_admin,
      passwordHash: passwordHashSuper,
    },
  });

  console.log(`[Seed] Successfully seeded database:`);
  console.log(`  - Agency: ${agency.name} (${agency.id})`);
  console.log(`  - Agency Admin: ${agencyAdmin.email} (password: ${adminPassword})`);
  console.log(`  - Client: ${client.businessName} (${client.id})`);
  console.log(`  - Client Owner: ${clientOwner.email} (password: ${clientPassword})`);
  console.log(`  - Super Admin: ${superAdmin.email} (password: ${adminPassword})`);
}

main()
  .catch((e) => {
    console.error('[Seed Error] Failed to run database seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
