import { Kysely, sql } from 'kysely';

export const getUserDataSize = async (db: Kysely<any>, userId: string): Promise<number> => {
  try {
    // Query to calculate total size of rows for the given userId
    const merkleTreeSize = await db
      .selectFrom('merkleTree')
      .select([
        sql<number>`SUM(octet_length("merkleTree"))`.as('totalSizeBytes'), // Convert JSON to text and calculate byte size
      ])
      .where('userId', '=', userId)
      .executeTakeFirst();

    const messageSize = await db
      .selectFrom('message')
      .select([
        sql<number>`SUM(octet_length(content::text))`.as('totalSizeBytes'), // Convert JSON to text and calculate byte size
      ])
      .where('userId', '=', userId) // Filter by userId
      .executeTakeFirst(); // We expect only one result for the specific userId

    if (!merkleTreeSize || !messageSize) {
      throw new Error(`Failed to retrieve data size for userId: ${userId}`);
    }

    if (merkleTreeSize.totalSizeBytes === null && messageSize.totalSizeBytes === null) {
      return 0;
    }

    if (!messageSize || !messageSize.totalSizeBytes) {
      throw new Error(`Failed to retrieve data size for userId: ${userId}`);
    }

    const totalSizeBytes = messageSize.totalSizeBytes;

    // Convert size to GB
    const sizeInGB = totalSizeBytes / (1024 * 1024 * 1024);
    // console.log(`Data size for userId "${userId}": ${sizeInGB.toFixed(2)} GB`);

    return sizeInGB;
  } catch (err) {
    console.error(
      'Error getting user data size:',
      err instanceof Error ? err.message : String(err)
    );
    throw err;
  }
};
