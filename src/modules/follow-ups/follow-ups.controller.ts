import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { scheduleFollowUp, getFollowUps, completeFollowUp } from './follow-ups.service';
import { FollowUpStatus } from '@prisma/client';

export const scheduleFollowUpBodySchema = z.object({
  scheduledAt: z.preprocess((val) => new Date(val as string), z.date({
    invalid_type_error: 'Please provide a valid date and time for scheduledAt',
  })),
  note: z.string().optional(),
});

export const followUpStatusSchema = z.nativeEnum(FollowUpStatus).optional();

/**
 * Endpoint to schedule a follow-up for a lead.
 */
export async function postFollowUp(req: Request, res: Response, next: NextFunction) {
  try {
    const leadId = req.params.id;
    const { scheduledAt, note } = scheduleFollowUpBodySchema.parse(req.body);

    const followUp = await scheduleFollowUp(leadId, scheduledAt, note);

    res.status(201).json({
      success: true,
      data: followUp,
      meta: {},
    });
  } catch (error: any) {
    if (error.message === 'Lead not found') {
      res.status(404).json({
        success: false,
        data: null,
        error: { message: 'Lead not found or access denied', code: 'NOT_FOUND' },
        meta: {},
      });
      return;
    }
    next(error);
  }
}

/**
 * Endpoint to list all follow-ups (scoped by active tenant context).
 */
export async function listFollowUps(req: Request, res: Response, next: NextFunction) {
  try {
    const statusQuery = req.query.status as string | undefined;
    const status = statusQuery ? followUpStatusSchema.parse(statusQuery) : undefined;
    const clientId = req.query.clientId as string | undefined;

    const followUps = await getFollowUps(status, clientId);

    res.status(200).json({
      success: true,
      data: followUps,
      meta: {},
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Endpoint to mark a follow-up as complete.
 */
export async function patchCompleteFollowUp(req: Request, res: Response, next: NextFunction) {
  try {
    const id = req.params.id;
    const userId = req.user?.userId;
    const { outcome, leadStage } = req.body || {};

    const followUp = await completeFollowUp(id, outcome, userId, leadStage);

    res.status(200).json({
      success: true,
      data: followUp,
      meta: {},
    });
  } catch (error: any) {
    if (error.message === 'Follow-up not found') {
      res.status(404).json({
        success: false,
        data: null,
        error: { message: 'Follow-up not found or access denied', code: 'NOT_FOUND' },
        meta: {},
      });
      return;
    }
    next(error);
  }
}
