/* eslint-disable no-unused-vars */
import type { ApiKey } from "@prisma/client";
import chalk from "chalk";
import cookieParser from "cookie-parser";
import express from "express";
import type { Session, User } from "lucia";
import path from "path";
import swaggerJSDoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";
import { fileURLToPath } from "url";
import { z } from "zod";

import { env } from "@/env";
import { validateSession, verifyRequest } from "@/lib/auth";
import { createInitialPlans } from "@/modules/plan/plans";
import { initWorkspacePermissions } from "@/modules/workspace";
import { apiRouter } from "@/routes/api";
import { authRouter } from "@/routes/auth";
import { pageRouter } from "@/routes/pages";

import { swaggerOptions } from "./config";
import { fetchListAIModels } from "./lib/ai/models";
import { DEFAULT_TIMEOUT } from "./modules/databases";
import { polarWebhookRouter } from "./routes/webhooks/polar-webhook";

declare global {
  namespace Express {
    interface Locals {
      user: User | null;
      userId: string | null;
      apiKey: ApiKey | null;
      session: Session | null;
      csrfToken: string;
    }
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// sync subscription plans in database with Polar
createInitialPlans();
// syncPlans();

const app = express();

// trust cloudflare proxy
app.set("trust proxy", ["loopback", "linklocal", "uniquelocal"]);

// webhooks
// NOTE: webhooks should be the first middleware because it handles raw request body
app.use(polarWebhookRouter);

// url encoded & body parser
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// template engine: EJS
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");

// assets
app.use(express.static(path.join(__dirname, "../public")));

// API routes
app.use(apiRouter);

// auth middleware: verify request origin & validate session
app.use(verifyRequest);
app.use(validateSession);

// routes
app.use(authRouter);
app.use(pageRouter);

// swagger
const specs = swaggerJSDoc(swaggerOptions());
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(specs));

// error handler
app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(chalk.red(`server.ts > error handler > Server error:`, error));
  if (error instanceof z.ZodError) {
    return res.status(400).json({
      error: `Validation error: ${error.errors
        .map((e) => `${e.path.join(".")}: ${e.message}`)
        .join(", ")}`,
    });
  }
  return res.status(500).json({ error: `Internal server error: ${error.message}` });
});

// start server
async function startServer() {
  await initWorkspacePermissions();
  await fetchListAIModels({ debug: true });

  const server = app.listen(env.PORT, () => {
    console.log(chalk.green(`🚀 Server running on port ${env.PORT}`));
  });

  // Set a 60 minutes timeout for incoming requests
  server.setTimeout(DEFAULT_TIMEOUT);
  console.log(`Server timeout set to 60 minutes for long-running operations`);

  // Handle graceful shutdown
  process.on("SIGTERM", async () => {
    console.log("SIGTERM received. Closing browser pool and shutting down gracefully");
    // ... (other cleanup tasks)
    process.exit(0);
  });
}

// start server
startServer().catch(console.error);
