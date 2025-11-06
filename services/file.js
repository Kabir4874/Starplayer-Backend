import crypto from "crypto";
import fse from "fs-extra";
import mime from "mime-types";
import path from "path";
import { cfg } from "../config/config.js";

/**
 * Calculate file hash to detect duplicate content
 */
export async function calculateFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("md5");
    const stream = fse.createReadStream(filePath);

    stream.on("data", (data) => hash.update(data));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * Check if a file already exists in the media directory (case-insensitive)
 */
export async function fileExistsInMediaDir(fileName) {
  try {
    const files = await fse.readdir(cfg.mediaDir);
    const lowerCaseFileName = fileName.toLowerCase();
    return files.some((file) => file.toLowerCase() === lowerCaseFileName);
  } catch (error) {
    console.warn("Error reading media directory:", error.message);
    return false;
  }
}

/**
 * Check if file content already exists by comparing hashes
 */
export async function findDuplicateByHash(filePath, existingHashes) {
  try {
    const fileHash = await calculateFileHash(filePath);
    return existingHashes.has(fileHash);
  } catch (error) {
    console.warn("Error calculating file hash:", error.message);
    return false;
  }
}

/**
 * Generate a unique filename by appending numbers if needed
 */
async function generateUniqueFilename(baseName, ext) {
  let candidate = `${baseName}${ext}`;
  let i = 1;

  // Check if file exists and generate new name if needed
  while (await fse.pathExists(path.join(cfg.mediaDir, candidate))) {
    candidate = `${baseName}_${i}${ext}`;
    i += 1;
  }
  return candidate;
}

export async function moveToCasparMedia(tempPath, originalName) {
  await fse.ensureDir(cfg.mediaDir);

  const ext =
    path.extname(originalName) ||
    `.${mime.extension(mime.lookup(originalName) || "mp4")}`;
  const base = path
    .basename(originalName, path.extname(originalName))
    .replace(/[^\w\s\-\.]+/g, "_")
    .replace(/\s+/g, "_");

  // Generate unique filename
  const candidate = await generateUniqueFilename(base, ext);
  const dst = path.join(cfg.mediaDir, candidate);

  await fse.move(tempPath, dst, { overwrite: false });
  return { absolutePath: dst, fileName: candidate };
}

export function casparBaseName(fileName) {
  return fileName.replace(/\.[^.]+$/, "");
}
