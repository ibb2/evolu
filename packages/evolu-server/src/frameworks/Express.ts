import { createClient } from "@libsql/client";
import axios from "axios";
import bodyParser from "body-parser";
import cors from "cors";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import * as Exit from "effect/Exit";
import { flow } from "effect/Function";
import * as Match from "effect/Match";
import express, { Express } from "express";
import { Kysely } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { Server, ServerLive } from "../Server.js";
import { Database, Db } from "../Types.js";
import { createServer } from "http";
import WebSocket, { WebSocketServer } from "ws";
import { SyncRequest } from "@evolu/common";

// Turso API types
interface TursoDatabase {
  DbId: string;
  Name: string;
  Hostname: string;
}

interface TursoApiResponse {
  database: TursoDatabase;
}

// Environment variables validation
const getRequiredEnvVar = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const config = {
  tursoUrl: getRequiredEnvVar("TURSO_URL"),
  tursoToken: getRequiredEnvVar("TURSO_TOKEN"),
  tursoOrgSlug: getRequiredEnvVar("TURSO_ORG_SLUG"),
  tursoParentDb: getRequiredEnvVar("TURSO_PARENT_DB"),
  tursoApiToken: getRequiredEnvVar("TURSO_API_TOKEN"),
} as const;

// Array to keep track of connected WebSocket clients
const clients: WebSocket[] = [];
const socketUserMap: { [key: string]: WebSocket[] | undefined } = {};

// Cache for database connections
const dbConnections: { [userId: string]: Kysely<Database> } = {};

// Function to create a child database for a user
const createChildDatabase = async (userId: string): Promise<string> => {
  // Sanitize the userId to only include allowed characters (numbers, lowercase letters, and dashes)
  const sanitizedUserId = userId.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const dbName = `evolu-child-${sanitizedUserId}`;
  
  try {
    // First, get the parent database ID
    const parentDbResponse = await axios.get<TursoApiResponse>(
      `https://api.turso.tech/v1/organizations/${config.tursoOrgSlug}/databases/${config.tursoParentDb}`,
      {
        headers: {
          Authorization: `Bearer ${config.tursoApiToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    // eslint-disable-next-line no-console
    console.log("Parent DB Response:", parentDbResponse.data);

    // Create child database with parent's name as schema
    const createResponse = await axios.post(
      `https://api.turso.tech/v1/organizations/${config.tursoOrgSlug}/databases`,
      {
        name: dbName,
        group: "default",
        schema: "evolu-parent",
        location: "syd",
      },
      {
        headers: {
          Authorization: `Bearer ${config.tursoApiToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    // eslint-disable-next-line no-console
    console.log("Create DB Response:", createResponse.data);
    return dbName;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 409) {
        // Database already exists
        return dbName;
      }
      // eslint-disable-next-line no-console
      console.error("API Error Response:", {
        status: error.response?.status,
        data: error.response?.data,
        headers: error.response?.headers,
      });
    }
    throw new Error(`Failed to create database: ${error instanceof Error ? error.message : String(error)}`);
  }
};

// Function to create a database connection
const createDbConnection = (url: string): Kysely<Database> => {
  return new Kysely<Database>({
    dialect: new LibsqlDialect({
      url,
      authToken: config.tursoToken,
    }),
  });
};

// Function to get or create a database connection for a user
const getOrCreateDb = async (userId: string): Promise<Kysely<Database>> => {
  if (dbConnections[userId]) {
    return dbConnections[userId];
  }

  const dbName = await createChildDatabase(userId);
  const url = `libsql://${dbName}-${config.tursoOrgSlug}.turso.io`;
  const db = createDbConnection(url);

  dbConnections[userId] = db;
  return db;
};

export const createExpressApp: Effect.Effect<
  {
    app: Express;
    server: Server;
  },
  never,
  never
> = Effect.gen(function* (_) {
  // Initialize with parent database for schema
  const parentDb = createDbConnection(config.tursoUrl);

  const server = yield* _(
    Server.pipe(
      Effect.provide(ServerLive),
      Effect.provideService(Db, parentDb),
    ),
  );

  yield* _(server.initDatabase);

  const app = express();
  app.use(cors());
  app.use(bodyParser.raw({ limit: "20mb", type: "application/x-protobuf" }));

  app.post("/", (req, res) => {
    const request = SyncRequest.fromBinary(req.body as Uint8Array);
    const userId = request.userId;

    if (!userId) {
      res.status(401).send("Valid user ID is required");
      return;
    }

    void getOrCreateDb(userId).then((userDb) => {
      Effect.runCallback(server.sync(req.body as Uint8Array, socketUserMap), {
        onExit: Exit.match({
          onFailure: flow(
            Cause.failureOrCause,
            Either.match({
              onLeft: flow(
                Match.value,
                Match.tagsExhaustive({
                  BadRequestError: ({ error }) => {
                    res.status(400).send(JSON.stringify(error));
                  },
                }),
              ),
              onRight: (error) => {
                // eslint-disable-next-line no-console
                console.error("server error", error);
                res.status(500).send("Internal Server Error");
              },
            }),
          ),
          onSuccess: (buffer) => {
            res.setHeader("Content-Type", "application/x-protobuf");
            res.send(buffer);
          },
        }),
      });
    }).catch((error) => {
      // eslint-disable-next-line no-console
      console.error("Database error:", error);
      res.status(500).send("Database error");
    });
  });

  return { app, server };
});

// Main startup function
export const createExpressAppWithWebsocket = async (
  port?: number,
): Promise<
  | { app: Express.Application; server: Server; wss: WebSocket.Server }
  | undefined
> => {
  try {
    const { app, server } = await Effect.runPromise(createExpressApp);

    const httpServer = createServer(app);
    const wss = new WebSocketServer({ server: httpServer });

    wss.on("connection", (ws) => {
      // Add new client to the list
      clients.push(ws);
      ws.on("message", (message: WebSocket.RawData) => {
        try {
          // Convert message to JSON if it is not already
          const json = JSON.parse((message as Buffer).toString("utf-8")) as {
            channelId: string;
          };
          if (json.channelId) {
            if (socketUserMap[json.channelId] !== undefined)
              socketUserMap[json.channelId]!.push(ws);
            else socketUserMap[json.channelId] = [ws];
            return;
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(
            "Error handling json request:",
            (err as Error)?.message || err,
          );
        }
        try {
          // Convert message to Uint8Array if it is not already
          let uint8ArrayMessage: Uint8Array;
          if (message instanceof Uint8Array) {
            uint8ArrayMessage = message;
          } else if (message instanceof ArrayBuffer) {
            uint8ArrayMessage = new Uint8Array(message);
          } else if (Array.isArray(message)) {
            uint8ArrayMessage = Buffer.concat(message);
          } else {
            uint8ArrayMessage = new Uint8Array(message);
          }

          Effect.runPromise(server.sync(uint8ArrayMessage, socketUserMap))
            .then((response) => ws.send(response))
            .catch((error) => {
              // eslint-disable-next-line no-console
              console.error("Error handling sync request:", error);

              ws.send(
                JSON.stringify({ error: "Failed to process sync request" }),
              );
            });
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error("Error handling sync request:", error);

          ws.send(JSON.stringify({ error: "Failed to process sync request" }));
        }
      });
    });

    const PORT = port || process.env.PORT || 4000;
    httpServer.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(
        `HTTP and WebSocket server started on http://localhost:${PORT}`,
      );
    });
    return { app, server, wss };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Failed to start the server:", error);
    throw error;
  }
  return undefined;
};
