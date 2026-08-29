import { Server as HttpServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';

let ioInstance: SocketIOServer | null = null;

export function initializeSocketIO(server: HttpServer) {
  const io = new SocketIOServer(server, {
    cors: {
      origin: process.env.FRONTEND_URL || 'http://localhost:5173',
      methods: ['GET', 'POST']
    }
  });

  io.on('connection', (socket) => {
    console.log(`🔌 Client connected to Socket.IO: ${socket.id}`);

    // Join room corresponding to tenant scope
    socket.on('join-tenant', (tenantId: string) => {
      socket.join(tenantId);
      console.log(`Socket ${socket.id} joined tenant room: ${tenantId}`);
    });

    socket.on('disconnect', () => {
      console.log(`🔌 Client disconnected: ${socket.id}`);
    });
  });

  ioInstance = io;
  return io;
}

export function getIo(): SocketIOServer {
  if (!ioInstance) {
    throw new Error('Socket.IO is not initialized yet.');
  }
  return ioInstance;
}
