import type { Model } from "@xata.io/kysely";
import { XataDialect } from "@xata.io/kysely";
import { Dialect, Kysely, PostgresDialect } from "kysely";
import { DatabaseSchema, getXataClient } from "../../xata.js";
import type { Database } from "../../Types.ts";
import pkg from 'pg';
const { Pool, types } = pkg;

const xata = getXataClient();

// OID for JSONB is 3802
types.setTypeParser(3802, (val) => val); // Parse JSONB as plain text

export function xataDatabase(): Kysely<Model<Database>> {

    // // Set up type parsing and encoding handling
    // types.setTypeParser(types.builtins.BYTEA, (val) => val);

    // // Ensure UTF-8 encoding for all connections
    // types.setTypeParser(types.builtins.TEXT, (val) => {
    //     try {
    //         // Attempt to decode and sanitize text
    //         return val ? val.replace(/[^\x20-\x7E]/g, '') : val;
    //     } catch (error) {
    //         console.error('Encoding error:', error);
    //         return val;
    //     }
    // });

    // Responsible for connecting the Xata database with kysely
    const db = new Kysely<Model<Database>>({
        dialect: new PostgresDialect({
            pool: new Pool({
                connectionString: `postgresql://cld7v9:${process.env.XATA_API_KEY}@us-east-1.sql.xata.sh/aether:main?sslmode=require`, // Use your Xata PostgreSQL connection string
            }),
        }),
    })

    return db
}
