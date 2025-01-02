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

interface TursoTokenResponse {
  jwt: string;
}

interface TursoCreateResponse {
  database: {
    DbId: string;
    Hostname: string;
    Name: string;
  };
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

// Cache for database tokens
const dbTokens: { [dbName: string]: string } = {};

// Function to create a child database for a user
const createChildDatabase = async (userId: string) => {
  const sanitizedUserId = userId.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const dbName = `evolu-${sanitizedUserId}`;
  
  try {
    // First, check if the database already exists
    try {
      const checkDbResponse = await axios.get<TursoApiResponse>(
        `https://api.turso.tech/v1/organizations/${config.tursoOrgSlug}/databases/${dbName}`,
        {
          headers: {
            Authorization: `Bearer ${config.tursoApiToken}`,
            "Content-Type": "application/json",
          },
        }
      );
      
      // If database exists, still need to get a token
      const tokenResponse = await axios.post<TursoTokenResponse>(
        `https://api.turso.tech/v1/organizations/${config.tursoOrgSlug}/databases/${dbName}/auth/tokens`,
        {},
        {
          headers: {
            Authorization: `Bearer ${config.tursoApiToken}`,
            "Content-Type": "application/json",
          },
        }
      );
      
      dbTokens[dbName] = tokenResponse.data.jwt;
      return dbName;
    } catch (checkError) {
      // If error is not 404 (Not Found), rethrow it
      if (axios.isAxiosError(checkError) && checkError.response?.status !== 404) {
        throw checkError;
      }
      // If 404, continue with creation
    }
    
    // Create child database from parent
    const createResponse = await axios.post<TursoCreateResponse>(
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
    
    // Wait for database to be ready
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Get a new auth token for the child database
    const tokenResponse = await axios.post<TursoTokenResponse>(
      `https://api.turso.tech/v1/organizations/${config.tursoOrgSlug}/databases/${dbName}/auth/tokens`,
      {},
      {
        headers: {
          Authorization: `Bearer ${config.tursoApiToken}`,
          "Content-Type": "application/json",
        },
      }
    );
    
    // Store the token for this database
    dbTokens[dbName] = tokenResponse.data.jwt;
    
    return dbName;
  } catch (error) {
    console.error("Database creation error:", error);
    if (axios.isAxiosError(error)) {
      console.error("API Error Response:", {
        status: error.response?.status,
        data: error.response?.data,
        headers: error.response?.headers,
      });
    }
    throw new Error(`Failed to create database: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const createDbConnection = (url: string, dbName?: string): Kysely<Database> => {
  const authToken = dbName !== undefined ? dbTokens[dbName] : config.tursoToken;
  
  if (!authToken) {
    throw new Error(`No authentication token found for database: ${dbName}`);
  }
  
  return new Kysely<Database>({
    dialect: new LibsqlDialect({
      url,
      authToken,
    }),
  });
};

const getOrCreateDb = async (userId: string): Promise<Kysely<Database>> => {
  if (dbConnections[userId]) {
    return dbConnections[userId];
  }
  
  const dbName = await createChildDatabase(userId);
  const url = `libsql://${dbName}-${config.tursoOrgSlug}.turso.io`;
  const db = createDbConnection(url, dbName);
  dbConnections[userId] = db;
  
  // Verify connection works
  try {
    const result = await db.selectFrom('message').selectAll().execute();
    console.log("Connection verified with message count:", result.length);
  } catch (error) {
    console.error("Failed to verify database connection:", error);
    throw error;
  }
  
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

  // Initialize the parent database schema first
  const server = yield* _(
    Server.pipe(
      Effect.provide(ServerLive),
      Effect.provideService(Db, parentDb),
    ),
  );

  // Initialize schema in parent database
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


    void getOrCreateDb(userId).then(userDb => {
      console.log("✅ User DB created - ", userDb.schema);
    });
    
    void getOrCreateDb(userId).then(async (userDb) => {
      try {
        // Use the user's database for the sync operation
        const userServer = await Effect.runPromise(
          Server.pipe(
            Effect.provide(ServerLive),
            Effect.provideService(Db, userDb),
          ),
        );

        Effect.runCallback(userServer.sync(req.body as Uint8Array, socketUserMap), {
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
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("Server initialization error:", error);
        res.status(500).send("Server initialization error");
      }
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
      clients.push(ws);
      
      ws.on("message", async (message: WebSocket.RawData) => {
        try {
          // Handle JSON messages (channel registration)
          if (message instanceof Buffer && message[0] === "{".charCodeAt(0)) {
            try {
              const json = JSON.parse(message.toString("utf-8")) as {
                channelId: string;
              };
              if (json.channelId) {
                if (socketUserMap[json.channelId] !== undefined) {
                  socketUserMap[json.channelId]!.push(ws);
                } else {
                  socketUserMap[json.channelId] = [ws];
                }
                return;
              }
            } catch (err) {
              console.error("JSON parsing error:", err);
              ws.send(JSON.stringify({ error: "Invalid JSON message" }));
              return;
            }
          }

          // Handle binary messages (sync requests)
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

          try {
            // Validate sync request before processing
            const request = SyncRequest.fromBinary(uint8ArrayMessage);
            console.log("WebSocket sync request:", {
              userId: request.userId,
              messageCount: request.messages.length
            });

            const response = await Effect.runPromise(
              server.sync(uint8ArrayMessage, socketUserMap)
            );
            
            // Validate response before sending
            if (!(response instanceof Buffer)) {
              throw new Error("Invalid response type");
            }
            
            ws.send(response);
          } catch (error) {
            console.error("Sync processing error:", error);
            ws.send(JSON.stringify({ 
              error: "Failed to process sync request",
              details: error instanceof Error ? error.message : String(error)
            }));
          }
        } catch (error) {
          console.error("WebSocket message handling error:", error);
          ws.send(JSON.stringify({ 
            error: "Failed to handle message",
            details: error instanceof Error ? error.message : String(error)
          }));
        }
      });

      ws.on("error", (error) => {
        console.error("WebSocket error:", error);
      });

      ws.on("close", () => {
        // Remove from clients array
        const index = clients.indexOf(ws);
        if (index > -1) {
          clients.splice(index, 1);
        }
        
        // Remove from socketUserMap
        for (const userId in socketUserMap) {
          const sockets = socketUserMap[userId];
          if (sockets) {
            const socketIndex = sockets.indexOf(ws);
            if (socketIndex > -1) {
              sockets.splice(socketIndex, 1);
            }
            if (sockets.length === 0) {
              delete socketUserMap[userId];
            }
          }
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
