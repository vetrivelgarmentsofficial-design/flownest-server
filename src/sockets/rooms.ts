import { Socket } from 'socket.io';

export interface SocketUser {
  userId: string;
  role: string;
  tenantId: string;
  tenantType: 'agency' | 'client';
}

/**
 * Handles room allocations for connected Socket clients based on their JWT details.
 */
export function handleRoomJoin(socket: Socket, user: SocketUser) {
  const { userId, role, tenantId, tenantType } = user;

  // 1. Join personal room (user:{userId})
  socket.join(`user:${userId}`);
  console.log(`🔌 Socket ${socket.id} (user: ${userId}) joined room: user:${userId}`);

  // 2. Join tenant-specific rooms
  if (role === 'agency_admin' && tenantType === 'agency') {
    socket.join(`agency:${tenantId}`);
    console.log(`🔌 Socket ${socket.id} (agency_admin) joined room: agency:${tenantId}`);
  } else if (role === 'client_owner' && tenantType === 'client') {
    socket.join(`client:${tenantId}`);
    console.log(`🔌 Socket ${socket.id} (client_owner) joined room: client:${tenantId}`);
  } else if (role === 'super_admin') {
    console.log(`🔌 Socket ${socket.id} (super_admin) authenticated. No tenant room assigned.`);
  } else {
    // Support future roles like sales_manager or sales_executive depending on their tenantType scope
    if (tenantType === 'agency') {
      socket.join(`agency:${tenantId}`);
      console.log(`🔌 Socket ${socket.id} (role: ${role}) joined agency room: agency:${tenantId}`);
    } else if (tenantType === 'client') {
      socket.join(`client:${tenantId}`);
      console.log(`🔌 Socket ${socket.id} (role: ${role}) joined client room: client:${tenantId}`);
    }
  }
}
