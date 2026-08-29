import prisma from '../../config/db';
import { registerAgency, verifyAgencyEmail, resendVerificationEmail } from './register.service';
import { runBypassingTenant } from '../../utils/tenant-context';
import bcrypt from 'bcrypt';

async function runTests() {
  console.log('🧪 Starting SaaS Onboarding Verification Test Suite...\n');

  const testEmail = `test-agency-${Date.now()}@FlowNest-test.com`;
  const testPassword = 'testpassword123';
  const testAgencyName = 'Test Marketing Inc.';

  let createdAgencyId = '';

  try {
    // --- Test 1: Register Agency & Admin Account ---
    console.log('⏳ Running Test 1: Register Agency...');
    const regResult = await registerAgency(testAgencyName, testEmail, testPassword);
    
    createdAgencyId = regResult.agencyId;

    console.log('✅ Test 1 Success:');
    console.log(`   - Agency ID: ${regResult.agencyId}`);
    console.log(`   - Admin ID:  ${regResult.adminId}`);
    
    // Retrieve record directly to verify parameters
    const agencyRecord = await runBypassingTenant(async () => 
      await prisma.agency.findUnique({ where: { id: regResult.agencyId } })
    );

    if (!agencyRecord) throw new Error('Agency record not found in database after registration');
    
    // Validate trial durations (45 days)
    const diffTime = new Date(agencyRecord.trialEndDate!).getTime() - new Date(agencyRecord.trialStartDate!).getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    if (diffDays !== 45) {
      throw new Error(`Invalid trial duration. Expected 45 days, got ${diffDays} days.`);
    }
    console.log(`   - Trial Duration verified: ${diffDays} days`);

    if (agencyRecord.emailVerified !== false) {
      throw new Error('Agency emailVerified should initially be false');
    }
    console.log('   - emailVerified initially false verified');

    if (!agencyRecord.verificationToken) {
      throw new Error('Verification token not generated');
    }
    console.log('   - verificationToken generation verified');

    // Verify Admin User profile & password hashing
    const userRecord = await runBypassingTenant(async () =>
      await prisma.user.findUnique({ where: { id: regResult.adminId } })
    );

    if (!userRecord) throw new Error('User record not found in database');
    const isPasswordHashed = await bcrypt.compare(testPassword, userRecord.passwordHash);
    if (!isPasswordHashed) throw new Error('Password hash comparison failed');
    console.log('   - Admin password hashing verified');


    // --- Test 2: Prevent Duplicate Registrations ---
    console.log('\n⏳ Running Test 2: Prevent Duplicate Registrations...');
    try {
      await registerAgency('Another Agency', testEmail, 'differentpass');
      throw new Error('Registration should have thrown a duplicate agency error');
    } catch (err: any) {
      if (err.message.includes('already exists')) {
        console.log('✅ Test 2 Success: Duplicate registration rejected correctly');
      } else {
        throw err;
      }
    }


    // --- Test 3: Resend Verification Email ---
    console.log('\n⏳ Running Test 3: Resend Verification Token...');
    const originalToken = agencyRecord.verificationToken;
    const resendResult = await resendVerificationEmail(testEmail);
    
    if (!resendResult.success) throw new Error('Resend verification service returned false');

    const updatedAgency = await runBypassingTenant(async () =>
      await prisma.agency.findUnique({ where: { id: regResult.agencyId } })
    );

    if (updatedAgency!.verificationToken === originalToken) {
      throw new Error('Verification token was not rotated on resend');
    }
    console.log('✅ Test 3 Success: Verification token rotated on resend request');


    // --- Test 4: Verify Email Callback ---
    console.log('\n⏳ Running Test 4: Verify Email Callbacks...');
    const tokenToVerify = updatedAgency!.verificationToken!;
    const verifyResult = await verifyAgencyEmail(tokenToVerify);

    if (!verifyResult.emailVerified) {
      throw new Error('Agency emailVerified remains false after callback execution');
    }
    if (verifyResult.verificationToken !== null) {
      throw new Error('Verification token should be cleared after verification');
    }
    console.log('✅ Test 4 Success: Email successfully verified');


    // --- Test 5: Verify Login Guard ---
    console.log('\n⏳ Running Test 5: Verify Login Guard (Verified Email)...');
    const { loginUser } = await import('./auth.service');
    const authData = await loginUser(testEmail, testPassword);
    
    if (!authData.accessToken) throw new Error('Failed to login verified user');
    console.log('✅ Test 5 Success: Verified user successfully logged in');

  } catch (error: any) {
    console.error('\n❌ Onboarding Test Suite Failed:', error.message);
    process.exitCode = 1;
  } finally {
    // --- Clean Up ---
    console.log('\n⏳ Cleaning up test database records...');
    if (createdAgencyId) {
      await runBypassingTenant(async () => {
        // This cascade-deletes the users and refresh tokens because of foreign keys
        await prisma.agency.delete({
          where: { id: createdAgencyId },
        }).catch(() => {});
      });
      console.log('🧹 Cleaned up test Agency & User accounts.');
    }
    console.log('\n🏁 Onboarding Verification Tests Completed.');
    await prisma.$disconnect();
  }
}

// Run test suite
runTests();
