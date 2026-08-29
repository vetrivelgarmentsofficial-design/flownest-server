import prisma from '../../config/db';

const db = prisma as any;

export interface ColumnMappingInput {
  crmField: string;
  sheetColumn: string;
}

/**
 * Retrieves mappings for a connection.
 */
export async function getMappingsForConnection(connectionId: string) {
  return db.spreadsheetColumnMapping.findMany({
    where: { connectionId },
  });
}

/**
 * Saves column mappings for a connection.
 * First deletes all old mappings for the connection in a transaction, then creates new ones.
 */
export async function saveColumnMappings(
  clientId: string,
  connectionId: string,
  mappings: ColumnMappingInput[]
) {
  return db.$transaction(async (tx: any) => {
    // 1. Delete all old mappings for this connection
    await tx.spreadsheetColumnMapping.deleteMany({
      where: { connectionId },
    });

    // 2. Insert new mappings
    const created = await Promise.all(
      mappings.map((m) =>
        tx.spreadsheetColumnMapping.create({
          data: {
            clientId,
            connectionId,
            crmField: m.crmField,
            sheetColumn: m.sheetColumn,
          },
        })
      )
    );

    return created;
  });
}
