import prisma from '../../config/db';
import { FollowUpStatus, LeadStage } from '@prisma/client';

/**
 * Schedules a new follow-up for a lead, inheriting tenant scope parameters.
 */
export async function scheduleFollowUp(leadId: string, scheduledAt: Date, note?: string) {
  return prisma.$transaction(async (tx) => {
    // Validate lead belongs to the active tenant and exists
    const lead = await tx.lead.findUnique({
      where: { id: leadId },
    });

    if (!lead) {
      throw new Error('Lead not found');
    }

    // Create follow-up record
    const followUp = await tx.followUp.create({
      data: {
        leadId,
        scheduledAt,
        note: note || null,
        clientId: lead.clientId,
        agencyId: lead.agencyId,
        status: 'pending',
      },
    });

    // Reset lead inactivity
    let updatedCustomFields: any = lead.customFields ? { ...(lead.customFields as any) } : {};
    updatedCustomFields.lastActivityAt = new Date().toISOString();
    updatedCustomFields.lastActivityType = 'Reminder Scheduled';
    await tx.lead.update({
      where: { id: leadId },
      data: { customFields: updatedCustomFields }
    });

    return followUp;
  });
}

/**
 * Retrieves follow-ups, optionally filtered by status.
 */
export async function getFollowUps(status?: FollowUpStatus, clientId?: string) {
  return prisma.followUp.findMany({
    where: {
      ...(status && { status }),
      ...(clientId && { clientId }),
    },
    include: {
      lead: {
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          stage: true,
        },
      },
    },
    orderBy: {
      scheduledAt: 'asc',
    },
  });
}

/**
 * Marks a follow-up as complete.
 */
export async function completeFollowUp(id: string, outcome?: string, userId?: string, leadStage?: LeadStage) {
  return prisma.$transaction(async (tx) => {
    const followUp = await tx.followUp.findUnique({
      where: { id },
      include: { lead: true }
    });

    if (!followUp) {
      throw new Error('Follow-up not found');
    }

    const updatedFollowUp = await tx.followUp.update({
      where: { id },
      data: {
        status: 'done',
        completedAt: new Date(),
        note: outcome ? `${followUp.note ? `${followUp.note}\n` : ''}Outcome: ${outcome}` : followUp.note,
      },
    });

    // Reset lead inactivity
    let updatedCustomFields: any = followUp.lead.customFields ? { ...(followUp.lead.customFields as any) } : {};
    updatedCustomFields.lastActivityAt = new Date().toISOString();
    updatedCustomFields.lastActivityType = 'Reminder Completed';

    if (leadStage && followUp.lead && followUp.lead.stage !== leadStage) {
      const oldStage = followUp.lead.stage;
      await tx.lead.update({
        where: { id: followUp.leadId },
        data: {
          stage: leadStage,
          customFields: updatedCustomFields
        }
      });

      await tx.activityLog.create({
        data: {
          leadId: followUp.leadId,
          userId: userId!,
          clientId: followUp.clientId,
          agencyId: followUp.agencyId,
          action: 'stage_change',
          oldValue: oldStage,
          newValue: leadStage,
        }
      });
    } else {
      await tx.lead.update({
        where: { id: followUp.leadId },
        data: { customFields: updatedCustomFields }
      });
    }

    if (userId) {
      await tx.activityLog.create({
        data: {
          leadId: followUp.leadId,
          userId,
          clientId: followUp.clientId,
          agencyId: followUp.agencyId,
          action: 'follow_up_outcome',
          oldValue: 'pending',
          newValue: outcome || 'Completed',
        },
      });
    }

    return updatedFollowUp;
  });
}
