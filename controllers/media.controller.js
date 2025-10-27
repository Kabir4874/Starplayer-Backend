import fse from "fs-extra";
import multer from "multer";
import path from "path";
import { cfg } from "../config/config.js";
import { moveToCasparMedia } from "../services/file.js";
import { probeFile } from "../services/metadata.js";
import { prisma } from "../services/prisma.js";

// Multer configuration - only accept files
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

    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${file.mimetype}`), false);
    }
  },
});

export const uploadMiddleware = upload.array("files", 50);

/**
 * POST /api/media - Upload media files with automatic metadata extraction
 */
export async function addMedia(req, res, next) {
  const files = req.files || [];

  try {
    if (!files.length) {
      return res.status(400).json({
        ok: false,
        message: "No files uploaded.",
      });
    }

    const results = [];
    const missingAggregateCount = {
      title: 0,
      author: 0,
      year: 0,
      duration: 0,
      bpm: 0,
    };

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      try {
        const meta = await probeFile(file.path, file.originalname);

        const title = meta.title;
        const author = meta.artist;
        const year = meta.year;
        const bpm = meta.bpm;
        const duration = meta.durationSec;
        const mediaType = meta.mediaType;
        const language = meta.language;

        meta.missing.forEach((field) => {
          if (missingAggregateCount[field] !== undefined) {
            missingAggregateCount[field]++;
          }
        });

        const { absolutePath, fileName } = await moveToCasparMedia(
          file.path,
          file.originalname
        );

        const saved = await prisma.media.create({
          data: {
            type: mediaType,
            author: author,
            title: title,
            year: year,
            fileName,
            uploadDate: new Date(),
            language,
            bpm: bpm ? Math.round(bpm) : null,
            duration: duration ? Math.round(duration) : 0,
          },
        });

        results.push({
          ok: true,
          media: saved,
          storedAt: absolutePath,
          missingMeta: meta.missing,
          autoDetected: {
            type: mediaType,
            language: language,
            fromFilename:
              !meta.missing.includes("title") ||
              !meta.missing.includes("author"),
          },
        });
      } catch (fileError) {
        results.push({
          ok: false,
          originalName: file.originalname,
          error: fileError.message,
          skipped: true,
        });

        await fse.remove(file.path).catch(() => {});
      }
    }

    const successfulUploads = results.filter((r) => r.ok).length;
    const failedUploads = results.filter((r) => !r.ok).length;

    res.status(201).json({
      ok: true,
      totalUploaded: files.length,
      successful: successfulUploads,
      failed: failedUploads,
      items: results,
      missingSummary: missingAggregateCount,
    });
  } catch (error) {
    const temps = files.map((x) => x.path);
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
      type,
      language,
      search,
      sortBy = "uploadDate",
      sortOrder = "desc",
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = {};

    if (type && type !== "ALL") {
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
      prisma.media.findMany({
        where,
        orderBy,
        skip,
        take,
      }),
      prisma.media.count({ where }),
    ]);

    res.json({
      ok: true,
      items: media,
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
 * GET /api/media/:id - Get specific media
 */
export async function getMedia(req, res, next) {
  try {
    const id = Number(req.params.id);
    const media = await prisma.media.findUnique({
      where: { id },
      include: {
        playlistItems: {
          include: {
            playlist: true,
          },
        },
        history: {
          orderBy: {
            datetime: "desc",
          },
          take: 10,
        },
      },
    });

    if (!media) {
      return res.status(404).json({
        ok: false,
        message: "Media not found",
      });
    }

    res.json({
      ok: true,
      media,
    });
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

    const media = await prisma.media.findUnique({
      where: { id },
    });

    if (!media) {
      return res.status(404).json({
        ok: false,
        message: "Media not found",
      });
    }

    // Delete physical file from media folder
    const filePath = path.join(cfg.mediaDir, media.fileName);

    if (await fse.pathExists(filePath)) {
      await fse.remove(filePath);
      console.log(`🗑️ Deleted media file: ${media.fileName}`);
    } else {
      console.log(`⚠️ Media file not found in folder: ${media.fileName}`);
    }

    // Delete from database
    await prisma.media.delete({
      where: { id },
    });

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

    // Get file extension and determine content type
    const ext = path.extname(fileName).toLowerCase();
    let contentType = "application/octet-stream";

    if ([".mp3", ".wav", ".aac", ".flac", ".ogg"].includes(ext)) {
      contentType = `audio/${ext.slice(1)}`;
      if (ext === ".mp3") contentType = "audio/mpeg";
    } else if ([".mp4", ".avi", ".mov", ".mkv", ".webm"].includes(ext)) {
      contentType = `video/${ext.slice(1)}`;
      if (ext === ".mp4") contentType = "video/mp4";
      if (ext === ".mov") contentType = "video/quicktime";
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
      _count: {
        id: true,
      },
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

    // Get recent uploads
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
      return res.json({
        ok: true,
        suggestions: [],
      });
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
 */
export async function updateMedia(req, res, next) {
  try {
    const id = Number(req.params.id);
    const { title, author, year, bpm, type, language } = req.body;

    const media = await prisma.media.findUnique({
      where: { id },
    });

    if (!media) {
      return res.status(404).json({
        ok: false,
        message: "Media not found",
      });
    }

    const updated = await prisma.media.update({
      where: { id },
      data: {
        ...(title && { title }),
        ...(author && { author }),
        ...(year && { year: parseInt(year) }),
        ...(bpm !== undefined && { bpm: bpm ? parseInt(bpm) : null }),
        ...(type && { type }),
        ...(language && { language }),
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
