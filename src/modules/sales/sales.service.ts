import prisma from '../../config/db';

/**
 * Lists all sales for a client (paginated), returning the data and sum metrics.
 */
export async function getClientSales(clientId: string, page: number, limit: number) {
  const skip = (page - 1) * limit;

  const [sales, total, revenueAggregate] = await Promise.all([
    prisma.sale.findMany({
      where: { clientId },
      skip,
      take: limit,
      orderBy: { closedAt: 'desc' },
      include: {
        lead: {
          select: { name: true, email: true, phone: true },
        },
      },
    }),
    prisma.sale.count({
      where: { clientId },
    }),
    prisma.sale.aggregate({
      where: { clientId },
      _sum: { amount: true },
    }),
  ]);

  const totalRevenue = Number(revenueAggregate._sum.amount || 0);

  return { sales, total, totalRevenue };
}

/**
 * Records a closed sale, updates target lead status to 'won' and logs the activity in a transaction.
 */
export async function recordClientSale(
  clientId: string,
  userId: string,
  leadId: string,
  amount: number,
  currency: string = 'INR',
  closedAt: Date
) {
  return prisma.$transaction(async (tx) => {
    // 1. Fetch and verify lead belongs to active client
    const lead = await tx.lead.findUnique({
      where: { id: leadId },
    });

    if (!lead || lead.clientId !== clientId) {
      throw new Error('Lead not found or access denied');
    }

    const oldStage = lead.stage;

    // 2. Update stage to 'WON'
    const updatedLead = await tx.lead.update({
      where: { id: leadId },
      data: { stage: 'WON' },
    });

    // 3. Create sale record
    const sale = await tx.sale.create({
      data: {
        leadId,
        clientId,
        agencyId: lead.agencyId,
        amount,
        currency,
        closedAt,
      },
    });

    // 4. Log to activity logs
    await tx.activityLog.create({
      data: {
        leadId,
        userId,
        action: 'stage_change',
        oldValue: oldStage,
        newValue: 'WON',
        clientId,
        agencyId: lead.agencyId,
      },
    });

    return { sale, lead: updatedLead };
  });
}

/**
 * Calculates aggregated client statistics: conversion ratios, cost metrics, trends, and ROAS.
 */
export async function getClientSalesAnalytics(clientId: string) {
  // 1. Fetch client details (for ad spend)
  const clientRecord = await prisma.client.findUnique({
    where: { id: clientId },
    select: { metaAdSpend: true },
  });

  const totalAdSpend = Number(clientRecord?.metaAdSpend || 0);

  // 2. Fetch basic aggregates
  const [totalLeads, newLeads, wonLeads, lostLeads, revenueAggregate] = await Promise.all([
    prisma.lead.count({ where: { clientId } }),
    prisma.lead.count({ where: { clientId, stage: 'NEW' } }),
    prisma.lead.count({ where: { clientId, stage: 'WON' } }),
    prisma.lead.count({ where: { clientId, stage: 'LOST' } }),
    prisma.sale.aggregate({
      where: { clientId },
      _sum: { amount: true },
    }),
  ]);

  const totalRevenue = Number(revenueAggregate._sum.amount || 0);

  // 3. Perform calculations
  const conversionRate = totalLeads > 0 ? Number(((wonLeads / totalLeads) * 100).toFixed(2)) : 0;
  const costPerLead = totalLeads > 0 ? Number((totalAdSpend / totalLeads).toFixed(2)) : 0;
  const ROAS = totalAdSpend > 0 ? Number((totalRevenue / totalAdSpend).toFixed(2)) : null;

  // 4. Compile revenue trends (last 6 months)
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

  // Get date range start (first day of oldest month)
  const oldestMonthDate = new Date(currentDate.getFullYear(), currentDate.getMonth() - 5, 1, 0, 0, 0, 0);

  const salesData = await prisma.sale.findMany({
    where: {
      clientId,
      closedAt: { gte: oldestMonthDate },
    },
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
    totalRevenue,
    totalLeads,
    newLeads,
    wonLeads,
    lostLeads,
    conversionRate,
    costPerLead,
    ROAS,
    revenueByMonth,
  };
}
