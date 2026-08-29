import prisma from '../../config/db';

/**
 * Helper to extract custom properties from customFields JSON column
 * and map them to root keys on the lead payload.
 */
export function enrichLead(lead: any) {
  if (!lead) return lead;
  const customFields = (lead.customFields as any) || {};
  return {
    ...lead,
    callAttempts: customFields.callAttempts || 0,
    lastCallResult: customFields.lastCallResult || null,
    proposalSentAt: customFields.proposalSentAt || null,
    proposalSalesperson: customFields.proposalSalesperson || null,
    proposalNotes: customFields.proposalNotes || null,
    lastActivityAt: customFields.lastActivityAt || lead.updatedAt.toISOString(),
    lastActivityType: customFields.lastActivityType || null,
  };
}

/**
 * Lists leads scoped to the active tenant, with filters and pagination.
 */
export async function getLeadsList(
  filters: { stage?: string; assignedTo?: string; search?: string; source?: string; city?: string; startDate?: string; endDate?: string; clientId?: string },
  page: number,
  limit: number
) {
  const skip = (page - 1) * limit;

  // Build filters (Prisma middleware automatically scopes by tenantId)
  const where: any = {};

  if (filters.clientId) {
    where.clientId = filters.clientId;
  }
  
  if (filters.stage) {
    where.stage = filters.stage;
  }
  
  if (filters.assignedTo) {
    where.assignedTo = filters.assignedTo;
  }

  if (filters.source) {
    where.source = { contains: filters.source, mode: 'insensitive' };
  }

  if (filters.city) {
    where.city = { contains: filters.city, mode: 'insensitive' };
  }

  if (filters.startDate || filters.endDate) {
    where.createdAt = {};
    if (filters.startDate) {
      where.createdAt.gte = new Date(filters.startDate);
    }
    if (filters.endDate) {
      where.createdAt.lte = new Date(filters.endDate);
    }
  }
  
  if (filters.search) {
    where.OR = [
      { name: { contains: filters.search, mode: 'insensitive' } },
      { email: { contains: filters.search, mode: 'insensitive' } },
      { phone: { contains: filters.search, mode: 'insensitive' } },
    ];
  }

  const [leads, total] = await Promise.all([
    prisma.lead.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        assignedUser: {
          select: { id: true, email: true, role: true },
        },
      },
    }),
    prisma.lead.count({ where }),
  ]);

  const enrichedLeads = leads.map(enrichLead);

  return { leads: enrichedLeads, total };
}

/**
 * Fetches a single lead with full history (follow-ups, activity logs, sales).
 */
export async function getLeadById(leadId: string) {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: {
      followUps: {
        orderBy: { scheduledAt: 'asc' },
      },
      activityLogs: {
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: { id: true, email: true, role: true },
          },
        },
      },
      sales: {
        orderBy: { closedAt: 'desc' },
      },
      assignedUser: {
        select: { id: true, email: true, role: true },
      },
    },
  });

  return enrichLead(lead);
}

/**
 * Updates the pipeline stage of a lead and logs it to activity logs.
 */
export async function updateLeadStage(leadId: string, newStage: string, userId: string) {
  return prisma.$transaction(async (tx) => {
    // 1. Fetch lead details
    const lead = await tx.lead.findUnique({
      where: { id: leadId },
    });

    if (!lead) {
      throw new Error('Lead not found');
    }

    const oldStage = lead.stage;

    // Prepare updated custom fields
    let updatedCustomFields: any = lead.customFields ? { ...(lead.customFields as any) } : {};
    const now = new Date();
    updatedCustomFields.lastActivityAt = now.toISOString();
    updatedCustomFields.lastActivityType = 'Stage Updated to ' + newStage;

    // Connected stage first entry
    if (newStage === 'CONTACTED' && !updatedCustomFields.connectedAt) {
      updatedCustomFields.connectedAt = now.toISOString();
    }

    // Proposal stage transition
    if (newStage === 'NEGOTIATION') {
      updatedCustomFields.proposalSentAt = now.toISOString();
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { email: true }
      });
      updatedCustomFields.proposalSalesperson = user?.email || 'System';
    }

    // Speed-to-Lead: Record first contact timestamp and response time
    // when a lead transitions out of NEW for the first time
    let speedToLeadData: { firstContactedAt?: Date; responseTimeSec?: number } = {};
    if (oldStage === 'NEW' && newStage !== 'NEW' && !lead.firstContactedAt) {
      speedToLeadData.firstContactedAt = now;
      speedToLeadData.responseTimeSec = Math.floor(
        (now.getTime() - lead.createdAt.getTime()) / 1000
      );
    }

    // 2. Perform update
    const updatedLead = await tx.lead.update({
      where: { id: leadId },
      data: {
        stage: newStage as any,
        customFields: updatedCustomFields,
        ...speedToLeadData,
      },
    });

    // 3. Log action to activity logs
    await tx.activityLog.create({
      data: {
        leadId,
        userId,
        action: 'stage_change',
        oldValue: oldStage,
        newValue: newStage,
        clientId: lead.clientId,
        agencyId: lead.agencyId,
      },
    });

    return { lead: enrichLead(updatedLead), oldStage, newStage };
  });
}

/**
 * Adds a custom note to a lead's activity log.
 */
export async function addLeadNote(leadId: string, noteText: string, userId: string) {
  return prisma.$transaction(async (tx) => {
    // 1. Fetch lead
    const lead = await tx.lead.findUnique({
      where: { id: leadId },
    });

    if (!lead) {
      throw new Error('Lead not found');
    }

    // Prepare updated custom fields
    let updatedCustomFields: any = lead.customFields ? { ...(lead.customFields as any) } : {};
    const now = new Date();
    updatedCustomFields.lastActivityAt = now.toISOString();

    const isCna = noteText.startsWith('Call Not Attended');
    if (isCna) {
      updatedCustomFields.callAttempts = (updatedCustomFields.callAttempts || 0) + 1;
      updatedCustomFields.lastCallResult = 'Call Not Attended';
      updatedCustomFields.lastActivityType = 'Call Not Attended';
    } else {
      updatedCustomFields.lastActivityType = 'Note Added';
      
      // Check if this note is connected with a call outcome
      if (lead.stage === 'CONTACTED') {
        updatedCustomFields.callAttempts = (updatedCustomFields.callAttempts || 0) + 1;
        updatedCustomFields.lastCallResult = 'Connected';
      }
    }

    // If lead is in NEGOTIATION (Proposal) stage, store note as proposalNotes
    if (lead.stage === 'NEGOTIATION') {
      updatedCustomFields.proposalNotes = noteText;
    }

    // Update lead custom fields
    await tx.lead.update({
      where: { id: leadId },
      data: { customFields: updatedCustomFields },
    });

    // 2. Create activity log entry for the note
    const logRecord = await tx.activityLog.create({
      data: {
        leadId,
        userId,
        action: isCna ? 'call_not_attended' : 'note',
        oldValue: null,
        newValue: noteText,
        clientId: lead.clientId,
        agencyId: lead.agencyId,
      },
    });

    return logRecord;
  });
}

/**
 * Deletes a lead by ID.
 */
export async function deleteLeadById(leadId: string) {
  return prisma.lead.delete({
    where: { id: leadId },
  });
}

/**
 * Deletes multiple leads by IDs.
 */
export async function deleteLeadsByIds(leadIds: string[]) {
  return prisma.lead.deleteMany({
    where: { id: { in: leadIds } },
  });
}

/**
 * Creates a lead manually and triggers the notification queue.
 */
export async function createManualLead(
  clientId: string,
  agencyId: string,
  data: { name: string; email?: string | null; phone?: string | null; city?: string | null; source?: string | null; stage?: string | null },
  userId: string
) {
  return prisma.$transaction(async (tx) => {
    // 1. Create lead
    const lead = await tx.lead.create({
      data: {
        clientId,
        agencyId,
        name: data.name,
        email: data.email || null,
        phone: data.phone || null,
        city: data.city || null,
        source: data.source || 'MANUAL',
        stage: (data.stage as any) || 'NEW',
        leadSource: 'MANUAL',
        status: 'ACTIVE',
        createdBy: 'USER',
      },
    });

    // 2. Log activity
    await tx.activityLog.create({
      data: {
        leadId: lead.id,
        userId,
        action: 'create',
        newValue: `Lead manually created by User`,
        clientId,
        agencyId,
      },
    });

    // 3. Trigger Notification Engine (decoupled via queue)
    try {
      const { publishLeadCreated } = require('../notifications/notification.service');
      await publishLeadCreated(lead.id, clientId);
    } catch (notifErr: any) {
      console.warn('[LeadsService] Failed to publish lead creation notification to queue:', notifErr.message);
    }

    return lead;
  });
}

/**
 * Fetches paginated activity logs for a specific lead, newest first.
 */
export async function getLeadActivities(leadId: string, page: number, limit: number) {
  const skip = (page - 1) * limit;

  const [activities, total] = await Promise.all([
    prisma.activityLog.findMany({
      where: { leadId },
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: { id: true, email: true, role: true },
        },
      },
    }),
    prisma.activityLog.count({ where: { leadId } }),
  ]);

  return { activities, total };
}
