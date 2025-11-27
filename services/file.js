import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import crypto from "crypto";
import ffmpeg from "fluent-ffmpeg";
import fse from "fs-extra";
import mime from "mime-types";
import path from "path";
import { cfg } from "../config/config.js";
import { enqueueFfmpeg } from "./ffmpegQueue.js";

let ffmpegPath = null;

if (cfg.ffmpegPath) {
  ffmpegPath = cfg.ffmpegPath;
} else if (process.env.FFMPEG_PATH) {
  ffmpegPath = process.env.FFMPEG_PATH;
} else if (ffmpegInstaller && ffmpegInstaller.path) {
  ffmpegPath = ffmpegInstaller.path;
}

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
  console.log("[FFMPEG] Using binary at:", ffmpegPath);
} else {
  console.warn(
    "[FFMPEG] No ffmpeg binary configured. Install @ffmpeg-installer/ffmpeg or set cfg.ffmpegPath / FFMPEG_PATH."
  );
}

/* ───────────────────────── Hash / file helpers ───────────────────────── */

export async function calculateFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("md5");
    const stream = fse.createReadStream(filePath);

    stream.on("data", (data) => hash.update(data));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

export async function fileExistsInMediaDir(fileName) {
  try {
    const files = await fse.readdir(cfg.mediaDir);
    const lowerCaseFileName = String(fileName || "").toLowerCase();
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

  while (await fse.pathExists(path.join(cfg.mediaDir, candidate))) {
    candidate = `${baseName}_${i}${ext}`;
    i += 1;
  }
  return candidate;
}

/**
 * Move a temp file into the Caspar media directory with a safe unique name.
 */
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

/**
 * Return Caspar base name (filename without extension).
 */
export function casparBaseName(fileName) {
  return String(fileName || "").replace(/\.[^.]+$/, "");
}

export function normalizeStem(name) {
  const stem = path.basename(
    String(name || ""),
    path.extname(String(name || ""))
  );
  return stem
    .trim()
    .toLowerCase()
    .replace(/[^\w\s\-\.]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_");
}

/* ───────────────────────── Video overlay helpers ───────────────────────── */

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".mkv",
  ".avi",
  ".webm",
  ".m4v",
  ".mpg",
  ".mpeg",
  ".ts",
  ".m2ts",
]);

function isVideoFile(fileName) {
  const ext = path.extname(String(fileName || "")).toLowerCase();
  return VIDEO_EXTENSIONS.has(ext);
}

function escapeForDrawtext(text) {
  return String(text || "")
    .replace(/\\/g, "\\\\") // backslash
    .replace(/:/g, "\\:") // colon
    .replace(/'/g, "\\'") // single quote
    .replace(/%/g, "\\%") // percent
    .replace(/\n/g, "\\n") // newline for multi-line text
    .replace(/\r/g, "");
}

async function getDefaultFontFile() {
  const candidates = [
    cfg.ffmpegFont,
    // Windows
    "C:\\Windows\\Fonts\\arial.ttf",
    "C:\\Windows\\Fonts\\ARIAL.TTF",
    // macOS
    "/Library/Fonts/Arial.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    // Linux common
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (await fse.pathExists(p)) {
        return p;
      }
    } catch {
      // ignore errors, keep trying
    }
  }
  return null;
}

/**
 * Overlay artist/title text on video files.
 * Uses a global ffmpeg queue so we never run too many ffmpeg processes at once.
 */
export async function burnInArtistTitle(
  absolutePath,
  { author, title } = {},
  fallbackName = ""
) {
  try {
    if (!absolutePath) return;

    if (!isVideoFile(absolutePath)) {
      // No overlay for pure audio files
      return;
    }

    // If ffmpeg binary isn't configured, do nothing (but don't crash uploads)
    if (!ffmpegPath && !ffmpegInstaller?.path && !process.env.FFMPEG_PATH) {
      console.warn(
        "[FFMPEG] burnInArtistTitle skipped: no ffmpeg binary configured."
      );
      return;
    }

    // Build lines: Artist (first line), Title (second line)
    let artistLine = author ? String(author) : "";
    let titleLine = title ? String(title) : "";

    // 🔧 FIX: remove underscores from overlay text, trim extra spaces
    artistLine = artistLine.replace(/_/g, " ").trim();
    titleLine = titleLine.replace(/_/g, " ").trim();

    if (!artistLine && !titleLine && fallbackName) {
      const base = path.basename(fallbackName, path.extname(fallbackName));
      titleLine = base.replace(/_/g, " ").trim(); // also clean underscores here
    }

    if (!artistLine && !titleLine) return;

    const fontFile = await getDefaultFontFile();

    // Escape each line separately for drawtext
    const escapedArtist = artistLine ? escapeForDrawtext(artistLine) : "";
    const escapedTitle = titleLine ? escapeForDrawtext(titleLine) : "";

    // 720p-friendly settings: crisp but not huge
    // Scale everything to 1280x720, pad if needed (keeps aspect), then draw text.
    const scalePad =
      "scale=1280:720:force_original_aspect_ratio=decrease," +
      "pad=1280:720:(1280-iw)/2:(720-ih)/2:black";

    const baseFontPart = fontFile
      ? `fontfile='${escapeForDrawtext(fontFile)}':`
      : "";

    const commonTextOpts =
      `${baseFontPart}` +
      "fontcolor=white:fontsize=28:" + // tuned for 720p
      "box=1:boxcolor=0x000000AA:boxborderw=6";

    const filterParts = [scalePad];

    if (escapedArtist && escapedTitle) {
      // 🔼 ARTIST on top line, TITLE on second line, TOP-LEFT
      filterParts.push(
        `drawtext=${commonTextOpts}:text='${escapedArtist}':x=20:y=40`,
        `drawtext=${commonTextOpts}:text='${escapedTitle}':x=20:y=80`
      );
    } else {
      // Only one line (artist or title or fallback)
      const singleLine = escapedArtist || escapedTitle;
      filterParts.push(
        `drawtext=${commonTextOpts}:text='${singleLine}':x=20:y=60`
      );
    }

    const fullFilter = filterParts.join(",");

    const ext = path.extname(absolutePath) || ".mp4";
    const tmpOut = `${absolutePath}.ffmpeg_overlay${ext}`;

    console.log("[FFMPEG] Starting artist/title overlay (fluent-ffmpeg)", {
      input: absolutePath,
      output: tmpOut,
      artist: artistLine || "(none)",
      title: titleLine || "(none)",
      fontFile: fontFile || "(default font)",
      filter: fullFilter,
    });

    // ✅ IMPORTANT: run the ffmpeg job inside the queue
    await enqueueFfmpeg(
      () =>
        new Promise((resolve) => {
          ffmpeg(absolutePath)
            .videoFilters(fullFilter)
            .outputOptions(["-c:a copy"]) // keep original audio
            .output(tmpOut)
            .on("start", (cmd) => {
              console.log("[FFMPEG] Command:", cmd);
            })
            .on("error", (err, stdout, stderr) => {
              console.error("[FFMPEG] Overlay error:", err?.message || err);
              if (stderr) console.error("[FFMPEG] STDERR:", stderr);
              // Clean partial file if exists
              fse.remove(tmpOut).catch(() => {});
              // We resolve even on error so the queue continues
              resolve();
            })
            .on("end", async () => {
              try {
                // Replace original file with the overlaid one
                await fse.move(tmpOut, absolutePath, { overwrite: true });
                console.log("[FFMPEG] Overlay complete, file replaced.");
              } catch (moveErr) {
                console.error(
                  "[FFMPEG] Failed to replace original file with overlay:",
                  moveErr?.message || moveErr
                );
                // If move failed, try to remove tmpOut to avoid clutter
                fse.remove(tmpOut).catch(() => {});
              } finally {
                resolve();
              }
            })
            .run();
        })
    );
  } catch (error) {
    console.error("[FFMPEG] Failed to burn artist/title overlay:", error);
  }
}
