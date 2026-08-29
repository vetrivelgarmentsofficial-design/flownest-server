# Base image for building the application
FROM node:20-alpine AS builder

WORKDIR /usr/src/app

# Install build dependencies and Prisma dependencies
RUN apk add --no-cache python3 make g++ openssl libc6-compat

# Copy dependency configuration
COPY package*.json ./
COPY prisma ./prisma/

# Install all dependencies (including devDependencies for typescript build)
RUN npm ci

# Copy rest of the project files
COPY . .

# Generate Prisma Client
RUN npx prisma generate

# Build TypeScript to Javascript
RUN npm run build

# --- Production Image Stage ---
FROM node:20-alpine

WORKDIR /usr/src/app

# Install runtime dependencies for Prisma
RUN apk add --no-cache openssl libc6-compat

COPY package*.json ./
COPY prisma ./prisma/

# Install only production dependencies (re-compile native dependencies for safety)
RUN apk add --no-cache python3 make g++ && \
    npm ci --only=production && \
    apk del python3 make g++

# Copy Prisma compiled engines from builder stage
COPY --from=builder /usr/src/app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /usr/src/app/node_modules/@prisma/client ./node_modules/@prisma/client

# Copy built application source
COPY --from=builder /usr/src/app/dist ./dist

# Expose port (corresponds to default API port)
EXPOSE 5000

ENV NODE_ENV=production

# Start command
CMD ["npm", "run", "start"]
