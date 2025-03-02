/* eslint-disable no-unused-vars */
import { $ } from "execa";
import fs from "fs";
import path from "path";

import { type ICloudStorage, uploadFileBuffer } from "@/lib/cloud-storage";

interface BackupOptions {
  /**
   * The connection URL for the PostgreSQL database.
   */
  connectionUrl: string;

  /**
   * The name of the output file for the backup.
   */
  outputName: string;

  /**
   * Whether to print debug messages.
   */
  debug?: boolean;
}

/**
 * Find pg_dump in the system PATH
 */
async function findPgDump(): Promise<string> {
  try {
    const { stdout } = await $`which pg_dump`;
    return stdout.trim();
  } catch (error) {
    throw new Error(
      "pg_dump not found in system PATH. Please ensure PostgreSQL client tools are installed."
    );
  }
}

/**
 * Execute pg_dump command with retries and better error handling
 *
 * @param pgDumpPath Path to pg_dump executable
 * @param connectionUrl Database connection URL
 * @param outputPath Output file path
 * @param options Additional options
 * @returns Output of the command
 */
async function executePgDump(
  pgDumpPath: string,
  connectionUrl: string,
  outputPath: string,
  options: {
    debug?: boolean;
    timeout?: number;
    maxRetries?: number;
    retryDelayMs?: number;
  } = {}
): Promise<{ stdout: string; stderr: string }> {
  console.log(`executePgDump: Starting with timeout ${options.timeout || 15 * 60 * 1000}ms`);

  const { debug = false, timeout = 15 * 60 * 1000, maxRetries = 2, retryDelayMs = 5000 } = options;

  let lastError: any = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const attemptStartTime = Date.now();
      console.log(
        `executePgDump: Attempt ${attempt + 1}/${
          maxRetries + 1
        } starting at ${new Date().toISOString()}`
      );

      if (attempt > 0) {
        console.log(`Retry attempt ${attempt}/${maxRetries} for pg_dump operation...`);
        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }

      // Add performance optimizations: -Z0 (no compression), -j 4 (parallel jobs)
      // Use custom format (-Fc) for better performance and compression
      const pgDumpCommand = `${pgDumpPath} ${connectionUrl} -v -Fc -f ${outputPath}`;

      if (debug) {
        console.log(`Executing pg_dump command: ${pgDumpCommand}`);
      }

      console.log(`executePgDump: About to execute pg_dump command at ${new Date().toISOString()}`);

      // Execute pg_dump with verbose output and custom format
      const result = await $({
        timeout,
        stderr: "pipe", // Ensure we capture stderr
        stdout: "pipe", // Ensure we capture stdout
        reject: false, // Don't reject on non-zero exit code, we'll handle it
      })`${pgDumpPath} ${connectionUrl} -v -Fc -f ${outputPath}`;

      const execEndTime = Date.now();
      const execDuration = (execEndTime - attemptStartTime) / 1000;
      console.log(
        `executePgDump: Command completed in ${execDuration.toFixed(2)}s with exit code ${
          result.exitCode
        }`
      );

      // Check for success
      if (result.exitCode !== 0) {
        throw new Error(`pg_dump failed with exit code ${result.exitCode}: ${result.stderr}`);
      }

      return result;
    } catch (error: any) {
      lastError = error;
      console.error(`pg_dump attempt ${attempt + 1}/${maxRetries + 1} failed:`, error.message);

      // Check if it's a timeout or a fatal error that shouldn't be retried
      if (error.name === "AbortError" || error.message.includes("timeout")) {
        console.error("Timeout occurred during pg_dump operation");
        // For timeouts, we'll retry
      } else if (
        error.stderr &&
        (error.stderr.includes("connection to server was lost") ||
          error.stderr.includes("could not connect to server"))
      ) {
        console.error("Connection error during pg_dump, will retry");
        // For connection issues, we'll retry
      } else if (error.code === "ENOENT") {
        // If pg_dump executable not found, don't retry
        throw new Error(`pg_dump executable not found at ${pgDumpPath}`);
      } else if (error.code && error.code !== 1) {
        // For non-standard exit codes, don't retry
        throw error;
      }

      // If this was the last retry, throw the error
      if (attempt === maxRetries) {
        throw error;
      }
    }
  }

  // This should never be reached due to the throw in the loop above
  throw lastError || new Error("Unknown error during pg_dump execution");
}

/**
 * Backup a PostgreSQL database using pg_dump with plain text format.
 *
 * @param {BackupOptions} options - The options for the backup operation.
 */
export async function backupPostgresDatabase({
  connectionUrl,
  outputName,
  debug = false,
}: BackupOptions): Promise<string> {
  // Always log this operation regardless of debug flag
  console.log(`Starting database backup operation with pg_dump...`);
  const startTime = Date.now();

  // Log operation stages with timestamps
  const logStage = (stage: string) => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[${elapsed}s] Backup stage: ${stage}`);
  };

  logStage("Initializing");
  try {
    // Ensure outputName ends with .sql and remove any path separators
    const timestamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0];
    const cleanFileName = outputName.replace(/[/\\]/g, "-");
    const sqlFileName = cleanFileName.endsWith(".sql") ? cleanFileName : `${cleanFileName}.sql`;
    const backupFileName = `backup-${timestamp}-${sqlFileName}`;
    const outputPath = path.join(process.cwd(), "public/uploads", backupFileName);

    // Ensure the uploads directory exists
    await fs.promises.mkdir(path.join(process.cwd(), "public/uploads"), { recursive: true });

    // Find pg_dump in system PATH
    const pgDumpPath = await findPgDump();
    if (debug) {
      console.log("Using pg_dump from:", pgDumpPath);
    }

    // Parse connection URL to extract database size information
    const dbUrl = new URL(connectionUrl.replace("postgres://", "http://"));
    const dbName = dbUrl.pathname.substring(1); // Remove leading slash

    // Always log the database name for troubleshooting
    console.log(`Target database for backup: ${dbName}`);
    logStage("Parsed connection URL");

    // Create a controller for aborting the operation if needed
    const controller = new AbortController();
    const { signal } = controller;

    // Set a timeout (15 minutes) for the pg_dump process
    const timeout = setTimeout(
      () => {
        controller.abort();
        console.error("pg_dump operation timed out after 15 minutes");
      },
      15 * 60 * 1000
    );

    try {
      logStage("Starting pg_dump execution");

      // Execute pg_dump with retries and better error handling
      const { stdout, stderr } = await executePgDump(pgDumpPath, connectionUrl, outputPath, {
        debug: true, // Always enable debug for troubleshooting
        timeout: 15 * 60 * 1000,
        maxRetries: 2,
      });

      logStage("pg_dump execution completed");

      clearTimeout(timeout);

      if (debug) {
        console.log("Backup stdout:", stdout);
        console.log("Backup stderr:", stderr);
      }

      // Verify file exists and has content
      const fileStats = await fs.promises.stat(outputPath);
      if (fileStats.size === 0) {
        throw new Error("Backup file is empty. The pg_dump command may have failed silently.");
      }

      console.log(
        `Database backup completed successfully: ${backupFileName} (${fileStats.size} bytes)`
      );
      return backupFileName;
    } catch (execError: any) {
      clearTimeout(timeout);

      // Add more context to the error
      if (execError.stderr) {
        console.error("pg_dump stderr:", execError.stderr);
      }

      if (execError.code) {
        console.error(`pg_dump exited with code ${execError.code}`);
      }

      // If timed out, provide a clearer error
      if (execError.name === "AbortError" || signal.aborted) {
        throw new Error(
          "Database backup operation timed out. The database might be too large or the server might be under heavy load."
        );
      }

      throw new Error(`Database backup failed: ${execError.message}`);
    }
  } catch (error) {
    console.error("Error backing up database:", error);
    throw error;
  }
}

export type StorageUploadOptions = {
  storage: ICloudStorage;
  debug?: boolean;
};

export type BackupAndUploadOptions = BackupOptions & StorageUploadOptions;

export interface BackupProgressCallback {
  message: string;
  percent: number;
}

/**
 * Test a direct connection to the PostgreSQL database
 *
 * @param connectionUrl Database connection URL
 * @returns Connection test result
 */
async function testDatabaseConnection(
  connectionUrl: string
): Promise<{ success: boolean; message: string; error?: any }> {
  console.log(`Testing direct database connection...`);
  try {
    const { Pool } = await import("pg");

    // Create a client with a short timeout for testing
    const testPool = new Pool({
      connectionString: connectionUrl,
      connectionTimeoutMillis: 5000, // 5 seconds for test
    });

    try {
      // Try to connect and run a simple query
      const client = await testPool.connect();
      try {
        const result = await client.query("SELECT 1 as test");
        console.log(`Database connection test successful: ${result.rows[0].test}`);
        return { success: true, message: "Connection successful" };
      } finally {
        client.release();
      }
    } finally {
      await testPool.end();
    }
  } catch (error: any) {
    console.error(`Database connection test failed:`, error);
    return { success: false, message: `Connection failed: ${error.message}`, error };
  }
}

/**
 * Check the size of a PostgreSQL database
 *
 * @param connectionUrl Database connection URL
 * @param debug Enable debug logging
 * @returns Database size in bytes and tables count
 */
async function checkDatabaseSize(
  connectionUrl: string,
  debug = false
): Promise<{ sizeBytes: number; tablesCount: number }> {
  try {
    // Parse connection URL to extract database name
    const dbUrl = new URL(connectionUrl.replace("postgres://", "http://"));
    const dbName = dbUrl.pathname.substring(1); // Remove leading slash

    if (debug) {
      console.log(`Checking size of database: ${dbName}`);
    }

    // Create a temporary connection to the database
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: connectionUrl });

    try {
      // Query to get database size
      const sizeResult = await pool.query(
        `
        SELECT pg_database_size($1) as size
      `,
        [dbName]
      );

      // Query to get tables count
      const tablesResult = await pool.query(`
        SELECT count(*) as tables_count 
        FROM information_schema.tables 
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      `);

      const sizeBytes = parseInt(sizeResult.rows[0].size, 10);
      const tablesCount = parseInt(tablesResult.rows[0].tables_count, 10);

      if (debug) {
        console.log(
          `Database size: ${(sizeBytes / (1024 * 1024)).toFixed(2)} MB, Tables: ${tablesCount}`
        );
      }

      return { sizeBytes, tablesCount };
    } finally {
      // Close the connection pool
      await pool.end();
    }
  } catch (error) {
    console.error("Error checking database size:", error);
    // Return default values if we can't check the size
    return { sizeBytes: 0, tablesCount: 0 };
  }
}

export async function backupAndUploadDatabase({
  connectionUrl,
  outputName,
  storage,
  debug = false,
  onProgress = (_progress: { message: string; percent: number }) => {},
}: BackupAndUploadOptions & { onProgress?: (progress: BackupProgressCallback) => void }): Promise<{
  provider: string;
  url: string;
}> {
  let backupFileName: string | undefined;
  let outputPath: string | undefined;

  try {
    // First test the direct database connection
    onProgress({ message: "Testing database connection...", percent: 2 });
    const connectionTest = await testDatabaseConnection(connectionUrl);

    if (!connectionTest.success) {
      throw new Error(`Database connection test failed: ${connectionTest.message}`);
    }

    onProgress({ message: "Database connection successful, analyzing size...", percent: 5 });

    // Check database size to estimate backup time
    const { sizeBytes, tablesCount } = await checkDatabaseSize(connectionUrl, debug);

    // Adjust timeout based on database size
    // Base timeout: 20 minutes
    // Add 1 minute per 100MB, with a minimum of 20 minutes and maximum of 45 minutes
    const sizeInMB = sizeBytes / (1024 * 1024);
    const estimatedMinutes = Math.min(45, Math.max(20, 20 + Math.floor(sizeInMB / 100)));
    const timeoutMs = estimatedMinutes * 60 * 1000;

    console.log(`Database size: ${sizeInMB.toFixed(2)} MB, Tables: ${tablesCount}`);
    console.log(`Setting backup timeout to ${estimatedMinutes} minutes based on database size`);

    // Create backup with timeout
    onProgress({
      message: `Starting database backup (${sizeInMB.toFixed(2)} MB, ${tablesCount} tables)...`,
      percent: 10,
    });
    const backupPromise = backupPostgresDatabase({ connectionUrl, outputName, debug });
    backupFileName = await Promise.race([
      backupPromise,
      new Promise<never>((_, reject) => {
        setTimeout(
          () =>
            reject(
              new Error(`Database backup operation timed out after ${estimatedMinutes} minutes`)
            ),
          timeoutMs
        );
      }),
    ]);

    onProgress({ message: "Database backup completed, preparing for upload...", percent: 50 });
    outputPath = path.join(process.cwd(), "public/uploads", backupFileName);

    // Check if file exists and has content
    const stats = await fs.promises.stat(outputPath);
    if (stats.size === 0) {
      throw new Error("Backup file is empty, possibly a failed backup operation");
    }

    // Upload to cloud storage with timeout
    onProgress({ message: "Reading backup file...", percent: 60 });
    const fileBuffer = await fs.promises.readFile(outputPath);

    onProgress({ message: "Uploading to cloud storage...", percent: 70 });
    const uploadPromise = uploadFileBuffer(fileBuffer, backupFileName, {
      storage,
      debug,
    });

    const { publicUrl, provider } = await Promise.race([
      uploadPromise,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Cloud storage upload operation timed out")), timeoutMs);
      }),
    ]);

    onProgress({ message: "Upload completed successfully", percent: 100 });
    console.log(`Database backup uploaded to cloud storage: ${backupFileName}`);

    return { provider, url: publicUrl };
  } catch (error) {
    console.error("Error in backup and upload process:", error);
    throw error;
  } finally {
    // Clean up local backup file
    if (outputPath) {
      try {
        // Comment out to keep files for debugging
        // await fs.promises.unlink(outputPath);
      } catch (error) {
        console.error("Error cleaning up backup file:", error);
      }
    }
  }
}

export * from "./utils";
