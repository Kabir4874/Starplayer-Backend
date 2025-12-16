// src/controllers/playlist.controller.js
import { prisma } from "../services/prisma.js";

/* ───────────────────────── Helpers ───────────────────────── */

/**
 * Normalize playlist items from request body.
 *
 * Supports:
 *   - New format: items: [{ kind, mediaId, randomType }, ...]
 *   - Legacy format: mediaIds: [1,2,3]
 *
 * Returns array of:
 *   { order, kind: 'FIXED'|'RANDOM', mediaId: number|null, randomType: 'SONG'|'JINGLE'|'SPOT'|null }
 */
function normalizePlaylistItemsFromBody(body) {
  const { items, mediaIds = [] } = body || {};
  const normalized = [];

  if (Array.isArray(items) && items.length > 0) {
    items.forEach((raw, index) => {
      const rawKind = String(raw.kind || "FIXED").toUpperCase();
      const kind = rawKind === "RANDOM" ? "RANDOM" : "FIXED";

      if (kind === "RANDOM") {
        // For RANDOM slots we only care about randomType (MediaType).
        const rt =
          (raw.randomType ||
            raw.random_type ||
            raw.type || // allow 'type' from frontend if they send SONG/JINGLE/SPOT
            "SONG") + "";

        const randomType = rt.toUpperCase();
        if (!["SONG", "JINGLE", "SPOT"].includes(randomType)) {
          throw new Error(`Invalid randomType for playlist item: ${rt}`);
        }

        normalized.push({
          order: index,
          kind,
          mediaId: null,
          randomType,
        });
      } else {
        // FIXED
        const idRaw =
          raw.mediaId ?? raw.media_id ?? raw.id ?? raw.mediaID ?? null;
        const mediaId = parseInt(idRaw, 10);
        if (!mediaId || Number.isNaN(mediaId)) {
          throw new Error("Invalid or missing mediaId for FIXED playlist item");
        }
        normalized.push({
          order: index,
          kind: "FIXED",
          mediaId,
          randomType: null,
        });
      }
    });
  } else {
    // Legacy mode: mediaIds only, all FIXED and in given order
    (mediaIds || []).forEach((mid, index) => {
      const mediaId = parseInt(mid, 10);
      if (!mediaId || Number.isNaN(mediaId)) {
        throw new Error("Invalid mediaId in mediaIds array");
      }
      normalized.push({
        order: index,
        kind: "FIXED",
        mediaId,
        randomType: null,
      });
    });
  }

  return normalized;
}

/**
 * Validate that all FIXED items refer to existing Media rows.
 */
async function validateFixedMediaExist(normalizedItems) {
  const fixedIds = normalizedItems
    .filter((it) => it.kind === "FIXED" && it.mediaId)
    .map((it) => it.mediaId);

  if (!fixedIds.length) return;

  const uniqueIds = Array.from(new Set(fixedIds));
  const existing = await prisma.media.findMany({
    where: { id: { in: uniqueIds } },
    select: { id: true },
  });

  const existingSet = new Set(existing.map((m) => m.id));
  const missing = uniqueIds.filter((id) => !existingSet.has(id));

  if (missing.length) {
    throw new Error(
      `One or more media items not found (ids: ${missing.join(", ")})`
    );
  }
}

/**
 * Map Playlist (with playlistItems + media) to client-friendly structure.
 * Handles both FIXED and RANDOM items.
 */
function serializePlaylistForClient(playlist) {
  const items = (playlist.playlistItems || []).map((item) => {
    const isRandom = item.kind === "RANDOM" || (!item.media && item.randomType);
    if (isRandom) {
      return {
        id: null,
        kind: "RANDOM",
        isRandom: true,
        randomType: item.randomType || null,
        order: item.order,
        type: item.randomType || null,
        author: null,
        title: null,
        year: null,
        fileName: null,
        duration: null,
        language: null,
        bpm: null,
      };
    }

    const m = item.media;
    return {
      id: m.id,
      kind: item.kind || "FIXED",
      isRandom: false,
      randomType: null,
      order: item.order,
      type: m.type,
      author: m.author,
      title: m.title,
      year: m.year,
      fileName: m.fileName,
      duration: m.duration,
      language: m.language,
      bpm: m.bpm,
    };
  });

  return {
    id: playlist.id,
    title: playlist.title,
    // mediaIds for FIXED items only (legacy usage)
    mediaIds: (playlist.playlistItems || [])
      .filter((it) => it.kind === "FIXED" && it.mediaId != null)
      .map((it) => it.mediaId),
    items,
    createdAt: playlist.createdAt,
    updatedAt: playlist.updatedAt,
  };
}

/* ───────────────────────── Controllers ───────────────────────── */

/**
 * GET /api/playlists - Get all playlists with their items
 */
export async function listPlaylists(req, res, next) {
  try {
    const playlists = await prisma.playlist.findMany({
      include: {
        playlistItems: {
          include: {
            media: true,
          },
          orderBy: {
            order: "asc",
          },
        },
        schedules: {
          orderBy: {
            datetime: "asc",
          },
        },
      },
      orderBy: {
        updatedAt: "desc",
      },
    });

    const transformed = playlists.map((playlist) =>
      serializePlaylistForClient(playlist)
    );

    res.json({
      ok: true,
      playlists: transformed,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/playlists/:id - Get specific playlist
 */
export async function getPlaylist(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);

    const playlist = await prisma.playlist.findUnique({
      where: { id },
      include: {
        playlistItems: {
          include: {
            media: true,
          },
          orderBy: {
            order: "asc",
          },
        },
      },
    });

    if (!playlist) {
      return res.status(404).json({
        ok: false,
        message: "Playlist not found",
      });
    }

    const transformed = serializePlaylistForClient(playlist);

    res.json({
      ok: true,
      playlist: transformed,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/playlists - Create new playlist
 * Body supports:
 *   - { title, mediaIds: number[] }  (legacy)
 *   - { title, items: [{ kind, mediaId?, randomType? }, ...] } (new)
 */
export async function createPlaylist(req, res, next) {
  try {
    const { title } = req.body;

    if (!title || typeof title !== "string" || !title.trim()) {
      return res.status(400).json({
        ok: false,
        message: "Playlist title is required",
      });
    }

    let itemsNormalized;
    try {
      itemsNormalized = normalizePlaylistItemsFromBody(req.body);
      if (!itemsNormalized.length) {
        return res.status(400).json({
          ok: false,
          message: "Playlist must contain at least one item",
        });
      }
    } catch (e) {
      return res.status(400).json({
        ok: false,
        message: e.message || "Invalid playlist items",
      });
    }

    // Validate FIXED media references
    try {
      await validateFixedMediaExist(itemsNormalized);
    } catch (e) {
      return res.status(400).json({
        ok: false,
        message: e.message || "One or more media items not found",
      });
    }

    const playlist = await prisma.playlist.create({
      data: {
        title: title.trim(),
        playlistItems: {
          create: itemsNormalized.map((it) => ({
            mediaId: it.kind === "FIXED" ? it.mediaId : null,
            order: it.order,
            kind: it.kind,
            randomType: it.kind === "RANDOM" ? it.randomType : null,
          })),
        },
      },
      include: {
        playlistItems: {
          include: {
            media: true,
          },
          orderBy: {
            order: "asc",
          },
        },
      },
    });

    const transformed = serializePlaylistForClient(playlist);

    res.status(201).json({
      ok: true,
      playlist: transformed,
      message: "Playlist created successfully",
    });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/playlists/:id - Update playlist (title + items)
 * Body supports same formats as createPlaylist.
 */
export async function updatePlaylist(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    const { title } = req.body;

    if (!title || typeof title !== "string" || !title.trim()) {
      return res.status(400).json({
        ok: false,
        message: "Playlist title is required",
      });
    }

    const existingPlaylist = await prisma.playlist.findUnique({
      where: { id },
      include: { playlistItems: true },
    });

    if (!existingPlaylist) {
      return res.status(404).json({
        ok: false,
        message: "Playlist not found",
      });
    }

    let itemsNormalized;
    try {
      itemsNormalized = normalizePlaylistItemsFromBody(req.body);
      if (!itemsNormalized.length) {
        return res.status(400).json({
          ok: false,
          message: "Playlist must contain at least one item",
        });
      }
    } catch (e) {
      return res.status(400).json({
        ok: false,
        message: e.message || "Invalid playlist items",
      });
    }

    try {
      await validateFixedMediaExist(itemsNormalized);
    } catch (e) {
      return res.status(400).json({
        ok: false,
        message: e.message || "One or more media items not found",
      });
    }

    const playlist = await prisma.$transaction(async (tx) => {
      // Remove old items
      await tx.playlistItem.deleteMany({
        where: { playlistId: id },
      });

      // Update playlist title + recreate items
      return tx.playlist.update({
        where: { id },
        data: {
          title: title.trim(),
          playlistItems: {
            create: itemsNormalized.map((it) => ({
              mediaId: it.kind === "FIXED" ? it.mediaId : null,
              order: it.order,
              kind: it.kind,
              randomType: it.kind === "RANDOM" ? it.randomType : null,
            })),
          },
        },
        include: {
          playlistItems: {
            include: {
              media: true,
            },
            orderBy: {
              order: "asc",
            },
          },
        },
      });
    });

    const transformed = serializePlaylistForClient(playlist);

    res.json({
      ok: true,
      playlist: transformed,
      message: "Playlist updated successfully",
    });
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /api/playlists/:id - Delete playlist
 */
export async function deletePlaylist(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);

    const existingPlaylist = await prisma.playlist.findUnique({
      where: { id },
    });

    if (!existingPlaylist) {
      return res.status(404).json({
        ok: false,
        message: "Playlist not found",
      });
    }

    await prisma.playlist.delete({
      where: { id },
    });

    res.json({
      ok: true,
      message: "Playlist deleted successfully",
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/playlists/:id/items - Add item to playlist
 *
 * Body:
 *   - FIXED:  { mediaId: number }
 *   - RANDOM: { kind: "RANDOM", randomType: "SONG"|"JINGLE"|"SPOT" }
 */
export async function addPlaylistItem(req, res, next) {
  try {
    const playlistId = parseInt(req.params.id, 10);
    const { mediaId, kind, randomType } = req.body || {};

    // Check if playlist exists
    const playlist = await prisma.playlist.findUnique({
      where: { id: playlistId },
      include: { playlistItems: true },
    });

    if (!playlist) {
      return res.status(404).json({
        ok: false,
        message: "Playlist not found",
      });
    }

    const rawKind = String(
      kind || (mediaId ? "FIXED" : "RANDOM")
    ).toUpperCase();

    // RANDOM slot
    if (rawKind === "RANDOM") {
      const rt = (randomType || "SONG") + "";
      const rtUpper = rt.toUpperCase();
      if (!["SONG", "JINGLE", "SPOT"].includes(rtUpper)) {
        return res.status(400).json({
          ok: false,
          message: `Invalid randomType for RANDOM item: ${rt}`,
        });
      }

      const nextOrder = playlist.playlistItems.length;

      const playlistItem = await prisma.playlistItem.create({
        data: {
          playlistId,
          mediaId: null,
          order: nextOrder,
          kind: "RANDOM",
          randomType: rtUpper,
        },
        include: {
          media: true,
        },
      });

      return res.status(201).json({
        ok: true,
        item: {
          id: null,
          kind: "RANDOM",
          isRandom: true,
          randomType: rtUpper,
          order: playlistItem.order,
          type: rtUpper,
          author: null,
          title: null,
          year: null,
          fileName: null,
          duration: null,
          language: null,
          bpm: null,
        },
        message: "Random slot added to playlist",
      });
    }

    // FIXED item (original behaviour)
    if (!mediaId) {
      return res.status(400).json({
        ok: false,
        message: "Media ID is required for FIXED playlist item",
      });
    }

    const mid = parseInt(mediaId, 10);

    const media = await prisma.media.findUnique({
      where: { id: mid },
    });

    if (!media) {
      return res.status(404).json({
        ok: false,
        message: "Media not found",
      });
    }

    const existingItem = playlist.playlistItems.find(
      (item) => item.mediaId === mid
    );
    if (existingItem) {
      return res.status(400).json({
        ok: false,
        message: "Media already in playlist",
      });
    }

    const nextOrder = playlist.playlistItems.length;

    const playlistItem = await prisma.playlistItem.create({
      data: {
        playlistId,
        mediaId: mid,
        order: nextOrder,
        kind: "FIXED",
        randomType: null,
      },
      include: {
        media: true,
      },
    });

    res.status(201).json({
      ok: true,
      item: {
        id: playlistItem.media.id,
        kind: "FIXED",
        isRandom: false,
        randomType: null,
        order: playlistItem.order,
        type: playlistItem.media.type,
        author: playlistItem.media.author,
        title: playlistItem.media.title,
        year: playlistItem.media.year,
        fileName: playlistItem.media.fileName,
        duration: playlistItem.media.duration,
        language: playlistItem.media.language,
        bpm: playlistItem.media.bpm,
      },
      message: "Item added to playlist",
    });
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /api/playlists/:id/items/:mediaId - Remove item from playlist
 * (removes FIXED item; RANDOM items can be removed by deleting their row too,
 * but then :mediaId will not apply – you can extend this later if needed.)
 */
export async function removePlaylistItem(req, res, next) {
  try {
    const playlistId = parseInt(req.params.id, 10);
    const mediaId = parseInt(req.params.mediaId, 10);

    const deleted = await prisma.playlistItem.deleteMany({
      where: {
        playlistId,
        mediaId,
      },
    });

    if (deleted.count === 0) {
      return res.status(404).json({
        ok: false,
        message: "Item not found in playlist",
      });
    }

    const remainingItems = await prisma.playlistItem.findMany({
      where: { playlistId },
      orderBy: { order: "asc" },
    });

    await Promise.all(
      remainingItems.map((item, index) =>
        prisma.playlistItem.update({
          where: { id: item.id },
          data: { order: index },
        })
      )
    );

    res.json({
      ok: true,
      message: "Item removed from playlist",
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/playlists/:id/resolve
 * Resolve a playlist with RANDOM slots filled in with actual media items.
 * Each call generates fresh random picks.
 */
export async function resolvePlaylist(req, res, next) {
  try {
    const playlistId = parseInt(req.params.id, 10);
    if (!playlistId || Number.isNaN(playlistId)) {
      return res.status(400).json({
        ok: false,
        message: "Invalid playlist ID",
      });
    }

    // Import the resolver
    const { resolvePlaylistForSchedule } = await import(
      "../services/playlistRandomResolver.js"
    );

    const resolved = await resolvePlaylistForSchedule(playlistId);

    // Convert to client-friendly format
    // Since items are now resolved, treat them all as actual media
    // (don't mark as random since they've been resolved to real songs)
    const items = resolved.map((item, index) => ({
      id: item.media.id,
      order: index,
      type: item.media.type,
      author: item.media.author,
      title: item.media.title,
      year: item.media.year,
      fileName: item.media.fileName,
      duration: item.media.duration,
      language: item.media.language,
      bpm: item.media.bpm,
      // Optional: include original kind for tracking purposes if needed
      // But don't include isRandom flag since these are resolved items
      wasRandomSlot: item.kind === "RANDOM", // Track if this was originally a random slot
    }));

    res.json({
      ok: true,
      playlistId,
      items,
    });
  } catch (error) {
    next(error);
  }
}
