/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
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
import express from "express";
import { Kysely } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { Server, ServerLive } from "../Server.js";
import { Db, Database } from "../Types.js";
import { createServer } from "http";
import { WebSocket, WebSocketServer } from "ws";
import { SyncRequest } from "@evolu/common";
import Stripe from "stripe";
import { createClient as createTursoClient } from "@tursodatabase/api";

// Error handling helper
const getErrorMessage = (err: unknown): string => {
    if (err instanceof Error) return err.message;
    return String(err);
};

// Type definitions
type PlanType = 'basic' | 'plus' | 'pro';
interface DatabaseTokens {
  [key: string]: string;
}
interface DatabaseConnections {
  [key: string]: Kysely<Database>;
}
interface SocketMap {
  [key: string]: WebSocket[];
}
// Type guard for Stripe Customer
const isStripeCustomer = (customer: unknown): customer is Stripe.Customer => {
    return typeof customer === 'object' && customer !== null && !('deleted' in customer);
};
// Environment variables validation
const getRequiredEnvVar = (name: string): string => {
    const value = process.env[name];
    if (!value)
        throw new Error(`Missing required environment variable: ${name}`);
    return value;
};
const config = {
    tursoUrl: getRequiredEnvVar("TURSO_URL"),
    tursoToken: getRequiredEnvVar("TURSO_TOKEN"),
    tursoOrgSlug: getRequiredEnvVar("TURSO_ORG_SLUG"),
    tursoParentDb: getRequiredEnvVar("TURSO_PARENT_DB"),
    tursoApiToken: getRequiredEnvVar("TURSO_API_TOKEN"),
    stripeSecretKey: getRequiredEnvVar("STRIPE_SECRET_KEY"),
};
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
};
// Function to get database size in GB
const getDatabaseSize = async (dbName: string): Promise<number> => {
    try {
        const db = await turso.databases.usage(dbName);
        if (db.instances.length === 0) {
            throw new Error('Invalid auth database response');
        }
        const sizeInGB = db.usage.storage_bytes / (1024 * 1024 * 1024);
        console.log(`Database ${dbName} size: ${sizeInGB.toFixed(2)}GB`);
        return sizeInGB;
    }
    catch (err) {
        console.error("Error getting database size:", err instanceof Error ? err.message : String(err));
        throw err;
    }
};
// Function to get user's subscription plan
const getUserSubscriptionPlan = async (userId: string): Promise<PlanType> => {
    try {
        const authDb = await turso.databases.get(config.tursoParentDb);
        const client = createClient({
            url: 'http://127.0.0.1:8080'
        });

        const result = await client.execute({
            sql: "SELECT stripeCustomerId FROM user WHERE evoluOwnerId = ?",
            args: [userId],
        });

        const stripeCustomerId = result.rows?.[0]?.stripeCustomerId;
        if (!stripeCustomerId || typeof stripeCustomerId !== 'string') {
            return 'basic';
        }

        try {
            const customerResponse = await stripe.customers.retrieve(stripeCustomerId, {
                expand: ['subscriptions'],
            }) as Stripe.Response<Stripe.Customer>;

            if (!isStripeCustomer(customerResponse)) {
                return 'basic';
            }

            const subscription = customerResponse.subscriptions?.data[0];
            if (!subscription) {
                return 'basic';
            }

            const priceId = (subscription as Stripe.Subscription).items.data[0]?.price.id;
            if (!priceId) {
                return 'basic';
            }

            const price = await stripe.prices.retrieve(priceId);
            const lookupKey = price.lookup_key;
            
            if (lookupKey?.includes('pro')) {
                return 'pro';
            }
            else if (lookupKey?.includes('plus')) {
                return 'plus';
            }
            return 'basic';
        } catch (err) {
            console.error("Error getting Stripe subscription:", err instanceof Error ? err.message : String(err));
            return 'basic';
        }
    } catch (err) {
        console.error("Error getting subscription plan:", err instanceof Error ? err.message : String(err));
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
        const canSync = dbSize < sizeLimit;
        console.log(`User ${userId} sync check: plan=${plan}, size=${dbSize.toFixed(2)}GB, limit=${sizeLimit}GB, canSync=${canSync}`);
        return canSync;
    }
    catch (err) {
        console.error("Error checking sync eligibility:", err instanceof Error ? err.message : String(err));
        throw err;
    }
};
// Array to keep track of connected WebSocket clients
const clients: WebSocket[] = [];
const socketUserMap: SocketMap = {};
// Cache for database connections
const dbConnections: DatabaseConnections = {};
// Cache for database tokens
const dbTokens: DatabaseTokens = {};
// Function to create a child database for a user
const createChildDatabase = async (userId: string): Promise<string> => {
    const sanitizedUserId = userId.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const dbName = `evolu-${sanitizedUserId}`;
    try {
        // First, check if the database already exists
        try {
            const checkDbResponse = await axios.get(`https://api.turso.tech/v1/organizations/${config.tursoOrgSlug}/databases/${dbName}`, {
                headers: {
                    Authorization: `Bearer ${config.tursoApiToken}`,
                    "Content-Type": "application/json",
                },
            });
            // If we get here, database exists, get a token and return
            const tokenResponse = await axios.post(`https://api.turso.tech/v1/organizations/${config.tursoOrgSlug}/databases/${dbName}/auth/tokens`, {}, {
                headers: {
                    Authorization: `Bearer ${config.tursoApiToken}`,
                    "Content-Type": "application/json",
                },
            });
            dbTokens[dbName] = tokenResponse.data.jwt;
            return dbName;
        }
        catch (checkError) {
            // If error is not 404 (Not Found), rethrow it
            if (axios.isAxiosError(checkError) && checkError.response?.status !== 404) {
                throw checkError;
            }
            // If 404, continue with creation
        }
        // Create child database from parent
        try {
            const createResponse = await axios.post(`https://api.turso.tech/v1/organizations/${config.tursoOrgSlug}/databases`, {
                name: dbName,
                group: "default",
                schema: "evolu-parent",
                location: "syd",
            }, {
                headers: {
                    Authorization: `Bearer ${config.tursoApiToken}`,
                    "Content-Type": "application/json",
                },
            });
        }
        catch (createError) {
            // If database already exists (409), just continue to get token
            if (!(axios.isAxiosError(createError) && createError.response?.status === 409)) {
                throw createError;
            }
        }
        // Wait for database to be ready
        await new Promise(resolve => setTimeout(resolve, 2000));
        // Get a new auth token for the child database
        const tokenResponse = await axios.post(`https://api.turso.tech/v1/organizations/${config.tursoOrgSlug}/databases/${dbName}/auth/tokens`, {}, {
            headers: {
                Authorization: `Bearer ${config.tursoApiToken}`,
                "Content-Type": "application/json",
            },
        });
        // Store the token for this database
        dbTokens[dbName] = tokenResponse.data.jwt;
        return dbName;
    }
    catch (error) {
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
    return new Kysely({
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
    }
    catch (error) {
        console.error("Failed to verify database connection:", error);
        throw error;
    }
    return db;
};

export interface ExpressApp {
    app: express.Express;
    server: Server;
}

export const createExpressApp: Effect.Effect<ExpressApp> = Effect.gen(function* (_) {
    // Initialize with parent database for schema
    const parentDb = createDbConnection(config.tursoUrl);
    // Initialize the parent database schema first
    const server = yield* _(Server.pipe(Effect.provide(ServerLive), Effect.provideService(Db, parentDb)));
    // Initialize schema in parent database
    yield* _(server.initDatabase);
    const app = express();
    app.use(cors());
    app.use(bodyParser.raw({ limit: "20mb", type: "application/x-protobuf" }));
    app.post("/", (req, res) => {
        void (async () => {
            let body: Buffer;
            if (req.body instanceof Buffer) {
                body = req.body;
            } else if (req.body instanceof Uint8Array) {
                body = Buffer.from(req.body);
            } else if (typeof req.body === 'string') {
                body = Buffer.from(req.body);
            } else {
                res.status(400).send("Invalid request body type");
                return;
            }

            const request = SyncRequest.fromBinary(new Uint8Array(body));
            const userId = request.userId;

            if (!userId) {
                res.status(401).send("Valid user ID is required");
                return;
            }

            const sanitizedUserId = userId.toLowerCase().replace(/[^a-z0-9-]/g, '-');
            const dbName = `evolu-${sanitizedUserId}`;

            try {
                const userDb = await getOrCreateDb(userId);
                const canSync = await canUserSync(userId, dbName);
                
                if (!canSync) {
                    res.status(402).send(JSON.stringify({
                        _tag: "SyncStateIsNotSynced",
                        error: { _tag: "PaymentRequiredError" }
                    }));
                    return;
                }

                const userServer = await Effect.runPromise(Server.pipe(Effect.provide(ServerLive), Effect.provideService(Db, userDb)));

                Effect.runCallback(userServer.sync(new Uint8Array(body), socketUserMap), {
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
                res.status(500).send(JSON.stringify({
                    _tag: "SyncStateIsNotSynced",
                    error: { _tag: "ServerError", status: 500 }
                }));
            }
        })();
    });
    return { app, server };
}).pipe(Effect.provideService(Db, createDbConnection(config.tursoUrl)));
// Main startup function
export const createExpressAppWithWebsocket = async (port?: number): Promise<{ app: express.Express; server: Server; wss: WebSocketServer } | undefined> => {
    try {
        const { app, server } = await Effect.runPromise(createExpressApp);
        const httpServer = createServer(app);
        const wss = new WebSocketServer({ server: httpServer });

        wss.on("connection", (ws) => {
            clients.push(ws);
            ws.on("message", (message) => {
                try {
                    // Handle JSON messages (channel registration)
                    if (message instanceof Buffer && message[0] === "{".charCodeAt(0)) {
                        try {
                            const json = JSON.parse(message.toString("utf-8"));
                            if (json.channelId) {
                                if (socketUserMap[json.channelId] !== undefined) {
                                    socketUserMap[json.channelId].push(ws);
                                }
                                else {
                                    socketUserMap[json.channelId] = [ws];
                                }
                                return;
                            }
                        }
                        catch (err) {
                            console.error("JSON parsing error:", getErrorMessage(err));
                            ws.send(JSON.stringify({ error: "Invalid JSON message" }));
                            return;
                        }
                    }

                    // Handle binary messages (sync requests)
                    let uint8ArrayMessage: Uint8Array;
                    if (message instanceof Uint8Array) {
                        uint8ArrayMessage = message;
                    }
                    else if (message instanceof ArrayBuffer) {
                        uint8ArrayMessage = new Uint8Array(message);
                    }
                    else if (Array.isArray(message)) {
                        uint8ArrayMessage = Buffer.concat(message);
                    }
                    else {
                        uint8ArrayMessage = new Uint8Array(message);
                    }

                    // Validate sync request before processing
                    const request = SyncRequest.fromBinary(uint8ArrayMessage);
                    void Effect.runPromise(server.sync(uint8ArrayMessage, socketUserMap)).then((response) => {
                        if (!(response instanceof Buffer)) {
                            throw new Error("Invalid response type");
                        }
                        ws.send(response);
                    }).catch((err) => {
                        console.error("Sync processing error:", getErrorMessage(err));
                        ws.send(JSON.stringify({
                            error: "Failed to process sync request",
                            details: getErrorMessage(err)
                        }));
                    });
                }
                catch (err) {
                    console.error("WebSocket message handling error:", getErrorMessage(err));
                    ws.send(JSON.stringify({
                        error: "Failed to handle message",
                        details: getErrorMessage(err)
                    }));
                }
            });

            ws.on("error", (err) => {
                console.error("WebSocket error:", getErrorMessage(err));
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
            console.log("HTTP and WebSocket server started", { port: PORT });
        });
        return { app, server, wss };
    }
    catch (err) {
        console.error("Failed to start the server:", getErrorMessage(err));
        throw err;
    }
    return undefined;
};
