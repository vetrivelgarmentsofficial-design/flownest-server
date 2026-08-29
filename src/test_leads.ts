import db from './config/db';
import { runWithTenantContext, runBypassingTenant } from './utils/tenant-context';
import { getLeadsList } from './modules/leads/leads.service';

async function test() {
  console.log('Fetching client info...');
  try {
    let client: any = null;
    
    // Read client with bypass
    await runBypassingTenant(async () => {
      client = await db.client.findUnique({
        where: { id: 'a03a5f02-dd5b-4b5d-bda3-f9a10443ee12' }
      });
    });

    if (!client) {
      console.error('Client a03a5f02-dd5b-4b5d-bda3-f9a10443ee12 not found in DB!');
      return;
    }

    console.log(`Found client businessName="${client.businessName}", agencyId="${client.agencyId}"`);

    console.log('Testing leads fetching under agency context...');
    await runWithTenantContext({ agencyId: client.agencyId }, async () => {
      try {
        const res = await getLeadsList({ clientId: 'a03a5f02-dd5b-4b5d-bda3-f9a10443ee12' }, 1, 100);
        console.log('Success!', res.leads.length, 'leads fetched.');
      } catch (err: any) {
        console.error('FAILED inside tenant context:', err);
      }
    });
  } catch (err: any) {
    console.error('Root test failure:', err);
  } finally {
    await db.$disconnect();
  }
}

test();
