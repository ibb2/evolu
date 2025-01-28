import { MerkleTreeString, OwnerId, TimestampString } from "@evolu/common";
import { Model } from "@xata.io/kysely";
import * as Context from "effect/Context";
import { Kysely } from "kysely";
import { DatabaseSchema } from "./xata.js";

/** Evolu Server database schema. */
export interface Database {
  readonly message: MessageTable;
  readonly merkleTree: MerkleTreeTable;
}

interface MessageTable {
  readonly timestamp: TimestampString;
  readonly userId: OwnerId;
  readonly content: Uint8Array; // Changed from Uint8Array
}

interface MerkleTreeTable {
  readonly userId: OwnerId;
  readonly merkleTree: MerkleTreeString;
}

/**
 * Evolu Server Kysely instance. Use only PostgreSQL or SQLite dialects for now.
 * https://kysely-org.github.io/kysely-apidoc/classes/InsertQueryBuilder.html#onConflict
 */
export type Db = Kysely<Model<Database>>; // Added Model<> to support Xata
export const Db = Context.GenericTag<Db>("@services/Db");

export interface SocketMap {
  [key: string]: WebSocket[];
}

export interface BadRequestError {
  readonly _tag: "BadRequestError";
  readonly error: unknown;
}

export interface DatabaseTokens {
  [key: string]: string;
}

export interface DatabaseConnections {
  [key: string]: Kysely<Model<DatabaseSchema>>;
}
