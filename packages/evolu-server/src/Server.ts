import {
  SyncRequest,
  SyncResponse,
  TimestampString,
  diffMerkleTrees,
  initialMerkleTree,
  insertIntoMerkleTree,
  makeSyncTimestamp,
  merkleTreeToString,
  timestampToString,
  unsafeMerkleTreeFromString,
  unsafeTimestampFromString,
} from "@evolu/common";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { sql } from "kysely";
import { BadRequestError, Db } from "./Types.js";
import WebSocket from "ws";

export interface Server {
  /** Create database tables and indexes if they do not exist. */
  readonly initDatabase: Effect.Effect<void>;

  /** Sync data. */
  readonly sync: (
    body: Uint8Array,
    socketUserMap: { [key: string]: WebSocket[] | undefined },
  ) => Effect.Effect<Buffer, BadRequestError>;
}

const broadcastByMap = (
  data: ArrayBufferLike,
  socketUserMap: { [key: string]: WebSocket[] | undefined },
  userId: string,
) => {
  socketUserMap[userId]?.map((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
};

export const Server = Context.GenericTag<Server>("@services/Server");

export const ServerLive = Layer.effect(
  Server,
  Effect.gen(function* () {
    const db = yield* Db;

    return Server.of({
      initDatabase: Effect.promise(async () => {
        await db.schema
          .createTable("message")
          .ifNotExists()
          .addColumn("xata_id", "text", (col) =>
            col.defaultTo(sql`'rec_' || (xata_private.xid())::text`),
          ) // Xata ID
          .addColumn("timestamp", "text")
          .addColumn("userId", "text")
          .addColumn("content", "bytea") // Store JSON data in JSONB for better performance
          .addColumn("xata_createdat", "timestamptz", (col) =>
            col.defaultTo(sql`now()`),
          ) // Timestamp for creation
          .addColumn("xata_updatedat", "timestamptz", (col) =>
            col.defaultTo(sql`now()`),
          ) // Timestamp for updates
          .addColumn("xata_version", "integer", (col) => col.defaultTo(0)) // Version field (defaults to 0)
          .addPrimaryKeyConstraint("messagePrimaryKey", ["timestamp", "userId"]) // Composite key
          .execute();

        await db.schema
          .createTable("merkleTree")
          .ifNotExists()
          .addColumn("xata_id", "text", (col) =>
            col.defaultTo(sql`'rec_' || (xata_private.xid())::text`),
          ) // Xata ID
          .addColumn("userId", "text", (col) => col.primaryKey()) // userId is part of the primary key
          .addColumn("merkleTree", "text")
          .addColumn("xata_createdat", "timestamptz", (col) =>
            col.defaultTo(sql`now()`),
          ) // Timestamp for creation
          .addColumn("xata_updatedat", "timestamptz", (col) =>
            col.defaultTo(sql`now()`),
          ) // Timestamp for updates
          .addColumn("xata_version", "integer", (col) => col.defaultTo(0)) // Version field (defaults to 0)
          .execute();

        await db.schema
          .createIndex("messageIndex")
          .ifNotExists()
          .on("message")
          .columns(["userId", "timestamp"])
          .execute();
      }),

      sync: (body, socketUserMap) =>
        Effect.gen(function* (_) {
          const request = yield* _(
            Effect.try({
              try: () => SyncRequest.fromBinary(body),
              catch: (error): BadRequestError => ({
                _tag: "BadRequestError",
                error,
              }),
            }),
          );


          broadcastByMap(body, socketUserMap, request.userId);
          const merkleTree = yield* _(
            Effect.promise(() =>
              db
                .transaction()
                .setIsolationLevel("serializable")
                .execute(async (trx) => {
                  let merkleTree = await trx
                    .selectFrom("merkleTree")
                    .select("merkleTree")
                    .where("userId", "=", request.userId)
                    .executeTakeFirst()
                    .then((row) => {
                      if (!row) return initialMerkleTree;
                      return unsafeMerkleTreeFromString(row.merkleTree);
                    });

                  if (request.messages.length === 0) return merkleTree;

                  for (const message of request.messages) {
                    console.log("Inserting message", message);
                    const { numInsertedOrUpdatedRows } = await trx
                      .insertInto("message")
                      .values({
                        content: message.content,
                        timestamp: message.timestamp,
                        userId: request.userId,
                      })
                      .onConflict((oc) => oc.doNothing())
                      .executeTakeFirst();

                    if (numInsertedOrUpdatedRows === 1n) {
                      merkleTree = insertIntoMerkleTree(
                        merkleTree,
                        unsafeTimestampFromString(message.timestamp),
                      );
                    }
                  }

                  const merkleTreeString = merkleTreeToString(merkleTree);

                  await trx
                    .insertInto("merkleTree")
                    .values({
                      userId: request.userId,
                      merkleTree: merkleTreeString,
                    })
                    .onConflict((oc) =>
                      oc.column('userId').doUpdateSet({ merkleTree: merkleTreeString }),
                    )
                    .execute();

                  return merkleTree;
                }),
            ),
          );

          const currentMerkleTreeString = merkleTreeToString(merkleTree);

          // Get all messages first to see what's available
          const allMessages = yield* _(
            Effect.promise(() =>
              db
                .selectFrom("message")
                .select(["timestamp", "content"])
                .where("userId", "=", request.userId)
                .orderBy("timestamp")
                .execute(),
            ),
          );

          yield* _(
            Effect.logDebug([
              "All available messages",
              {
                count: allMessages.length,
                timestamps: allMessages.map((m) => m.timestamp),
              },
            ]),
          );

          // Get messages that need syncing

          const messages = yield* _(
            diffMerkleTrees(
              merkleTree,
              unsafeMerkleTreeFromString(request.merkleTree),
            ),
            Effect.tap((diff) =>
              Effect.logDebug([
                "Merkle tree diff",
                {
                  diff,
                  currentTree: merkleTreeToString(merkleTree),
                  requestTree: request.merkleTree,
                },
              ]),
            ),
            Effect.map(makeSyncTimestamp),
            Effect.map(timestampToString),
            Effect.tap((timestamp) =>
              Effect.logDebug(["Sync timestamp", { timestamp }]),
            ),
            Effect.flatMap((timestamp) =>
              Effect.promise(() => {
                // Check if this is an initial sync (empty merkle tree)
                const isInitialSync =
                  request.merkleTree === merkleTreeToString(initialMerkleTree);

                return (
                  db
                    .selectFrom("message")
                    .select(["timestamp", "content"])
                    .where("userId", "=", request.userId)
                    .where("timestamp", ">=", timestamp)
                    .orderBy("timestamp")
                    // Use higher limit for initial sync
                    .limit(isInitialSync ? 1000 : 50)
                    .execute()
                );
              }),
            ),
            Effect.map((msgs) =>
              msgs.map((msg) => ({
                timestamp: msg.timestamp,
                content:
                  msg.content instanceof Uint8Array
                    ? msg.content
                    : new Uint8Array(msg.content),
              })),
            ),
            Effect.tap((msgs) =>
              Effect.logDebug([
                "Messages selected for sync",
                {
                  count: msgs.length,
                  timestamps: msgs.map((m) => m.timestamp),
                  isInitialSync:
                    request.merkleTree ===
                    merkleTreeToString(initialMerkleTree),
                },
              ]),
            ),
            Effect.catchAll(() => Effect.succeed([])),
          );

          console.log("Messages:", messages);

          const syncResponse = {
            merkleTree: currentMerkleTreeString,
            messages,
          };

          console.log("Sync response:", syncResponse);

          try {
            const response = SyncResponse.toBinary(syncResponse);
            return Buffer.from(response);
          } catch (error) {
            return yield* _(
              Effect.fail({
                _tag: "BadRequestError" as const,
                error: new Error(`Serialization failed: ${error}`),
              }),
            );
          }
        }),
    });
  }),
);
