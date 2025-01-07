/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { createClient } from "@libsql/client";
import axios, { AxiosError } from "axios";
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
import { Logger } from "effect/Logger";
import Stripe from "stripe";
import { createClient as createTursoClient } from "@tursodatabase/api";
import type { DatabaseUsage, Database as TursoDatabase } from "@tursodatabase/api";

// Type guard for Stripe Customer
const isStripeCustomer = (customer: unknown): customer is Stripe.Customer => {
  return typeof customer === 'object' && customer !== null && !('deleted' in customer);
};

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
  stripeSecretKey: getRequiredEnvVar("STRIPE_SECRET_KEY"),
} as const;

// Initialize Stripe
const stripe = new Stripe(config.stripeSecretKey, {
  apiVersion: '2024-12-18.acacia',
  typescript: true,
});

// Initialize Turso auth client
const turso = createTursoClient({
  org: "ibb2",
  token: config.tursoApiToken,
});

// Plan limits in GB
const PLAN_LIMITS = {
  basic: 0.5,
  plus: 2,
  pro: 10,
} as const;

type PlanType = keyof typeof PLAN_LIMITS;

// Function to get database size in GB
const getDatabaseSize = async (dbName: string): Promise<number> => {
  try {
    const db: DatabaseUsage = await turso.databases.usage(dbName);

    if (db.instances.length === 0) {
      throw new Error('Invalid auth database response');
    }

    return db.usage.storage_bytes / (1024 * 1024 * 1024);
  } catch (err) {
    if (err instanceof Error) {
      Effect.logError("Error getting database size", { error: err.message });
      throw new Error(`Failed to get database size: ${err.message}`);
    }
    throw err;
  }
};

// Function to get user's subscription plan
const getUserSubscriptionPlan = async (userId: string): Promise<PlanType> => {
  try {
    // Get user from auth database
    const authDb = await turso.databases.get(config.tursoParentDb);

    const client = createClient({
      url: `libsql://${authDb.hostname}`,
      authToken: config.tursoToken,
    });

    // Get user by evoluId
    const result = await client.execute({
      sql: "SELECT stripeCustomerId FROM users WHERE evoluId = ?",
      args: [userId],
    });

    const stripeCustomerId = result.rows?.[0]?.stripeCustomerId;
    if (!stripeCustomerId || typeof stripeCustomerId !== 'string') {
      return 'basic';
    }

    try {
      // Get customer's subscription from Stripe
      const customerResponse = await stripe.customers.retrieve(stripeCustomerId, {
        expand: ['subscriptions'],
      });

      if (!isStripeCustomer(customerResponse)) {
        return 'basic';
      }

      const subscription = customerResponse.subscriptions?.data[0];
      if (!subscription?.items.data[0]?.price.nickname) {
        return 'basic';
      }

      const planName = subscription.items.data[0].price.nickname.toLowerCase();
      if (planName.includes('pro')) {
        return 'pro';
      } else if (planName.includes('plus')) {
        return 'plus';
      }
    } catch (err) {
      if (err instanceof Error) {
        Effect.logError("Error getting Stripe subscription", { error: err.message });
      }
    }
    
    return 'basic';
  } catch (err) {
    if (err instanceof Error) {
      Effect.logError("Error getting subscription plan", { error: err.message });
    }
    return 'basic';
  }
};

// Function to check if user can sync based on their plan and database size
const canUserSync = async (userId: string, dbName: string): Promise<boolean> => {
  try {
    const [plan, dbSize] = await Promise.all([
      getUserSubscriptionPlan(userId),
      getDatabaseSize(dbName),
    ]);

    const sizeLimit = PLAN_LIMITS[plan];
    return dbSize < sizeLimit;
  } catch (err) {
    if (err instanceof Error) {
      Effect.logError("Error checking sync eligibility", { error: err.message });
      throw new Error(`Failed to check sync eligibility: ${err.message}`);
    }
    throw err;
  }
};

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
      const checkDbResponse = await axios.get(
        `https://api.turso.tech/v1/organizations/${config.tursoOrgSlug}/databases/${dbName}`,
        {
          headers: {
            Authorization: `Bearer ${config.tursoApiToken}`,
            "Content-Type": "application/json",
          },
        }
      );
      
      // If we get here, database exists, get a token and return
      const tokenResponse = await axios.post(
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
    try {
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
    } catch (createError) {
      // If database already exists (409), just continue to get token
      if (!(axios.isAxiosError(createError) && createError.response?.status === 409)) {
        throw createError;
      }
    }
    
    // Wait for database to be ready
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Get a new auth token for the child database
    const tokenResponse = await axios.post(
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

    const sanitizedUserId = userId.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const dbName = `evolu-${sanitizedUserId}`;

    canUserSync(userId, dbName).then(async (canSync) => {
      if (!canSync) {
        res.status(402).send(JSON.stringify({
          _tag: "SyncStateIsNotSynced",
          error: { _tag: "PaymentRequiredError" }
        }));
        return;
      }

      try {
        const userDb = await getOrCreateDb(userId);
        Effect.logDebug("User DB created", { schema: userDb.schema });
        
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
                  Effect.logError("Server error", { error });
                  res.status(500).send(JSON.stringify({
                    _tag: "SyncStateIsNotSynced",
                    error: { _tag: "ServerError", status: 500 }
                  }));
                },
              }),
            ),
            onSuccess: (buffer) => {
              res.setHeader("Content-Type", "application/x-protobuf");
              res.send(buffer);
            },
          }),
        });
      } catch (err) {
        const error = err as Error;
        Effect.logError("Server initialization error", { error: error.message });
        res.status(500).send(JSON.stringify({
          _tag: "SyncStateIsNotSynced",
          error: { _tag: "ServerError", status: 500 }
        }));
      }
    }).catch((err) => {
      const error = err as Error;
      Effect.logError("Subscription check error", { error: error.message });
      res.status(500).send(JSON.stringify({
        _tag: "SyncStateIsNotSynced",
        error: { _tag: "ServerError", status: 500 }
      }));
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
      
      ws.on("message", (message: WebSocket.RawData) => {
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
              const error = err as Error;
              Effect.logError("JSON parsing error", { error: error.message });
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
            Effect.logDebug("WebSocket sync request", {
              userId: request.userId,
              messageCount: request.messages.length
            });

            void Effect.runPromise(
              server.sync(uint8ArrayMessage, socketUserMap)
            ).then((response) => {
              // Validate response before sending
              if (!(response instanceof Buffer)) {
                throw new Error("Invalid response type");
              }
              
              ws.send(response);
            }).catch((err) => {
              const error = err as Error;
              Effect.logError("Sync processing error", { error: error.message });
              ws.send(JSON.stringify({ 
                error: "Failed to process sync request",
                details: error.message
              }));
            });
          } catch (err) {
            const error = err as Error;
            Effect.logError("WebSocket message handling error", { error: error.message });
            ws.send(JSON.stringify({ 
              error: "Failed to handle message",
              details: error.message
            }));
          }
        } catch (err) {
          const error = err as Error;
          Effect.logError("WebSocket error", { error: error.message });
          ws.send(JSON.stringify({ 
            error: "Failed to handle message",
            details: error.message
          }));
        }
      });

      ws.on("error", (err) => {
        const error = err as Error;
        Effect.logError("WebSocket error", { error: error.message });
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
      Effect.logDebug("HTTP and WebSocket server started", { port: PORT });
    });
    return { app, server, wss };
  } catch (err) {
    const error = err as Error;
    Effect.logError("Failed to start the server", { error: error.message });
    throw error;
  }
  return undefined;
};
