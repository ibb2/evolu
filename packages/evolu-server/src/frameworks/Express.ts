/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import bodyParser from "body-parser";
import cors from "cors";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import * as Exit from "effect/Exit";
import { flow } from "effect/Function";
import * as Match from "effect/Match";
import express from "express";
import { Server, ServerLive } from "../Server.js";
import { Db } from "../Types.js";
import { createServer } from "http";
import { WebSocket, WebSocketServer } from "ws";
import { SyncRequest } from "@evolu/common";
import { xataDatabase } from "../utils/index.js";
import { canUserSync } from "../sync/index.js";

// Error handling helper
const getErrorMessage = (err: unknown): string => {
    if (err instanceof Error) return err.message;
    return String(err);
};

interface SocketMap {
    [key: string]: WebSocket[];
}

// Array to keep track of connected WebSocket clients
const clients: WebSocket[] = [];
const socketUserMap: SocketMap = {};

export interface ExpressApp {
    app: express.Express;
    server: Server;
}

export const createExpressApp: Effect.Effect<ExpressApp> = Effect.gen(function* (_) {

    // Database responsible for handling the sync
    const db = xataDatabase()

    // Initialize the parent database schema first
    const server = yield* _(Server.pipe(Effect.provide(ServerLive), Effect.provideService(Db, db)));

    // Initialize schema in parent database
    yield* _(server.initDatabase);

    const app = express();

    app.use(cors()); // Restrict access at later stage
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

            try {
                const canSync = await canUserSync(db, userId);

                if (!canSync) {
                    res.status(402).send(JSON.stringify({
                        _tag: "SyncStateIsNotSynced",
                        error: { _tag: "PaymentRequiredError" }
                    }));
                    return;
                }

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
})


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
