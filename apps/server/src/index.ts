import "dotenv/config";
import { createExpressAppWithWebsocket } from "@evolu/server";

console.log("Starting server...");

createExpressAppWithWebsocket()
  .then((result) => {
    if (!result) {
      console.error("Failed to start server");
      process.exit(1);
    }
    console.log("Server started successfully");
  })
  .catch((err) => {
    console.error("Fatal error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
