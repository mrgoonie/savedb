import type { drive_v3 } from "googleapis";
import { google } from "googleapis";
import { Readable } from "stream";

import { env } from "@/env";

export async function initializeDrive(serviceAccount?: {
  client_email: string;
  private_key: string;
}) {
  const keyFile = serviceAccount || JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
  const auth = new google.auth.JWT({
    email: keyFile.client_email,
    key: keyFile.private_key,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  await auth.authorize();
  const drive = google.drive({ version: "v3", auth });
  return drive;
}

/**
 * Upload a file buffer to Google Drive using a service account.
 * @param buffer - File data buffer
 * @param fileName - Desired file name in Drive
 * @param mimeType - MIME type of the file
 * @param folderId - (Optional) Drive folder ID to upload into
 * @returns Uploaded file ID and web view link
 */
export async function uploadFileToDrive(
  buffer: Buffer,
  fileName: string,
  options?: {
    mimeType?: string;
    folderId?: string;
    isPublic?: boolean;
    sharedEmails?: string[];
    serviceAccount?: { client_email: string; private_key: string };
  }
): Promise<{ id: string; webViewLink: string }> {
  const drive = await initializeDrive(options?.serviceAccount);
  const {
    mimeType = "application/octet-stream",
    folderId,
    isPublic = true,
    sharedEmails = [],
  } = options || {};

  const media = {
    mimeType,
    body: Readable.from(buffer),
  };

  const fileMetadata: drive_v3.Schema$File = { name: fileName };
  const parentId = folderId;
  if (parentId) {
    fileMetadata.parents = [parentId];
  }

  const response = await drive.files.create({
    requestBody: fileMetadata,
    media,
    fields: "id, webViewLink",
  });

  if (!response.data.id || !response.data.webViewLink) {
    throw new Error("Google Drive upload failed");
  }

  // make it public link-sharable
  if (isPublic) {
    await drive.permissions.create({
      fileId: response.data.id,
      requestBody: {
        type: "anyone",
        role: "reader",
      },
    });
  }

  // share with users
  if (sharedEmails.length > 0) {
    await addOwnersToFile(response.data.id, sharedEmails);
  }

  return { id: response.data.id, webViewLink: response.data.webViewLink };
}

/**
 * List files in the service‐account Drive.
 * @param pageSize  max results per page
 * @param q         optional Drive‐API query, e.g. "'FOLDER_ID' in parents and trashed=false"
 */
export async function listFiles(pageSize = 100, q?: string): Promise<drive_v3.Schema$File[]> {
  const keyFile = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS);
  const auth = new google.auth.JWT({
    email: keyFile.client_email,
    key: keyFile.private_key,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  await auth.authorize();
  const drive = google.drive({ version: "v3", auth });
  const res = await drive.files.list({
    pageSize,
    q,
    fields: "nextPageToken, files(id, name, mimeType, parents)",
  });
  return res.data.files || [];
}

export async function getFileMetadata(fileId: string) {
  const drive = await initializeDrive();
  /* returns full file resource */
  return drive.files.get({ fileId, fields: "*" });
}

export async function downloadFile(fileId: string) {
  const drive = await initializeDrive();
  /* returns a stream of file contents */
  return drive.files.get({ fileId, alt: "media" }, { responseType: "stream" });
}

export async function deleteFile(fileId: string) {
  const drive = await initializeDrive();
  return drive.files.delete({ fileId });
}

export async function createFolder(folderName: string) {
  const drive = await initializeDrive();
  const res = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
    },
  });
  return res.data;
}

/**
 * Add owner(s) to a Google Drive file by email address.
 * @param fileId  ID of the Drive file
 * @param emails  Array of user email addresses to grant ownership
 */
export async function addOwnersToFile(
  fileId: string,
  emails: string[]
): Promise<drive_v3.Schema$Permission[]> {
  const drive = await initializeDrive();
  const results: drive_v3.Schema$Permission[] = [];
  for (const email of emails) {
    const res = await drive.permissions.create({
      fileId,
      requestBody: {
        type: "user",
        role: "owner",
        emailAddress: email,
      },
      transferOwnership: true,
    });
    results.push(res.data);
  }
  return results;
}
