import { Server as SocketIOServer } from 'socket.io';

export interface LeadNewPayload {
  lead?: Record<string, any> | null; // full Prisma lead object for optimistic UI update
  leadId: string;
  name: string;
  phone?: string | null;
  source: string | null;
  stage: string;
}

export interface LeadStageChangedPayload {
  leadId: string;
  oldStage: string;
  newStage: string;
}

/**
 * Emits a real-time message when a new lead is created.
 */
export function emitLeadNew(io: SocketIOServer, clientId: string, payload: LeadNewPayload) {
  io.to(`client:${clientId}`).emit('lead:new', payload);
  console.log(`[Socket.io] Emitted lead:new for client ${clientId}:`, payload);
}

/**
 * Emits a real-time message when a lead's stage changes.
 */
export function emitLeadStageChanged(io: SocketIOServer, clientId: string, payload: LeadStageChangedPayload) {
  io.to(`client:${clientId}`).emit('lead:stage_changed', payload);
  console.log(`[Socket.io] Emitted lead:stage_changed for client ${clientId}:`, payload);
}

export interface FollowUpDuePayload {
  followUpId: string;
  leadId: string;
  note: string | null;
}

/**
 * Emits a real-time message when a lead's follow-up is due.
 */
export function emitFollowUpDue(io: SocketIOServer, userId: string, payload: FollowUpDuePayload) {
  io.to(`user:${userId}`).emit('follow_up:due', payload);
  console.log(`[Socket.io] Emitted follow_up:due for user ${userId}:`, payload);
}

export interface SaleRecordedPayload {
  clientId: string;
  amount: number;
  leadId: string;
}

/**
 * Emits a real-time message when a client closes/records a sale.
 */
export function emitSaleRecorded(io: SocketIOServer, agencyId: string, payload: SaleRecordedPayload) {
  io.to(`agency:${agencyId}`).emit('sale:recorded', payload);
  console.log(`[Socket.io] Emitted sale:recorded for agency ${agencyId}:`, payload);
}
