import bcrypt from 'bcrypt';
import * as jose from 'jose';
import prisma from '../../config/db';
import { encrypt } from '../../utils/encryption';
import { logger } from '../../utils/logger';
import { runBypassingTenant } from '../../utils/tenant-context';

/**
 * Lists all clients for a calling agency, paginated.
 */
export async function getAgencyClients(
  agencyId: string,
  page: number,
  limit: number,
  filters: { isDeleted?: boolean; includeDeleted?: boolean } = {}
) {
  const skip = (page - 1) * limit;

  const whereClause: any = { agencyId };
  if (filters.isDeleted !== undefined) {
    whereClause.isDeleted = filters.isDeleted;
  } else if (!filters.includeDeleted) {
    whereClause.isDeleted = false;
  }

  // Query database
  const [clients, total] = await Promise.all([
    prisma.client.findMany({
      where: whereClause,
      skip,
      take: limit,
      orderBy: { businessName: 'asc' },
      include: {
        _count: {
          select: { leads: true },
        },
        googleConnections: {
          select: { id: true, googleEmail: true }
        },
        spreadsheetConnections: {
          select: { id: true }
        }
      },
    }),
    prisma.client.count({
      where: whereClause,
    }),
  ]);

  return { clients, total };
}

/**
 * Creates a new client account under the agency.
 * Wraps client creation and client_owner user account creation in a single transaction.
 */
export async function createAgencyClient(
  agencyId: string,
  businessName: string,
  email: string,
  passwordPlain: string
) {
  // Check if client email already exists
  const existingClient = await prisma.client.findUnique({
    where: { email },
  });

  if (existingClient) {
    throw new Error('A client with this email address already exists');
  }

  // Hash password using bcrypt (cost 12)
  const passwordHash = await bcrypt.hash(passwordPlain, 12);

  // Wrap in transactional execution
  return prisma.$transaction(async (tx) => {
    // 1. Create client record
    const client = await tx.client.create({
      data: {
        agencyId,
        businessName,
        email,
      },
    });

    // 2. Create the client owner user
    const user = await tx.user.create({
      data: {
        clientId: client.id,
        agencyId, // link to parent agency scope
        role: 'client_owner',
        email,
        passwordHash,
      },
    });

    return { client, user };
  });
}

/**
 * Updates client details. Returns 403/Error if the client does not belong to this agency.
 */
export async function updateAgencyClient(
  agencyId: string,
  clientId: string,
  businessName?: string,
  email?: string,
  metaAdSpend?: number
) {
  return runBypassingTenant(async () => {
    // Validate client belongs to calling agency
    const client = await prisma.client.findUnique({
      where: { id: clientId },
    });

    if (!client || client.agencyId !== agencyId) {
      throw new Error('Client not found or access denied');
    }

    if (email && email !== client.email) {
      const existingClient = await prisma.client.findUnique({ where: { email } });
      const existingUser = await prisma.user.findUnique({ where: { email } });
      if (existingClient || existingUser) {
        throw new Error('A user or client with this email address already exists');
      }
    }

    return prisma.$transaction(async (tx) => {
      // 1. Sync User email if email is being updated
      if (email && email !== client.email) {
        await tx.user.updateMany({
          where: { clientId },
          data: { email },
        });
      }

      // 2. Perform client update
      return tx.client.update({
        where: { id: clientId },
        data: {
          ...(businessName && { businessName }),
          ...(email && { email }),
          ...(metaAdSpend !== undefined && { metaAdSpend }),
        },
      });
    });
  });
}

/**
 * Soft deletes a client account by removing user access, disconnects Google integrations,
 * and sets isDeleted to true. Leads are kept in database.
 */
export async function deleteAgencyClient(agencyId: string, clientId: string) {
  return runBypassingTenant(async () => {
    // 1. Verify client exists and belongs to the calling agency
    const client = await prisma.client.findUnique({
      where: { id: clientId },
    });

    if (!client || client.agencyId !== agencyId || client.isDeleted) {
      throw new Error('Client not found or access denied');
    }



    // 3. Try to revoke Google OAuth tokens if they exist (non-blocking)
    const googleConn = await prisma.googleConnection.findFirst({
      where: { clientId },
    });

    if (googleConn) {
      const tokenToRevoke = googleConn.refreshToken || googleConn.accessToken;
      if (tokenToRevoke) {
        try {
          await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokenToRevoke)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          });
        } catch (revokeErr) {
          // Ignore token revocation failure
        }
      }
    }

    // 4. Perform database updates/deletions in a transaction
    return prisma.$transaction(async (tx) => {
      // A. Delete Spreadsheet Connection related tables (Prisma doesn't cascade deletes on soft delete)
      await tx.spreadsheetImportHistory.deleteMany({ where: { clientId } });
      await tx.spreadsheetColumnMapping.deleteMany({ where: { clientId } });
      await tx.spreadsheetConnection.deleteMany({ where: { clientId } });
      await tx.googleConnection.deleteMany({ where: { clientId } });

      // B. Delete all user accounts associated with this client to revoke login access
      await tx.user.deleteMany({
        where: { clientId },
      });

      // C. Soft-delete the client itself and rename its email to avoid unique constraint conflicts
      const timestamp = Date.now();
      const newEmail = `deleted_${timestamp}_${client.email}`;
      
      return tx.client.update({
        where: { id: clientId },
        data: {
          isDeleted: true,
          email: newEmail,
          metaTokenStatus: 'DISCONNECTED',
          metaAccessToken: null,
        },
      });
    });
  });
}

/**
 * Permanently hard-deletes a client account, cascading database deletions.
 */
export async function hardDeleteAgencyClient(agencyId: string, clientId: string) {
  return runBypassingTenant(async () => {
    const client = await prisma.client.findUnique({
      where: { id: clientId },
    });

    if (!client || client.agencyId !== agencyId) {
      throw new Error('Client not found or access denied');
    }

    return prisma.client.delete({
      where: { id: clientId },
    });
  });
}


/**
 * Stores the returned Meta Access Token encrypted with connection metadata.
 */
export async function saveClientMetaToken(
  agencyId: string,
  clientId: string,
  metaAccessToken: string,
  options?: {
    metaAdAccountId?: string;
    metaPageId?: string;
    metaBusinessId?: string;
    tokenExpiresAt?: Date;
    metaTokenStatus?: string;
    metaConnectedAt?: Date;
    metaLastSyncAt?: Date;
  }
) {
  // Validate client ownership
  const client = await prisma.client.findUnique({
    where: { id: clientId },
  });

  if (!client || client.agencyId !== agencyId) {
    throw new Error('Client not found or access denied');
  }

  // Encrypt the token using AES-256-GCM
  const encryptedToken = encrypt(metaAccessToken);
  const now = new Date();

  return prisma.client.update({
    where: { id: clientId },
    data: {
      metaAccessToken: encryptedToken,
      metaAdAccountId: options?.metaAdAccountId || undefined,
      metaPageId: options?.metaPageId || undefined,
      metaBusinessId: options?.metaBusinessId || undefined,
      tokenExpiresAt: options?.tokenExpiresAt || undefined,
      metaTokenStatus: options?.metaTokenStatus || 'CONNECTED',
      metaConnectedAt: options?.metaConnectedAt || now,
      metaLastSyncAt: options?.metaLastSyncAt || now,
    },
  });
}

/**
 * Generates a signed JWT OAuth state parameter to protect against CSRF.
 * Expires in 15 minutes.
 */
async function generateOAuthState(clientId: string): Promise<string> {
  const secretStr = process.env.JWT_ACCESS_SECRET;
  if (!secretStr) throw new Error('JWT_ACCESS_SECRET is not configured.');
  const secret = new TextEncoder().encode(secretStr);
  return new jose.SignJWT({ clientId, purpose: 'meta_oauth' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(secret);
}

/**
 * Verifies the signed JWT OAuth state and returns the embedded clientId.
 * Throws if expired, tampered, or missing required fields.
 */
export async function verifyMetaOAuthState(state: string): Promise<string> {
  const secretStr = process.env.JWT_ACCESS_SECRET;
  if (!secretStr) throw new Error('JWT_ACCESS_SECRET is not configured.');
  const secret = new TextEncoder().encode(secretStr);
  const { payload } = await jose.jwtVerify(state, secret);
  if (!payload.clientId || payload.purpose !== 'meta_oauth') {
    throw new Error('Invalid OAuth state payload.');
  }
  return payload.clientId as string;
}

export const META_OAUTH_SCOPES = [
  'ads_management',
  'ads_read',
  'business_management',
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_metadata',
  'pages_manage_ads',
  'leads_retrieval'
];

/**
 * Initiates Meta OAuth URL with a CSRF-protected signed JWT state.
 */
export async function generateMetaOAuthUrl(clientId: string): Promise<string> {
  const appId = process.env.META_APP_ID;
  if (!appId || appId === 'your_meta_app_id') {
    logger.error('Agency', 'META_APP_ID is not configured — OAuth URL cannot be generated.');
    throw new Error('Meta App is not configured. Please set META_APP_ID in your environment.');
  }
  const redirectUri = process.env.META_REDIRECT_URI || `${process.env.API_URL || 'http://localhost:3000'}/v1/meta/callback`;

  // Dynamically filter out pages_manage_metadata if config specifies
  const activeScopes = process.env.META_EXCLUDE_METADATA_SCOPE === 'true'
    ? META_OAUTH_SCOPES.filter(scope => scope !== 'pages_manage_metadata')
    : META_OAUTH_SCOPES;

  const scopeString = activeScopes.join(',');
  const state = await generateOAuthState(clientId);

  const oauthUrl = `https://www.facebook.com/v20.0/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}&scope=${encodeURIComponent(scopeString)}`;

  logger.info('Agency', 'Generating Meta OAuth URL before redirecting', {
    clientId,
    appId,
    scopeList: activeScopes,
    redirectUri,
    finalOAuthUrl: oauthUrl,
  });

  console.log('OAuth URL:', oauthUrl);
  console.log('Scopes:', activeScopes);
  console.log('Final requested scope string:', scopeString);

  return oauthUrl;
}

/**
 * Computes aggregated agency analytics across all client accounts.
 * Returns operational KPIs, client performance rows, attention alerts, and recent activities.
 */
export async function getAgencyAnalytics(agencyId: string) {
  // 1. Fetch ALL non-deleted clients belonging to the agency
  const allClients = await prisma.client.findMany({
    where: { 
      agencyId, 
      isDeleted: false,
    },
    select: {
      id: true,
      businessName: true,
      metaAdSpend: true,
      metaTokenStatus: true,
    },
  });

  const allClientIds = allClients.map((c) => c.id);
  const totalClients = allClients.length;

  if (allClientIds.length === 0) {
    return {
      totalClients: 0,
      totalLeads: 0,
      leadsByStage: {},
      totalRevenue: 0,
      totalAdSpend: 0,
      roas: null,
      // New KPIs
      newLeadsCount: 0,
      needsAttentionCount: 0,
      avgResponseTimeSec: null,
      conversionRate: null,
      clientPerformance: [],
      attentionAlerts: [],
      recentActivities: [],
    };
  }

  // 2. Compute total leads count across ALL clients
  const totalLeads = await prisma.lead.count({
    where: { clientId: { in: allClientIds } },
  });

  // 3. Group leads by stage
  const stageCounts = await prisma.lead.groupBy({
    by: ['stage'],
    where: { clientId: { in: allClientIds } },
    _count: { _all: true },
  });

  const leadsByStage = stageCounts.reduce((acc: Record<string, number>, curr) => {
    acc[curr.stage] = curr._count._all;
    return acc;
  }, {});

  // 4. Compute total revenue from all sales
  const revenueAggregate = await prisma.sale.aggregate({
    where: { clientId: { in: allClientIds } },
    _sum: { amount: true },
  });

  const totalRevenue = Number(revenueAggregate._sum.amount || 0);

  // 5. Compute actual aggregate ad spend and aggregate ROAS
  const totalAdSpend = allClients.reduce((acc, curr) => acc + Number(curr.metaAdSpend), 0);
  const roas = totalAdSpend > 0 ? Number((totalRevenue / totalAdSpend).toFixed(2)) : null;

  // ────────────────────────────────────────────────
  // NEW OPERATIONAL KPIs
  // ────────────────────────────────────────────────

  // 6. New Leads count (stage = NEW)
  const newLeadsCount = leadsByStage['NEW'] || 0;

  // 7. Needs Attention: leads in NEW stage older than 24 hours, or unassigned active leads
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const needsAttentionCount = await prisma.lead.count({
    where: {
      clientId: { in: allClientIds },
      OR: [
        { stage: 'NEW', createdAt: { lt: twentyFourHoursAgo } },
        { assignedTo: null, stage: { not: 'WON' } },
      ],
    },
  });

  // 8. Average Speed-to-Lead (avg responseTimeSec where not null)
  const responseTimeAggregate = await prisma.lead.aggregate({
    where: {
      clientId: { in: allClientIds },
      responseTimeSec: { not: null },
    },
    _avg: { responseTimeSec: true },
  });
  const avgResponseTimeSec = responseTimeAggregate._avg.responseTimeSec
    ? Math.round(responseTimeAggregate._avg.responseTimeSec)
    : null;

  // 9. Conversion Rate (WON / total leads)
  const wonLeads = leadsByStage['WON'] || 0;
  const conversionRate = totalLeads > 0
    ? Number(((wonLeads / totalLeads) * 100).toFixed(1))
    : null;

  // ────────────────────────────────────────────────
  // CLIENT PERFORMANCE TABLE
  // ────────────────────────────────────────────────

  // 10. Per-client performance metrics
  const clientPerformance = await Promise.all(
    allClients.map(async (client) => {
      const clientLeadCount = await prisma.lead.count({
        where: { clientId: client.id },
      });

      const clientStages = await prisma.lead.groupBy({
        by: ['stage'],
        where: { clientId: client.id },
        _count: { _all: true },
      });

      const clientStageMap = clientStages.reduce((acc: Record<string, number>, curr) => {
        acc[curr.stage] = curr._count._all;
        return acc;
      }, {});

      const clientQualified = (clientStageMap['QUALIFIED'] || 0) + (clientStageMap['NEGOTIATION'] || 0);
      const clientWon = clientStageMap['WON'] || 0;

      // Average response time for this client
      const clientResponseTime = await prisma.lead.aggregate({
        where: {
          clientId: client.id,
          responseTimeSec: { not: null },
        },
        _avg: { responseTimeSec: true },
      });
      const clientAvgResponseSec = clientResponseTime._avg.responseTimeSec
        ? Math.round(clientResponseTime._avg.responseTimeSec)
        : null;

      // Overdue attention items for this client
      const clientOverdue = await prisma.lead.count({
        where: {
          clientId: client.id,
          OR: [
            { stage: 'NEW', createdAt: { lt: twentyFourHoursAgo } },
            { assignedTo: null, stage: { not: 'WON' } },
          ],
        },
      });

      // Determine operational health status
      let status: 'Healthy' | 'Attention' | 'Critical' = 'Healthy';
      if (clientAvgResponseSec !== null && clientAvgResponseSec > 900) {
        status = 'Critical'; // > 15 minutes
      } else if (clientOverdue > 5) {
        status = 'Critical';
      } else if (
        (clientAvgResponseSec !== null && clientAvgResponseSec > 300) ||
        clientOverdue > 0
      ) {
        status = 'Attention';
      }

      return {
        clientId: client.id,
        businessName: client.businessName,
        totalLeads: clientLeadCount,
        avgResponseTimeSec: clientAvgResponseSec,
        qualifiedCount: clientQualified,
        wonCount: clientWon,
        overdueCount: clientOverdue,
        status,
      };
    })
  );

  // ────────────────────────────────────────────────
  // ATTENTION ALERTS
  // ────────────────────────────────────────────────

  // 11. Attention Alerts
  const attentionAlerts: { type: string; message: string; count?: number }[] = [];

  const unassignedCount = await prisma.lead.count({
    where: {
      clientId: { in: allClientIds },
      assignedTo: null,
      stage: { notIn: ['WON', 'LOST'] },
    },
  });
  if (unassignedCount > 0) {
    attentionAlerts.push({
      type: 'unassigned',
      message: `${unassignedCount} lead${unassignedCount > 1 ? 's' : ''} not assigned to any team member`,
      count: unassignedCount,
    });
  }

  const overdueNewCount = await prisma.lead.count({
    where: {
      clientId: { in: allClientIds },
      stage: 'NEW',
      createdAt: { lt: twentyFourHoursAgo },
    },
  });
  if (overdueNewCount > 0) {
    attentionAlerts.push({
      type: 'overdue',
      message: `${overdueNewCount} lead${overdueNewCount > 1 ? 's' : ''} stuck in NEW for over 24 hours`,
      count: overdueNewCount,
    });
  }

  // Check for disconnected Meta integrations
  const disconnectedClients = allClients.filter(
    (c) => c.metaTokenStatus && c.metaTokenStatus !== 'CONNECTED'
  );
  if (disconnectedClients.length > 0) {
    attentionAlerts.push({
      type: 'integration',
      message: `${disconnectedClients.length} client${disconnectedClients.length > 1 ? 's' : ''} with disconnected Meta integration`,
      count: disconnectedClients.length,
    });
  }

  // ────────────────────────────────────────────────
  // RECENT ACTIVITY FEED
  // ────────────────────────────────────────────────

  // 12. Recent Activities (last 10 entries)
  const recentActivities = await prisma.activityLog.findMany({
    where: { agencyId },
    orderBy: { createdAt: 'desc' },
    take: 10,
    include: {
      lead: {
        select: { name: true, clientId: true },
      },
      user: {
        select: { email: true, role: true },
      },
    },
  });

  // Enrich activities with client business name lookup
  const clientIdToName = allClients.reduce((acc: Record<string, string>, c) => {
    acc[c.id] = c.businessName;
    return acc;
  }, {});

  const enrichedActivities = recentActivities.map((act) => ({
    id: act.id,
    action: act.action,
    oldValue: act.oldValue,
    newValue: act.newValue,
    leadName: act.lead?.name || null,
    clientName: act.lead?.clientId ? clientIdToName[act.lead.clientId] || null : null,
    userEmail: act.user?.email || null,
    createdAt: act.createdAt,
  }));

  return {
    totalClients,
    totalLeads,
    leadsByStage,
    totalRevenue,
    totalAdSpend: Number(totalAdSpend.toFixed(2)),
    roas,
    // New KPIs
    newLeadsCount,
    needsAttentionCount,
    avgResponseTimeSec,
    conversionRate,
    clientPerformance,
    attentionAlerts,
    recentActivities: enrichedActivities,
  };
}

/**
 * Retrieves the profile of an agency by its ID.
 */
export async function getAgencyProfile(agencyId: string) {
  const agency = await prisma.agency.findUnique({
    where: { id: agencyId },
  });
  if (!agency) {
    throw new Error('Agency not found');
  }
  return agency;
}

/**
 * Updates the profile of an agency by its ID.
 */
export async function updateAgencyProfile(agencyId: string, name?: string, email?: string) {
  if (email) {
    const existing = await prisma.agency.findUnique({
      where: { email },
    });
    if (existing && existing.id !== agencyId) {
      throw new Error('An agency with this email address already exists');
    }
  }

  return prisma.agency.update({
    where: { id: agencyId },
    data: {
      ...(name && { name }),
      ...(email && { email }),
    },
  });
}

/**
 * Computes analytics for a specific client managed by the agency.
 */
export async function getClientAnalyticsForAgencyService(agencyId: string, clientId: string) {
  // 1. Verify client belongs to this agency
  const client = await prisma.client.findFirst({
    where: { id: clientId, agencyId, isDeleted: false },
  });

  if (!client) {
    throw new Error('Client not found or access denied');
  }

  const isMetaConnected = client.metaTokenStatus === 'CONNECTED';

  // 2. Fetch basic aggregates
  const leadFilter = isMetaConnected ? { clientId, metaLeadId: { not: null } } : { clientId };
  const saleFilter = isMetaConnected ? { clientId, lead: { metaLeadId: { not: null } } } : { clientId };

  const [totalLeads, leadsByStageRaw, revenueAggregate] = await Promise.all([
    prisma.lead.count({ where: leadFilter }),
    prisma.lead.groupBy({
      by: ['stage'],
      where: leadFilter,
      _count: { _all: true },
    }),
    prisma.sale.aggregate({
      where: saleFilter,
      _sum: { amount: true },
    }),
  ]);

  const leadsByStage = leadsByStageRaw.reduce((acc: Record<string, number>, curr) => {
    acc[curr.stage] = curr._count._all;
    return acc;
  }, {});

  const totalRevenue = Number(revenueAggregate._sum.amount || 0);
  const totalAdSpend = Number(client.metaAdSpend || 0);
  const roas = totalAdSpend > 0 ? Number((totalRevenue / totalAdSpend).toFixed(2)) : null;

  // 3. Compile revenue trends (last 6 months)
  const months = [];
  const currentDate = new Date();
  
  for (let i = 5; i >= 0; i--) {
    const d = new Date(currentDate.getFullYear(), currentDate.getMonth() - i, 1);
    const monthLabel = d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
    const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    
    months.push({
      label: monthLabel,
      key: monthKey,
      revenue: 0,
    });
  }

  const oldestMonthDate = new Date(currentDate.getFullYear(), currentDate.getMonth() - 5, 1, 0, 0, 0, 0);

  const monthlySaleFilter = isMetaConnected 
    ? { clientId, closedAt: { gte: oldestMonthDate }, lead: { metaLeadId: { not: null } } }
    : { clientId, closedAt: { gte: oldestMonthDate } };

  const salesData = await prisma.sale.findMany({
    where: monthlySaleFilter,
    select: {
      amount: true,
      closedAt: true,
    },
  });

  for (const sale of salesData) {
    const saleDate = new Date(sale.closedAt);
    const saleKey = `${saleDate.getFullYear()}-${String(saleDate.getMonth() + 1).padStart(2, '0')}`;
    const monthObj = months.find((m) => m.key === saleKey);
    if (monthObj) {
      monthObj.revenue += Number(sale.amount);
    }
  }

  const revenueByMonth = months.map((m) => ({
    month: m.label,
    revenue: Number(m.revenue.toFixed(2)),
  }));

  return {
    client,
    totalLeads,
    leadsByStage,
    totalRevenue,
    totalAdSpend,
    roas,
    revenueByMonth,
  };
}

/**
 * Changes a client's user account password by the agency admin.
 */
export async function updateAgencyClientPassword(
  agencyId: string,
  clientId: string,
  newPasswordPlain: string
) {
  return runBypassingTenant(async () => {
    const client = await prisma.client.findUnique({
      where: { id: clientId },
    });

    if (!client || client.agencyId !== agencyId || client.isDeleted) {
      throw new Error('Client not found or access denied');
    }

    const passwordHash = await bcrypt.hash(newPasswordPlain, 12);

    const updateResult = await prisma.user.updateMany({
      where: { clientId },
      data: { passwordHash },
    });

    if (updateResult.count === 0) {
      throw new Error('No active user account found for this client');
    }

    return { message: 'Client password updated successfully' };
  });
}

/**
 * Lists all teammates belonging to the agency (excluding client users).
 */
export async function getAgencyTeammates(agencyId: string) {
  return prisma.user.findMany({
    where: { 
      agencyId,
      clientId: null,
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      email: true,
      role: true,
      createdAt: true,
    },
  });
}

/**
 * Invites / Creates a new teammate under the agency.
 */
export async function createAgencyTeammate(
  agencyId: string,
  email: string,
  passwordPlain: string,
  role: string
) {
  // Check if user already exists
  const existingUser = await prisma.user.findUnique({
    where: { email },
  });

  if (existingUser) {
    throw new Error('A user with this email address already exists');
  }

  // Hash password using bcrypt (cost 12)
  const passwordHash = await bcrypt.hash(passwordPlain, 12);

  return prisma.user.create({
    data: {
      agencyId,
      email,
      passwordHash,
      role: role as any,
    },
    select: {
      id: true,
      email: true,
      role: true,
      createdAt: true,
    },
  });
}

/**
 * Deletes / Revokes teammate access.
 */
export async function deleteAgencyTeammate(agencyId: string, userId: string) {
  return runBypassingTenant(async () => {
    // Validate user belongs to agency and is not client user
    const user = await prisma.user.findFirst({
      where: {
        id: userId,
        agencyId,
        clientId: null,
      },
    });

    if (!user) {
      throw new Error('Teammate not found or access denied');
    }

    return prisma.user.delete({
      where: { id: userId },
    });
  });
}

/**
 * Updates the agency user's password.
 */
export async function changeAgencyUserPassword(userId: string, newPasswordPlain: string) {
  const passwordHash = await bcrypt.hash(newPasswordPlain, 12);
  return prisma.user.update({
    where: { id: userId },
    data: { passwordHash },
  });
}
