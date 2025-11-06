import fse from "fs-extra";
import multer from "multer";
import path from "path";
import { cfg } from "../config/config.js";
import { fileExistsInMediaDir, moveToCasparMedia } from "../services/file.js";
import { probeFile } from "../services/metadata.js";
import { prisma } from "../services/prisma.js";

/* ───────────────────────── Helpers ───────────────────────── */

const CAT = Object.freeze({
  AUDIO: "AUDIO",
  JINGLES: "JINGLES",
  SPOTS: "SPOTS",
});

const TYPE = Object.freeze({
  SONG: "SONG",
  JINGLE: "JINGLE",
  SPOT: "SPOT",
});

/** Map UI category -> DB type */
function categoryToType(category) {
  const c = String(category || "").toUpperCase();
  if (c === CAT.JINGLES) return TYPE.JINGLE;
  if (c === CAT.SPOTS) return TYPE.SPOT;
  return TYPE.SONG; // AUDIO
}

/** Map DB type -> UI category */
function typeToCategory(type) {
  const t = String(type || "").toUpperCase();
  if (t === TYPE.JINGLE) return CAT.JINGLES;
  if (t === TYPE.SPOT) return CAT.SPOTS;
  return CAT.AUDIO; // SONG or unknown => AUDIO
}

/** Attach computed "category" for frontend compatibility */
function withCategory(media) {
  if (!media) return media;
  return { ...media, category: typeToCategory(media.type) };
}
function withCategoryArray(items) {
  return (items || []).map(withCategory);
}

/* ───────────────────────── Multer ───────────────────────── */

const upload = multer({
  dest: path.join(process.cwd(), "src", "uploads"),
  limits: { fileSize: 1024 * 1024 * 1024 },
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

export const uploadMiddleware = upload.array("files", 500);

/* ─────────────────────── Controllers ─────────────────────── */

/**
 * POST /api/media - Upload media files with automatic metadata extraction
 * Prevents duplicate files from being uploaded
 */
export async function addMedia(req, res, next) {
  const files = req.files || [];

  try {
    if (!files.length) {
      return res.status(400).json({ ok: false, message: "No files uploaded." });
    }

    // Optional category passed from the new Asset Manager
    const bodyCategory = req.body?.category
      ? String(req.body.category).toUpperCase()
      : null;

    const results = [];
    const missingAggregateCount = {
      title: 0,
      author: 0,
      year: 0,
      duration: 0,
      bpm: 0,
    };

    // Pre-load existing file information for duplicate checking
    const existingFiles = new Set();
    const existingHashes = new Set();

    // Get all existing media from database
    const allMedia = await prisma.media.findMany({
      select: { fileName: true },
    });

    // Populate existing files set (case-insensitive)
    allMedia.forEach((media) =>
      existingFiles.add(media.fileName.toLowerCase())
    );

    // Calculate hashes for existing files to detect content duplicates
    try {
      const mediaFiles = await fse.readdir(cfg.mediaDir);
      for (const fileName of mediaFiles) {
        try {
          const filePath = path.join(cfg.mediaDir, fileName);
          const fileHash = await calculateFileHash(filePath);
          existingHashes.add(fileHash);
        } catch (error) {
          console.warn(
            `Could not calculate hash for ${fileName}:`,
            error.message
          );
        }
      }
    } catch (error) {
      console.warn(
        "Error reading media directory for hash calculation:",
        error.message
      );
    }

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      try {
        // Check 1: Check if file already exists in database (case-insensitive)
        const fileExistsInDB = existingFiles.has(
          file.originalname.toLowerCase()
        );

        // Check 2: Check if file already exists in media directory
        const fileExistsInFS = await fileExistsInMediaDir(file.originalname);

        // Check 3: Check if file content already exists (by hash)
        const contentExists = await findDuplicateByHash(
          file.path,
          existingHashes
        );

        if (fileExistsInDB || fileExistsInFS || contentExists) {
          // Clean up temp file since we're skipping this duplicate
          await fse.remove(file.path).catch(() => {});

          let reason = "File already exists";
          if (contentExists && !fileExistsInDB && !fileExistsInFS) {
            reason = "File content already exists (different filename)";
          }

          results.push({
            ok: false,
            originalName: file.originalname,
            error: reason,
            skipped: true,
            duplicate: true,
          });
          continue; // Skip to next file
        }

        // First, move the file to Caspar media folder
        const { absolutePath, fileName: newFileName } = await moveToCasparMedia(
          file.path,
          file.originalname
        );

        // Add the new filename to our existing files set to prevent duplicates in same batch
        existingFiles.add(newFileName.toLowerCase());

        // Calculate and store the hash of the new file
        try {
          const newFileHash = await calculateFileHash(absolutePath);
          existingHashes.add(newFileHash);
        } catch (error) {
          console.warn(
            `Could not calculate hash for new file ${newFileName}:`,
            error.message
          );
        }

        // Then probe the file from its final location
        const meta = await probeFile(absolutePath, file.originalname);

        // Meta extracted (robust ffprobe + filename parse)
        const title = meta.title;
        const author = meta.author;
        const year = meta.year;
        const bpm = meta.bpm;
        const duration = meta.durationSec;
        const mediaType = meta.type;
        const language = meta.language;

        meta.missing.forEach((field) => {
          if (missingAggregateCount[field] !== undefined) {
            missingAggregateCount[field]++;
          }
        });

        // If UI provided explicit category, override detected type
        const finalType = bodyCategory
          ? categoryToType(bodyCategory)
          : mediaType;

        const saved = await prisma.media.create({
          data: {
            type: finalType,
            author: author,
            title: title,
            year: year,
            fileName: newFileName,
            uploadDate: new Date(),
            language,
            bpm: bpm ? Math.round(bpm) : null,
            duration: duration ? Math.round(duration) : 0,
          },
        });

        results.push({
          ok: true,
          media: withCategory(saved),
          storedAt: absolutePath,
          missingMeta: meta.missing,
          autoDetected: {
            type: finalType,
            language: language,
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
      ok: true,
      totalUploaded: files.length,
      successful: successfulUploads,
      failed: failedUploads,
      duplicates: duplicateFiles,
      items: results,
      missingSummary: missingAggregateCount,
    };

    // Add message if there were duplicates
    if (duplicateFiles > 0) {
      response.message = `${duplicateFiles} file(s) were skipped because they already exist.`;
    }

    res.status(201).json(response);
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

/**
 * GET /api/media - List all media with filtering
 */
export async function listMedia(req, res, next) {
  try {
    const {
      page = 1,
      limit = 50,
      type, // legacy (SONG/JINGLE/SPOT)
      category, // new (AUDIO/JINGLES/SPOTS)
      language,
      search,
      sortBy = "uploadDate",
      sortOrder = "desc",
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = {};

    // Prefer explicit category over 'type' if provided
    if (category && category !== "ALL") {
      where.type = categoryToType(category);
    } else if (type && type !== "ALL") {
      where.type = type;
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

    const [media, total] = await Promise.all([
      prisma.media.findMany({ where, orderBy, skip, take }),
      prisma.media.count({ where }),
    ]);

    res.json({
      ok: true,
      items: withCategoryArray(media),
      pagination: {
        page: parseInt(page),
        limit: take,
        total,
        pages: Math.ceil(total / take),
      },
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

    res.json({ ok: true, media: withCategory(media) });
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
      deleted: withCategory(media),
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

    // Attach category for byType convenience
    const byTypeWithCategory = byType.map((r) => ({
      ...r,
      category: typeToCategory(r.type),
    }));

    res.json({
      ok: true,
      stats: {
        total,
        byType: byTypeWithCategory,
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
      suggestions: withCategoryArray(media),
    });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/media/:id - Update media metadata
 */
export async function updateMedia(req, res, next) {
  try {
    const id = Number(req.params.id);
    const {
      title,
      author,
      year,
      bpm,
      type, // legacy
      language,
      category, // new
    } = req.body;

    const media = await prisma.media.findUnique({ where: { id } });
    if (!media) {
      return res.status(404).json({ ok: false, message: "Media not found" });
    }

    // Resolve type precedence: category > type > unchanged
    let resolvedType = media.type;
    if (category) {
      resolvedType = categoryToType(category);
    } else if (type) {
      resolvedType = type;
    }

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
      media: withCategory(updated),
      message: "Media updated successfully",
    });
  } catch (error) {
    next(error);
  }
}
