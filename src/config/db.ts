import { PrismaClient } from '@prisma/client';
import { getTenantContext } from '../utils/tenant-context';
import { encrypt, decrypt } from '../utils/encryption';

const prisma = new PrismaClient();

// Mapping of models to their respective tenant fields
const modelTenantFields: Record<string, { agencyField?: string; clientField?: string; selfIdField?: string }> = {
  Agency: { selfIdField: 'id' },
  Client: { agencyField: 'agencyId', clientField: 'id' },
  User: { agencyField: 'agencyId', clientField: 'clientId' },
  Lead: { agencyField: 'agencyId', clientField: 'clientId' },
  FollowUp: { agencyField: 'agencyId', clientField: 'clientId' },
  Sale: { agencyField: 'agencyId', clientField: 'clientId' },
  ActivityLog: { agencyField: 'agencyId', clientField: 'clientId' },
  RefreshToken: { agencyField: 'agencyId', clientField: 'clientId' },
  GoogleConnection: { clientField: 'clientId' },
  SpreadsheetConnection: { clientField: 'clientId' },
  SpreadsheetColumnMapping: { clientField: 'clientId' },
  SpreadsheetImportHistory: { clientField: 'clientId' },
  TelegramIntegration: { clientField: 'clientId' },
  TelegramRecipient: { clientField: 'clientId' },
  NotificationLog: { clientField: 'clientId' },
  NotificationPreference: { clientField: 'clientId' },
};

/**
 * Recursively decycles and decrypts specified fields (accessToken, refreshToken, metaAccessToken)
 * within any query result, including nested inclusions.
 */
function decryptNestedFields(obj: any, visited = new WeakSet()) {
  if (!obj || typeof obj !== 'object') {
    return;
  }

  if (visited.has(obj)) {
    return;
  }
  visited.add(obj);

  if (Array.isArray(obj)) {
    for (const item of obj) {
      decryptNestedFields(item, visited);
    }
    return;
  }

  // Decrypt fields if present
  if (typeof obj.accessToken === 'string') {
    try {
      obj.accessToken = decrypt(obj.accessToken);
    } catch (error) {
      // Ignore decryption failure to remain backward compatible / fallback to plaintext
    }
  }
  if (typeof obj.refreshToken === 'string') {
    try {
      obj.refreshToken = decrypt(obj.refreshToken);
    } catch (error) {
      // Ignore
    }
  }
  if (typeof obj.metaAccessToken === 'string') {
    try {
      obj.metaAccessToken = decrypt(obj.metaAccessToken);
    } catch (error) {
      // Ignore
    }
  }
  if (typeof obj.botToken === 'string') {
    try {
      obj.botToken = decrypt(obj.botToken);
    } catch (error) {
      // Ignore
    }
  }

  // Recursively decrypt nested objects/relations
  for (const key of Object.keys(obj)) {
    if (obj[key] && typeof obj[key] === 'object') {
      decryptNestedFields(obj[key], visited);
    }
  }
}

prisma.$use(async (params, next) => {
  const modelName = params.model as string;

  // 1. Handle Encrypted Fields for Writes (Encrypt inputs if applicable)
  // This runs for ALL writes, even if tenant validation is bypassed
  if (modelName === 'Client' && params.args?.data) {
    const data = params.args.data;
    if (data.metaAccessToken) {
      data.metaAccessToken = encrypt(data.metaAccessToken);
    }
  }

  if (modelName === 'GoogleConnection' && params.args?.data) {
    const data = params.args.data;
    if (data.accessToken) {
      data.accessToken = encrypt(data.accessToken);
    }
    if (data.refreshToken) {
      data.refreshToken = encrypt(data.refreshToken);
    }
  }

  if (modelName === 'TelegramIntegration') {
    if (params.args?.data?.botToken) {
      params.args.data.botToken = encrypt(params.args.data.botToken);
    }
    if (params.args?.create?.botToken) {
      params.args.create.botToken = encrypt(params.args.create.botToken);
    }
    if (params.args?.update?.botToken) {
      params.args.update.botToken = encrypt(params.args.update.botToken);
    }
  }

  // 2. Multi-Tenancy Logic (Only applied if model mapping exists and context is not bypassed)
  const context = getTenantContext();
  const mapping = modelName ? modelTenantFields[modelName] : undefined;

  if (mapping && !context?.bypass) {
    // Enforce that tenant context exists
    if (!context || (!context.agencyId && !context.clientId)) {
      throw new Error(
        `Multi-tenancy violation: Query executed on '${modelName}' without an active tenant context (agencyId or clientId).`
      );
    }

    const { agencyId, clientId } = context;

    // Inject Tenant Filters for Reads and Writes
    const readActions = ['findUnique', 'findFirst', 'findMany', 'count', 'aggregate', 'groupBy'];
    const writeActions = ['update', 'updateMany', 'delete', 'deleteMany'];
    const createActions = ['create', 'createMany'];

    if (readActions.includes(params.action) || writeActions.includes(params.action)) {
      // If findUnique, convert to findFirst so we can add tenant filters
      if (params.action === 'findUnique') {
        params.action = 'findFirst';
      }

      params.args = params.args || {};
      params.args.where = params.args.where || {};

      if (mapping.selfIdField && agencyId) {
        // e.g. Agency table itself
        params.args.where[mapping.selfIdField] = agencyId;
      } else {
        // Standard table
        if (clientId && mapping.clientField) {
          // Client-scoped query (e.g. client user logged in)
          params.args.where[mapping.clientField] = clientId;
        } else if (agencyId && mapping.agencyField) {
          // Agency-scoped query (e.g. agency user logged in)
          params.args.where[mapping.agencyField] = agencyId;
        } else {
          throw new Error(
            `Multi-tenancy violation: Mismatch between context keys (agencyId: ${agencyId}, clientId: ${clientId}) and model '${modelName}' tenant fields.`
          );
        }
      }
    } else if (createActions.includes(params.action)) {
      // Inject tenant ID on creation
      params.args = params.args || {};
      
      const applyTenantToData = (dataObj: any) => {
        if (!dataObj) return;
        
        if (mapping.selfIdField) {
          if (agencyId) dataObj[mapping.selfIdField] = agencyId;
        } else {
          if (clientId && mapping.clientField) {
            dataObj[mapping.clientField] = clientId;
          }
          if (agencyId && mapping.agencyField) {
            dataObj[mapping.agencyField] = agencyId;
          }
        }
      };

      if (params.action === 'createMany') {
        if (Array.isArray(params.args.data)) {
          params.args.data.forEach(applyTenantToData);
        }
      } else {
        applyTenantToData(params.args.data);
      }
    }
  }

  // 3. Execute Query
  const result = await next(params);

  // 4. Handle Decryption for Reads (Recursively decrypt result values if applicable)
  // This runs for ALL reads, even if tenant validation is bypassed
  if (result) {
    decryptNestedFields(result);
  }

  return result;

});

export default prisma;
export { prisma };
