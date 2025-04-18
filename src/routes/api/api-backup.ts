import express from "express";
import { z } from "zod";

import { IsDev } from "@/config";
import { validateSession } from "@/lib/auth";
import { apiKeyAuth } from "@/middlewares/api_key_auth";
import {
  backupAndUploadDatabase,
  DEFAULT_TIMEOUT,
  generateBackupName,
} from "@/modules/databases/postgres";

// Database types enum - will be expanded in the future
export const DatabaseType = {
  POSTGRES: "postgres",
  // TODO: Add support for other databases
  // MYSQL: "mysql",
  // MONGODB: "mongodb",
} as const;

// Cloud storage providers
export const CloudStorageProvider = {
  AWS: "aws",
  CLOUDFLARE: "cloudflare",
  GOOGLE_DRIVE: "google_drive",
} as const;

// Database Backup API Router
// Tag: DatabaseBackup
export const apiDatabaseBackupRouter = express.Router();

// Zod schema for cloud storage configuration
const CloudStorageSchema = z.object({
  provider: z.nativeEnum(CloudStorageProvider),
  bucket: z.string(),
  region: z.string(),
  accessKey: z.string(),
  secretKey: z.string(),
  endpoint: z.string(),
  baseUrl: z.string().optional(),
  basePath: z.string().optional(),
});

// Zod schema for database backup creation
const DatabaseBackupRequestSchema = z.preprocess(
  (input) => {
    if (input && typeof input === "object" && (input as any).googleDrive) {
      // eslint-disable-next-line no-unused-vars
      const { storage, ...rest } = input as any;
      return rest;
    }
    return input;
  },
  z
    .object({
      name: z.string().optional(),
      databaseType: z.nativeEnum(DatabaseType),
      connectionUrl: z.string(),
      storage: CloudStorageSchema.optional(),
      googleDrive: z
        .object({
          folderId: z.string().optional(),
          isPublic: z.boolean().optional(),
          sharedEmails: z.array(z.string().email()).optional(),
          serviceAccount: z
            .object({
              client_email: z.string(),
              private_key: z.string(),
            })
            .optional(),
        })
        .optional(),
    })
    .refine((data) => data.storage || data.googleDrive, {
      message: "Either storage or googleDrive must be provided",
    })
);

/**
 * @openapi
 * components:
 *   schemas:
 *     DatabaseType:
 *       type: string
 *       enum: [postgres]
 *       description: Type of database to backup (currently only postgres is supported)
 *     CloudStorageProvider:
 *       type: string
 *       enum: [cloudflare, aws, do, google_drive]
 *       description: Cloud storage provider for storing backups
 *     GoogleDrive:
 *       type: object
 *       properties:
 *         provider:
 *           $ref: '#/components/schemas/CloudStorageProvider'
 *         folderId:
 *           type: string
 *           description: Google Drive folder ID
 *         isPublic:
 *           type: boolean
 *           description: Whether the file should be made public
 *         sharedEmails:
 *           type: array
 *           items:
 *             type: string
 *             format: email
 *           description: Email addresses to share the file with
 *         serviceAccount:
 *           type: object
 *           properties:
 *             type:
 *               type: string
 *               description: Type of service account
 *             projectId:
 *               type: string
 *               description: Project ID of service account
 *             private_key:
 *               type: string
 *               description: Private key of service account
 *             client_email:
 *               type: string
 *               description: Client email of service account
 *     CloudStorage:
 *       type: object
 *       properties:
 *         provider:
 *           $ref: '#/components/schemas/CloudStorageProvider'
 *         bucket:
 *           type: string
 *           description: Storage bucket name
 *         region:
 *           type: string
 *           description: Storage region
 *         accessKey:
 *           type: string
 *           description: Storage access key
 *         secretKey:
 *           type: string
 *           description: Storage secret key
 *         endpoint:
 *           type: string
 *           description: Custom endpoint URL
 *         baseUrl:
 *           type: string
 *           description: Base URL for accessing files (optional)
 *         basePath:
 *           type: string
 *           description: Base path prefix for files (optional)
 *       required:
 *         - provider
 *         - bucket
 *         - region
 *         - accessKey
 *         - secretKey
 *         - endpoint
 *     DatabaseBackupCreate:
 *       type: object
 *       properties:
 *         name:
 *           type: string
 *           description: Name of the backup (optional, will be auto-generated if not provided)
 *         databaseType:
 *           $ref: '#/components/schemas/DatabaseType'
 *         connectionUrl:
 *           type: string
 *           description: Database connection URL
 *         storage:
 *           $ref: '#/components/schemas/CloudStorage'
 *         googleDrive:
 *           $ref: '#/components/schemas/GoogleDrive'
 *       required:
 *         - databaseType
 *         - connectionUrl
 *         - storage
 */

/**
 * @openapi
 * /api/v1/database-backup:
 *   post:
 *     summary: Create a database backup and upload to cloud storage
 *     tags:
 *       - DatabaseBackup
 *     security:
 *       - ApiKeyAuth: []
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/DatabaseBackupCreate'
 *     responses:
 *       201:
 *         description: Database backup created and uploaded successfully
 *       400:
 *         description: Invalid backup data
 *       500:
 *         description: Failed to create backup
 */
apiDatabaseBackupRouter.post("/", validateSession, apiKeyAuth, async (req, res, next) => {
  // Set a longer timeout for this route (45 minutes)
  req.setTimeout(DEFAULT_TIMEOUT);

  // Check if client wants streaming updates
  const acceptsStreamingUpdates =
    req.headers.accept?.includes("text/event-stream") || req.query.stream === "true";

  try {
    const backupData = DatabaseBackupRequestSchema.parse(req.body);
    const backupName = backupData.name || generateBackupName(backupData.connectionUrl);
    const outputName = `${backupName}.dump`;

    // Handle different database types
    switch (backupData.databaseType) {
      case DatabaseType.POSTGRES: {
        if (acceptsStreamingUpdates) {
          // Setup for streaming updates
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });

          res.write("event: progress\n");
          res.write(
            `data: ${JSON.stringify({ progress: 0, message: "Starting backup process" })}\n\n`
          );

          try {
            // Invoke backup & upload, choosing Drive or generic storage
            let backupResult: { provider: string | undefined; url: string };
            if (backupData.googleDrive) {
              backupResult = await backupAndUploadDatabase({
                connectionUrl: backupData.connectionUrl,
                outputName,
                googleDrive: backupData.googleDrive,
                debug: IsDev(),
                onProgress: (progress) => {
                  res.write("event: progress\n");
                  res.write(`data: ${JSON.stringify(progress)}\n\n`);
                },
              });
            } else {
              backupResult = await backupAndUploadDatabase({
                connectionUrl: backupData.connectionUrl,
                outputName,
                storage: backupData.storage!,
                debug: IsDev(),
                onProgress: (progress) => {
                  res.write("event: progress\n");
                  res.write(`data: ${JSON.stringify(progress)}\n\n`);
                },
              });
            }
            const { provider, url } = backupResult;

            // Send completion event
            res.write("event: complete\n");
            res.write(
              `data: ${JSON.stringify({
                name: backupName,
                provider,
                url,
              })}\n\n`
            );

            // End the response
            res.end();
          } catch (error: any) {
            console.error("Streaming backup error:", error);

            // Prepare a user-friendly error message
            let errorMessage = error.message;
            let errorDetails = "";

            // Handle timeout errors specifically
            if (error.message.includes("timed out")) {
              errorMessage =
                "The database backup operation timed out. This may be due to the database size or server load.";
              errorDetails =
                "Consider breaking up your backup into smaller chunks or running during off-peak hours.";
            }

            // Send error event with more details
            res.write("event: error\n");
            res.write(
              `data: ${JSON.stringify({
                message: errorMessage,
                details: errorDetails,
                originalError: error.message,
              })}\n\n`
            );
            res.end();
          }
        } else {
          // Standard JSON response without streaming
          try {
            // Invoke backup & upload for JSON response
            let result: { provider: string | undefined; url: string };
            if (backupData.googleDrive) {
              result = await backupAndUploadDatabase({
                connectionUrl: backupData.connectionUrl,
                outputName,
                googleDrive: backupData.googleDrive,
                debug: IsDev(),
                onProgress: (progress) => {
                  console.log(`Backup progress: ${progress.percent}% - ${progress.message}`);
                },
              });
            } else {
              result = await backupAndUploadDatabase({
                connectionUrl: backupData.connectionUrl,
                outputName,
                storage: backupData.storage!,
                debug: IsDev(),
                onProgress: (progress) => {
                  console.log(`Backup progress: ${progress.percent}% - ${progress.message}`);
                },
              });
            }
            const { provider, url } = result;

            res.status(201).json({
              success: true,
              data: {
                name: backupName,
                provider,
                url,
              },
            });
          } catch (error: any) {
            console.error("Backup process error:", error);

            // Handle timeout errors with more specific messages
            if (error.message.includes("timed out")) {
              return res.status(504).json({
                success: false,
                error: {
                  message:
                    "The database backup operation timed out. This may be due to the database size or server load.",
                  details:
                    "Consider breaking up your backup into smaller chunks or running during off-peak hours.",
                  originalError: error.message,
                },
              });
            }

            throw error;
          }
        }
        break;
      }
      default:
        throw new Error(`Unsupported database type: ${backupData.databaseType}`);
    }
  } catch (error) {
    if (!res.headersSent) {
      next(error);
    } else {
      console.error("Error after headers sent:", error);
      if (error instanceof z.ZodError) {
        console.error(
          "Validation error details:",
          error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ")
        );
      }
    }
  }
});
