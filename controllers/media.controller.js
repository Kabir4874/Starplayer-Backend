import fse from "fs-extra";
import multer from "multer";
import path from "path";
import { cfg } from "../config/config.js";
import {
  calculateFileHash,
  moveToCasparMedia,
  normalizeStem,
} from "../services/file.js";
import { probeFile } from "../services/metadata.js";
import { prisma } from "../services/prisma.js";

/* ───────────────────────── Helpers ───────────────────────── */

const TYPE = Object.freeze({
  SONG: "SONG",
  JINGLE: "JINGLE",
  SPOT: "SPOT",
});

/** Normalize any incoming type value to SONG / JINGLE / SPOT (or null) */
function normalizeType(raw) {
  const t = String(raw || "").toUpperCase();
  if (t === TYPE.SONG) return TYPE.SONG;
  if (t === TYPE.JINGLE) return TYPE.JINGLE;
  if (t === TYPE.SPOT) return TYPE.SPOT;
  return null;
}

/* ───────────────────────── Multer ───────────────────────── */

const upload = multer({
  dest: path.join(process.cwd(), "src", "uploads"),
  limits: { fileSize: 11 * 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      "audio/mpeg",
      "audio/mp3",
      "audio/wav",
      "audio/aac",
      "audio/flac",
      "audio/ogg",
      "video/mp4",
      "video/avi",
      "video/mov",
      "video/mkv",
      "video/webm",
      "video/quicktime",
    ];
    if (allowedMimes.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Invalid file type: ${file.mimetype}`), false);
  },
});

export const uploadMiddleware = upload.any();

/* ─────────────────────── Controllers ─────────────────────── */

export async function addMedia(req, res, next) {
  const files = req.files || [];

  try {
    if (!files.length) {
      return res.status(400).json({ ok: false, message: "No files uploaded." });
    }

    // Optional explicit type passed from UI (SONG/JINGLE/SPOT)
    const bodyType = normalizeType(req.body?.type);

    const results = [];
    const missingAggregateCount = {
      title: 0,
      author: 0,
      year: 0,
      duration: 0,
      bpm: 0,
    };

    // ── Build duplicate detection caches ─────────────────────
    const existingHashes = new Set(); // content hashes
    const existingNamesLower = new Set(); // exact file names (lower)
    const existingStems = new Set(); // normalized stems

    // DB filenames
    const allMedia = await prisma.media.findMany({
      select: { fileName: true },
    });

    for (const m of allMedia) {
      const fn = String(m.fileName || "");
      existingNamesLower.add(fn.toLowerCase());
      existingStems.add(normalizeStem(fn));
    }

    // FS filenames + content hashes
    try {
      await fse.ensureDir(cfg.mediaDir);
      const mediaFiles = await fse.readdir(cfg.mediaDir);
      for (const fileName of mediaFiles) {
        try {
          const filePath = path.join(cfg.mediaDir, fileName);
          const stat = await fse.stat(filePath);
          if (!stat.isFile()) continue;

          // name caches
          existingNamesLower.add(fileName.toLowerCase());
          existingStems.add(normalizeStem(fileName));

          // content hash
          const fileHash = await calculateFileHash(filePath);
          existingHashes.add(fileHash);
        } catch (error) {
          console.warn(
            `Could not process existing file ${fileName}:`,
            error.message
          );
        }
      }
    } catch (error) {
      console.warn("Error loading media directory for dedupe:", error.message);
    }

    // ── Process uploads ──────────────────────────────────────
    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      try {
        // Compute temp file hash once (authoritative dedupe)
        let tmpHash = null;
        try {
          tmpHash = await calculateFileHash(file.path);
        } catch (e) {
          // If hash fails, we still have name-based checks
          console.warn(`Hash failed for ${file.originalname}:`, e.message);
        }

        const originalLower = String(file.originalname || "").toLowerCase();
        const originalStem = normalizeStem(file.originalname);

        // Check A: exact name already in DB/FS (case-insensitive)
        const nameExists = existingNamesLower.has(originalLower);

        // Check B: normalized stem already present (handles "My Song.mp3" vs "my_song.MP3")
        const stemExists = existingStems.has(originalStem);

        // Check C: content hash duplicate
        const contentExists = tmpHash ? existingHashes.has(tmpHash) : false;

        if (contentExists || nameExists || stemExists) {
          // Clean up temp file since we're skipping this duplicate
          await fse.remove(file.path).catch(() => {});

          let reason = "Duplicate detected";
          if (contentExists) reason = "Duplicate content (hash match)";
          else if (nameExists) reason = "Duplicate filename";
          else if (stemExists) reason = "Duplicate name (normalized)";

          results.push({
            ok: false,
            originalName: file.originalname,
            error: reason,
            skipped: true,
            duplicate: true,
          });
          continue;
        }

        // Move the file into the media folder with a safe unique name
        const { absolutePath, fileName: newFileName } = await moveToCasparMedia(
          file.path,
          file.originalname
        );

        // Update caches to prevent duplicates within the same batch
        existingNamesLower.add(newFileName.toLowerCase());
        existingStems.add(normalizeStem(newFileName));
        try {
          const newFileHash =
            tmpHash ?? (await calculateFileHash(absolutePath));
          if (newFileHash) existingHashes.add(newFileHash);
        } catch (error) {
          console.warn(
            `Could not calculate hash for new file ${newFileName}:`,
            error.message
          );
        }

        // Probe from final location
        const meta = await probeFile(absolutePath, file.originalname);

        // Missing fields aggregation
        meta.missing.forEach((field) => {
          if (missingAggregateCount[field] !== undefined) {
            missingAggregateCount[field]++;
          }
        });

        // Resolve type: body (if valid) overrides auto-detected, default SONG
        const detectedType = normalizeType(meta.type) || TYPE.SONG;
        const finalType = bodyType || detectedType;

        const saved = await prisma.media.create({
          data: {
            type: finalType,
            author: meta.author,
            title: meta.title,
            year: meta.year,
            fileName: newFileName,
            uploadDate: new Date(),
            language: meta.language,
            bpm: meta.bpm ? Math.round(meta.bpm) : null,
            duration: meta.durationSec ? Math.round(meta.durationSec) : 0,
          },
        });

        results.push({
          ok: true,
          media: saved,
          storedAt: absolutePath,
          missingMeta: meta.missing,
          autoDetected: {
            type: finalType,
            language: meta.language,
          },
        });
      } catch (fileError) {
        console.error(`Error processing file ${file.originalname}:`, fileError);

        // Clean up temp file if it exists
        if (await fse.pathExists(file.path)) {
          await fse.remove(file.path).catch(() => {});
        }

        results.push({
          ok: false,
          originalName: file.originalname,
          error: fileError.message,
          skipped: true,
        });
      }
    }

    const successfulUploads = results.filter((r) => r.ok).length;
    const failedUploads = results.filter((r) => !r.ok && !r.duplicate).length;
    const duplicateFiles = results.filter((r) => r.duplicate).length;

    const response = {
      ok: successfulUploads > 0, // ✅ only true if at least one saved
      totalUploaded: files.length,
      successful: successfulUploads,
      failed: failedUploads,
      duplicates: duplicateFiles,
      items: results,
      missingSummary: missingAggregateCount,
      message:
        successfulUploads > 0
          ? duplicateFiles > 0
            ? `${duplicateFiles} file(s) were skipped as duplicates.`
            : "Upload complete."
          : "No files were saved (all duplicates or failed).",
    };

    res.status(successfulUploads > 0 ? 201 : 200).json(response);
  } catch (error) {
    console.error("Upload error:", error);
    // Clean any remaining temp files
    const temps = (req.files || []).map((x) => x.path);
    await Promise.allSettled(
      temps.map(async (p) => {
        if (p && (await fse.pathExists(p))) {
          await fse.remove(p).catch(() => {});
        }
      })
    );
    next(error);
  }
}

export async function listMedia(req, res, next) {
  try {
    const {
      type,
      language,
      search,
      sortBy = "uploadDate",
      sortOrder = "desc",
    } = req.query;

    const where = {};

    if (type && type !== "ALL") {
      const normalized = normalizeType(type);
      if (normalized) {
        where.type = normalized;
      }
    }

    if (language && language !== "ALL") {
      where.language = language;
    }

    if (search) {
      where.OR = [
        { title: { contains: search, mode: "insensitive" } },
        { author: { contains: search, mode: "insensitive" } },
        { fileName: { contains: search, mode: "insensitive" } },
      ];
    }

    const orderBy = {};
    orderBy[sortBy] = sortOrder;

    const media = await prisma.media.findMany({
      where,
      orderBy,
    });

    res.json({
      ok: true,
      items: media,
      total: media.length,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/media/:id - Get specific media (with playlists + history)
 */
export async function getMedia(req, res, next) {
  try {
    const id = Number(req.params.id);
    const media = await prisma.media.findUnique({
      where: { id },
      include: {
        playlistItems: {
          include: { playlist: true },
        },
        history: {
          orderBy: { datetime: "desc" },
          take: 10,
        },
      },
    });

    if (!media) {
      return res.status(404).json({ ok: false, message: "Media not found" });
    }

    res.json({ ok: true, media });
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /api/media/:id - Delete media from database and file system
 */
export async function deleteMedia(req, res, next) {
  try {
    const id = Number(req.params.id);
    const media = await prisma.media.findUnique({ where: { id } });

    if (!media) {
      return res.status(404).json({ ok: false, message: "Media not found" });
    }

    const filePath = path.join(cfg.mediaDir, media.fileName);

    if (await fse.pathExists(filePath)) {
      await fse.remove(filePath);
      console.log(`🗑️ Deleted media file: ${media.fileName}`);
    } else {
      console.log(`⚠️ Media file not found in folder: ${media.fileName}`);
    }

    await prisma.media.delete({ where: { id } });

    res.json({
      ok: true,
      message: "Media deleted from database and media folder",
      deleted: media,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/media/stream/:fileName - Stream media file for browser playback
 */
export async function streamMedia(req, res, next) {
  try {
    const { fileName } = req.params;
    const filePath = path.join(cfg.mediaDir, fileName);

    if (!(await fse.pathExists(filePath))) {
      return res.status(404).json({ ok: false, message: "File not found" });
    }

    const stat = await fse.stat(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    const ext = path.extname(fileName).toLowerCase();
    let contentType = "application/octet-stream";

    if ([".mp3", ".wav", ".aac", ".flac", ".ogg"].includes(ext)) {
      contentType = `audio/${ext.slice(1)}`;
      if (ext === ".mp3") contentType = "audio/mpeg";
    } else if ([".mp4", ".avi", ".mov", ".mkv", ".webm"].includes(ext)) {
      if (ext === ".mp4") contentType = "video/mp4";
      else if (ext === ".mov") contentType = "video/quicktime";
      else contentType = `video/${ext.slice(1)}`;
    }

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = end - start + 1;

      const file = fse.createReadStream(filePath, { start, end });
      const head = {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunksize,
        "Content-Type": contentType,
      };

      res.writeHead(206, head);
      file.pipe(res);
    } else {
      const head = {
        "Content-Length": fileSize,
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
      };
      res.writeHead(200, head);
      fse.createReadStream(filePath).pipe(res);
    }
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/media/stats - Get media statistics
 */
export async function getMediaStats(req, res, next) {
  try {
    const stats = await prisma.media.groupBy({
      by: ["type", "language"],
      _count: { id: true },
    });

    const total = await prisma.media.count();
    const byType = await prisma.media.groupBy({
      by: ["type"],
      _count: { id: true },
    });
    const byLanguage = await prisma.media.groupBy({
      by: ["language"],
      _count: { id: true },
    });

    const recentUploads = await prisma.media.findMany({
      orderBy: { uploadDate: "desc" },
      take: 10,
    });

    res.json({
      ok: true,
      stats: {
        total,
        byType,
        byLanguage,
        detailed: stats,
        recentUploads: recentUploads.length,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/media/search/suggest - Search suggestions
 */
export async function searchSuggestions(req, res, next) {
  try {
    const { q } = req.query;

    if (!q || q.length < 2) {
      return res.json({ ok: true, suggestions: [] });
    }

    const media = await prisma.media.findMany({
      where: {
        OR: [
          { title: { contains: q, mode: "insensitive" } },
          { author: { contains: q, mode: "insensitive" } },
        ],
      },
      take: 10,
      select: {
        id: true,
        title: true,
        author: true,
        type: true,
        fileName: true,
      },
    });

    res.json({
      ok: true,
      suggestions: media,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/media/:id - Update media metadata
 * Uses Media.type only (SONG/JINGLE/SPOT)
 */
export async function updateMedia(req, res, next) {
  try {
    const id = Number(req.params.id);
    const {
      title,
      author,
      year,
      bpm,
      type, // SONG/JINGLE/SPOT (optional)
      language,
    } = req.body;

    const media = await prisma.media.findUnique({ where: { id } });
    if (!media) {
      return res.status(404).json({ ok: false, message: "Media not found" });
    }

    // Resolve new type if provided, else keep previous
    const normalizedType = type ? normalizeType(type) : null;
    const resolvedType = normalizedType || media.type;

    const updated = await prisma.media.update({
      where: { id },
      data: {
        ...(title !== undefined && { title }),
        ...(author !== undefined && { author }),
        ...(year !== undefined && { year: year ? parseInt(year) : null }),
        ...(bpm !== undefined && { bpm: bpm ? parseInt(bpm) : null }),
        ...(resolvedType && { type: resolvedType }),
        ...(language !== undefined && { language }),
      },
    });

    res.json({
      ok: true,
      media: updated,
      message: "Media updated successfully",
    });
  } catch (error) {
    next(error);
  }
}
