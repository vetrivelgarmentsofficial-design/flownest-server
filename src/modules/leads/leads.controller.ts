import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  getLeadsList,
  getLeadById,
  updateLeadStage,
  addLeadNote,
  deleteLeadById,
  deleteLeadsByIds,
  getLeadActivities,
} from './leads.service';
import { emitLeadStageChanged } from '../../sockets/leadEvents';

// Validation Schemas
export const listLeadsQuerySchema = z.object({
  stage: z.enum(['NEW', 'CONTACTED', 'FOLLOW_UP', 'QUALIFIED', 'NEGOTIATION', 'WON', 'LOST', 'BOOKED', 'NO_NEED', 'WRONG_LEAD', 'CALL_NOT_ATTENDED']).optional(),
  assignedTo: z.string().uuid('Invalid user ID format').optional(),
  search: z.string().optional(),
  source: z.string().optional(),
  city: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  clientId: z.string().uuid('Invalid client ID format').optional(),
  page: z.preprocess((val) => Number(val || 1), z.number().int().min(1).default(1)),
  limit: z.preprocess((val) => Number(val || 20), z.number().int().min(1).max(100).default(20)),
});

export const updateStageBodySchema = z.object({
  stage: z.enum(['NEW', 'CONTACTED', 'FOLLOW_UP', 'QUALIFIED', 'NEGOTIATION', 'WON', 'LOST', 'BOOKED', 'NO_NEED', 'WRONG_LEAD', 'CALL_NOT_ATTENDED'], {
    errorMap: () => ({ message: 'Invalid pipeline stage value' }),
  }),
});

export const addNoteBodySchema = z.object({
  note: z.string().min(1, 'Note content cannot be empty'),
});

export const createLeadBodySchema = z.object({
  name: z.string().min(1, 'Customer Name is required'),
  email: z.string().email('Invalid email address format').or(z.literal('')).optional().nullable(),
  phone: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  source: z.string().optional().nullable(),
  stage: z.enum(['NEW', 'CONTACTED', 'FOLLOW_UP', 'QUALIFIED', 'NEGOTIATION', 'WON', 'LOST', 'BOOKED', 'NO_NEED', 'WRONG_LEAD', 'CALL_NOT_ATTENDED']).optional().nullable(),
});

/**
 * Lists leads for the calling user's tenant (paginated, with stage/assignedTo/search filters).
 */
export async function listLeads(req: Request, res: Response, next: NextFunction) {
  try {
    const filters = listLeadsQuerySchema.parse(req.query);
    const { page, limit, ...queryFilters } = filters;

    const { leads, total } = await getLeadsList(queryFilters, page, limit);
    const totalPages = Math.ceil(total / limit);

    res.status(200).json({
      success: true,
      data: leads,
      meta: {
        page,
        limit,
        total,
        totalPages,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Retrieves a single lead by ID with its full historical logs.
 */
export async function getLead(req: Request, res: Response, next: NextFunction) {
  try {
    const leadId = req.params.id;
    const lead = await getLeadById(leadId);

    if (!lead) {
      res.status(404).json({
        success: false,
        data: null,
        error: { message: 'Lead not found or access denied', code: 'NOT_FOUND' },
        meta: {},
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: lead,
      meta: {},
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Updates a lead's pipeline stage and logs it.
 * Emits a real-time event to socket clients.
 */
export async function patchLeadStage(req: Request, res: Response, next: NextFunction) {
  try {
    const leadId = req.params.id;
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({ success: false, data: null, error: { message: 'Unauthorized user context', code: 'UNAUTHORIZED' } });
      return;
    }

    const { stage } = updateStageBodySchema.parse(req.body);
    const result = await updateLeadStage(leadId, stage, userId);

    // Emit Socket.IO Event
    const io = req.app.get('io');
    if (io) {
      emitLeadStageChanged(io, result.lead.clientId, {
        leadId: result.lead.id,
        oldStage: result.oldStage,
        newStage: result.newStage,
      });
    }

    res.status(200).json({
      success: true,
      data: result.lead,
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
 * Adds note log onto the lead.
 */
export async function postLeadNote(req: Request, res: Response, next: NextFunction) {
  try {
    const leadId = req.params.id;
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({ success: false, data: null, error: { message: 'Unauthorized user context', code: 'UNAUTHORIZED' } });
      return;
    }

    const { note } = addNoteBodySchema.parse(req.body);
    const logRecord = await addLeadNote(leadId, note, userId);

    res.status(201).json({
      success: true,
      data: logRecord,
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
 * Deletes a lead by ID.
 * Restricted to super_admin.
 */
export async function deleteLead(req: Request, res: Response, next: NextFunction) {
  try {
    const leadId = req.params.id;

    // Check if lead exists
    const existing = await getLeadById(leadId);

    if (!existing) {
      res.status(404).json({
        success: false,
        data: null,
        error: { message: 'Lead not found or access denied', code: 'NOT_FOUND' },
        meta: {},
      });
      return;
    }

    await deleteLeadById(leadId);

    res.status(200).json({
      success: true,
      data: { message: 'Lead deleted successfully' },
      meta: {},
    });
  } catch (error) {
    next(error);
  }
}

export const bulkDeleteLeadsBodySchema = z.object({
  leadIds: z.array(z.string().uuid('Invalid lead ID format')).min(1, 'At least one lead ID must be provided'),
});

/**
 * Bulk deletes leads by their IDs.
 * Restricted to super_admin.
 */
export async function bulkDeleteLeads(req: Request, res: Response, next: NextFunction) {
  try {
    const { leadIds } = bulkDeleteLeadsBodySchema.parse(req.body);

    await deleteLeadsByIds(leadIds);

    res.status(200).json({
      success: true,
      data: { message: `${leadIds.length} leads deleted successfully` },
      meta: {},
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Creates a lead manually under the active Client workspace.
 */
export async function postCreateLead(req: Request, res: Response, next: NextFunction) {
  try {
    const clientId = req.user?.tenantId;
    const userId = req.user?.userId;

    if (!clientId || !userId) {
      res.status(401).json({ success: false, data: null, error: { message: 'Unauthorized user context', code: 'UNAUTHORIZED' } });
      return;
    }

    // Resolve client's parent agency ID using bypassing context
    const clientRecord = await require('../../config/db').default.client.findUnique({
      where: { id: clientId },
      select: { agencyId: true },
    });

    if (!clientRecord) {
      res.status(404).json({ success: false, data: null, error: { message: 'Client workspace not found', code: 'NOT_FOUND' } });
      return;
    }

    const leadData = createLeadBodySchema.parse(req.body);
    
    const { createManualLead } = require('./leads.service');
    const lead = await createManualLead(clientId, clientRecord.agencyId, leadData, userId);

    // Emit Socket event: lead:new
    const io = req.app.get('io');
    if (io) {
      const { emitLeadNew } = require('../../sockets/leadEvents');
      emitLeadNew(io, clientId, {
        lead,
        leadId: lead.id,
        name: lead.name,
        phone: lead.phone,
        source: lead.source,
        stage: lead.stage,
      });
    }

    res.status(201).json({
      success: true,
      data: lead,
      meta: {},
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Lists paginated activity logs for a specific lead (read-only).
 */
export async function listLeadActivities(req: Request, res: Response, next: NextFunction) {
  try {
    const leadId = req.params.id;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));

    const { activities, total } = await getLeadActivities(leadId, page, limit);
    const totalPages = Math.ceil(total / limit);

    res.status(200).json({
      success: true,
      data: activities,
      meta: {
        page,
        limit,
        total,
        totalPages,
      },
    });
  } catch (error) {
    next(error);
  }
}
