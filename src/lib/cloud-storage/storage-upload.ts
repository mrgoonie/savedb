import type { PutObjectCommandInput } from "@aws-sdk/client-s3";
import { ListBucketsCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@aws-sdk/node-http-handler";

import { env } from "@/env";

import { getImageBufferFromUrl, readFileToBuffer } from "../utils/image";
import {
  getUploadFileOriginEndpointUrl,
  getUploadFilePublicUrl,
  guessMimeTypeByBuffer,
} from "./helper";
import type { CloudStorageProvider, StorageUploadOptions } from "./types";
import type { ICloudStorage } from "./types";

export function getCurrentStorage(): ICloudStorage {
  return {
    provider: "cloudflare",
    region: "auto",
    bucket: env.CLOUDFLARE_CDN_BUCKET_NAME,
    accessKey: env.CLOUDFLARE_CDN_ACCESS_KEY,
    secretKey: env.CLOUDFLARE_CDN_SECRET_KEY,
    endpoint: env.CLOUDFLARE_CDN_ENDPOINT_URL,
    baseUrl: env.CLOUDFLARE_CDN_BASE_URL,
    basePath: `/${env.CLOUDFLARE_CDN_PROJECT_NAME}/${env.NODE_ENV}`,
  };
}

export async function initStorage(storage: ICloudStorage) {
  const s3 = new S3Client({
    region: storage.region,
    endpoint: storage.endpoint || `https://${storage.accessKey}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: storage.accessKey,
      secretAccessKey: storage.secretKey,
    },
    forcePathStyle: true,
    retryMode: "standard",
    maxAttempts: 5,
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 300000, // 5 minutes
      socketTimeout: 300000, // 5 minutes
    }),
  });

  return s3;
}

export async function listBuckets(storage: ICloudStorage) {
  const s3 = await initStorage(storage);

  const response = await s3.send(new ListBucketsCommand({}));

  return response.Buckets;
}

export async function uploadFileBuffer(
  buffer: Buffer,
  destFileName: string,
  options?: StorageUploadOptions
): Promise<{
  path: string;
  storageUrl: string;
  publicUrl: string;
  provider: CloudStorageProvider;
}> {
  console.log(`Starting file upload: ${destFileName} (${buffer.length} bytes)`);
  const startTime = Date.now();
  const { storage = getCurrentStorage() } = options || {};
  if (!storage) throw new Error("Storage is not defined");

  if (destFileName.startsWith("/")) destFileName = destFileName.slice(1);

  const path = destFileName.replace(/[^a-zA-Z0-9-_.]/g, "");
  if (options?.debug) console.log("uploadFileBuffer :>>", { storage });
  const s3 = await initStorage(storage);

  const mimeType = guessMimeTypeByBuffer(buffer) || "application/octet-stream";
  if (options?.debug) console.log("uploadFileBuffer :>>", { mimeType });

  if (options?.debug) console.log("uploadFileBuffer :>>", { path });

  const uploadParams: PutObjectCommandInput = {
    Bucket: storage.bucket,
    Key: `${env.CLOUDFLARE_CDN_PROJECT_NAME}/${path}`,
    Body: buffer,
    ContentType: mimeType,
    CacheControl: "max-age=31536000, s-maxage=31536000",
  };

  if (options?.debug) console.log("uploadFileBuffer :>>", { uploadParams });

  try {
    console.log(`Sending file to cloud storage: ${destFileName}`);
    const uploadStartTime = Date.now();

    const data = await s3.send(new PutObjectCommand(uploadParams));

    const uploadDuration = (Date.now() - uploadStartTime) / 1000;
    console.log(`File upload completed in ${uploadDuration.toFixed(2)}s: ${destFileName}`);

    if (options?.debug) console.log("uploadFileBuffer :>>", { data });

    const response = {
      provider: storage.provider,
      path,
      storageUrl: getUploadFileOriginEndpointUrl(storage, destFileName),
      publicUrl: getUploadFilePublicUrl(storage, destFileName),
    };
    if (options?.debug) console.log("uploadFileBuffer :>>", { response });
    const totalDuration = (Date.now() - startTime) / 1000;
    console.log(`Total upload process completed in ${totalDuration.toFixed(2)}s: ${destFileName}`);
    return response;
  } catch (error) {
    const failureDuration = (Date.now() - startTime) / 1000;
    console.error(`Upload failed after ${failureDuration.toFixed(2)}s: ${destFileName}`);

    if (error instanceof Error) {
      console.error("Upload error:", error.message);
      if ("code" in error) {
        console.error("Error code:", (error as any).code);
      }
    }
    throw error;
  }
}

export async function uploadFileURL(
  url: string,
  destFileName: string,
  options?: StorageUploadOptions
) {
  const buffer = await getImageBufferFromUrl(url);
  if (options?.debug) console.log("uploadFileURL :>>", { buffer });
  if (!buffer) throw new Error(`Unable to get image buffer from "${url}"`);
  return uploadFileBuffer(buffer, destFileName, options);
}

export async function uploadFilePath(
  filePath: string,
  destFileName: string,
  options?: StorageUploadOptions
) {
  const buffer = readFileToBuffer(filePath);
  if (!buffer) throw new Error(`Unable to get image buffer from "${filePath}"`);
  return uploadFileBuffer(buffer, destFileName, options);
}
