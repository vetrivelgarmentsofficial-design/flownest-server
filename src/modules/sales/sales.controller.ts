import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  getClientSales,
  recordClientSale,
  getClientSalesAnalytics,
} from './sales.service';

// Validation Schemas
export const listSalesQuerySchema = z.object({
  page: z.preprocess((val) => Number(val || 1), z.number().int().min(1).default(1)),
  limit: z.preprocess((val) => Number(val || 20), z.number().int().min(1).max(100).default(20)),
});

export const recordSaleBodySchema = z.object({
  leadId: z.string().uuid('Invalid lead ID format'),
  amount: z.number().positive('Sale amount must be greater than zero'),
  currency: z.string().length(3, 'Currency must be an ISO 3-letter code').toUpperCase().default('INR'),
  closedAt: z.preprocess((val) => new Date(val as string), z.date({
    invalid_type_error: 'Please provide a valid date and time for closedAt',
  })),
});

/**
 * Lists closed deals for the calling client (paginated).
 */
export async function listSales(req: Request, res: Response, next: NextFunction) {
  try {
    const clientId = req.user?.tenantId;
    if (!clientId) {
      res.status(403).json({ success: false, data: null, error: { message: 'Client context missing', code: 'FORBIDDEN' } });
      return;
    }

    const { page, limit } = listSalesQuerySchema.parse(req.query);
    const { sales, total, totalRevenue } = await getClientSales(clientId, page, limit);
    const totalPages = Math.ceil(total / limit);

    res.status(200).json({
      success: true,
      data: sales,
      meta: {
        page,
        limit,
        total,
        totalPages,
        totalRevenue,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Records a closed deal, updates stage, and sends realtime socket events to parent agency.
 */
export async function recordSale(req: Request, res: Response, next: NextFunction) {
  try {
    const clientId = req.user?.tenantId;
    const userId = req.user?.userId;

    if (!clientId || !userId) {
      res.status(403).json({ success: false, data: null, error: { message: 'Required user or client context is missing', code: 'FORBIDDEN' } });
      return;
    }

    const { leadId, amount, currency, closedAt } = recordSaleBodySchema.parse(req.body);
    const result = await recordClientSale(clientId, userId, leadId, amount, currency, closedAt);

    // Emit Socket.IO Event
    const io = req.app.get('io');
    if (io) {
      io.to(`agency:${result.sale.agencyId}`).emit('sale:recorded', {
        clientId: result.sale.clientId,
        amount: Number(result.sale.amount),
        leadId: result.sale.leadId,
      });
      console.log(`[Socket.io] Emitted sale:recorded to agency:${result.sale.agencyId} for lead ${leadId}`);
    }

    res.status(201).json({
      success: true,
      data: result.sale,
      meta: {},
    });
  } catch (error: any) {
    if (error.message === 'Lead not found or access denied') {
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
 * Returns aggregated sales analytics for the calling client tenant.
 */
export async function getSalesAnalytics(req: Request, res: Response, next: NextFunction) {
  try {
    const clientId = req.user?.tenantId;
    if (!clientId) {
      res.status(403).json({ success: false, data: null, error: { message: 'Client context missing', code: 'FORBIDDEN' } });
      return;
    }

    const analytics = await getClientSalesAnalytics(clientId);

    res.status(200).json({
      success: true,
      data: analytics,
      meta: {},
    });
  } catch (error) {
    next(error);
  }
}
