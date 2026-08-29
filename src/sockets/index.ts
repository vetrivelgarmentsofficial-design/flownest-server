import { Server as HttpServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import * as jose from 'jose';
import { handleRoomJoin, SocketUser } from './rooms';

declare module 'socket.io' {
  interface Socket {
    user?: SocketUser;
  }
}

let ioInstance: SocketIOServer | null = null;

/**
 * Initializes the Socket.IO server, registers JWT authentication middleware, and handles connections.
 */
export function initializeSocketIO(server: HttpServer): SocketIOServer {
  const io = new SocketIOServer(server, {
    cors: {
      origin: process.env.FRONTEND_URL || 'http://localhost:5173',
      methods: ['GET', 'POST'],
    },
  });

  // Connection Handshake JWT Authentication Middleware
  io.use(async (socket: Socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;

      if (!token || typeof token !== 'string') {
        return next(new Error('Authentication token is missing or invalid.'));
      }

      const secretStr = process.env.JWT_ACCESS_SECRET;
      if (!secretStr) {
        return next(new Error('JWT_ACCESS_SECRET is not configured in the environment.'));
      }

      const secret = new TextEncoder().encode(secretStr);

      // Verify Access Token
      const { payload } = await jose.jwtVerify(token, secret);

      if (!payload.userId || !payload.role || !payload.tenantId || !payload.tenantType) {
        return next(new Error('Invalid token schema.'));
      }

      // Attach credentials to socket session
      socket.user = {
        userId: payload.userId as string,
        role: payload.role as string,
        tenantId: payload.tenantId as string,
        tenantType: payload.tenantType as 'agency' | 'client',
      };

      next();
    } catch (error: any) {
      console.warn(`[Socket Auth Warning] Handshake rejected: ${error.message}`);
      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const user = socket.user;
    if (!user) {
      socket.disconnect();
      return;
    }

    // Join authorized rooms based on user and tenant details
    handleRoomJoin(socket, user);

    socket.on('disconnect', () => {
      console.log(`🔌 Client disconnected from Socket.IO: ${socket.id} (user: ${user.userId})`);
    });
  });

  ioInstance = io;
  return io;
}

/**
 * Global getter for the Socket.IO server instance.
 */
export function getIo(): SocketIOServer {
  if (!ioInstance) {
    throw new Error('Socket.IO is not initialized yet.');
  }
  return ioInstance;
}
