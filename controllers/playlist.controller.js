import { prisma } from "../services/prisma.js";

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

    // Transform to match frontend format
    const transformed = playlists.map((playlist) => ({
      id: playlist.id,
      title: playlist.title,
      mediaIds: playlist.playlistItems.map((item) => item.mediaId),
      items: playlist.playlistItems.map((item) => ({
        id: item.media.id,
        type: item.media.type,
        author: item.media.author,
        title: item.media.title,
        year: item.media.year,
        fileName: item.media.fileName,
        duration: item.media.duration,
        language: item.media.language,
        bpm: item.media.bpm,
      })),
      createdAt: playlist.createdAt,
      updatedAt: playlist.updatedAt,
    }));

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
    const id = parseInt(req.params.id);

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

    const transformed = {
      id: playlist.id,
      title: playlist.title,
      mediaIds: playlist.playlistItems.map((item) => item.mediaId),
      items: playlist.playlistItems.map((item) => ({
        id: item.media.id,
        type: item.media.type,
        author: item.media.author,
        title: item.media.title,
        year: item.media.year,
        fileName: item.media.fileName,
        duration: item.media.duration,
        language: item.media.language,
        bpm: item.media.bpm,
      })),
      createdAt: playlist.createdAt,
      updatedAt: playlist.updatedAt,
    };

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
 */
export async function createPlaylist(req, res, next) {
  try {
    const { title, mediaIds = [] } = req.body;

    if (!title || typeof title !== "string" || !title.trim()) {
      return res.status(400).json({
        ok: false,
        message: "Playlist title is required",
      });
    }

    // Verify all media items exist
    if (mediaIds.length > 0) {
      const mediaItems = await prisma.media.findMany({
        where: {
          id: { in: mediaIds.map((id) => parseInt(id)) },
        },
      });

      if (mediaItems.length !== mediaIds.length) {
        return res.status(400).json({
          ok: false,
          message: "One or more media items not found",
        });
      }
    }

    const playlist = await prisma.playlist.create({
      data: {
        title: title.trim(),
        playlistItems: {
          create: mediaIds.map((mediaId, index) => ({
            mediaId: parseInt(mediaId),
            order: index,
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

    const transformed = {
      id: playlist.id,
      title: playlist.title,
      mediaIds: playlist.playlistItems.map((item) => item.mediaId),
      items: playlist.playlistItems.map((item) => ({
        id: item.media.id,
        type: item.media.type,
        author: item.media.author,
        title: item.media.title,
        year: item.media.year,
        fileName: item.media.fileName,
        duration: item.media.duration,
        language: item.media.language,
        bpm: item.media.bpm,
      })),
      createdAt: playlist.createdAt,
      updatedAt: playlist.updatedAt,
    };

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
 * PUT /api/playlists/:id - Update playlist
 */
export async function updatePlaylist(req, res, next) {
  try {
    const id = parseInt(req.params.id);
    const { title, mediaIds = [] } = req.body;

    if (!title || typeof title !== "string" || !title.trim()) {
      return res.status(400).json({
        ok: false,
        message: "Playlist title is required",
      });
    }

    // Check if playlist exists
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

    // Verify all media items exist
    if (mediaIds.length > 0) {
      const mediaItems = await prisma.media.findMany({
        where: {
          id: { in: mediaIds.map((id) => parseInt(id)) },
        },
      });

      if (mediaItems.length !== mediaIds.length) {
        return res.status(400).json({
          ok: false,
          message: "One or more media items not found",
        });
      }
    }

    // Update playlist in transaction
    const playlist = await prisma.$transaction(async (tx) => {
      // Delete existing playlist items
      await tx.playlistItem.deleteMany({
        where: { playlistId: id },
      });

      // Update playlist title
      const updatedPlaylist = await tx.playlist.update({
        where: { id },
        data: {
          title: title.trim(),
          playlistItems: {
            create: mediaIds.map((mediaId, index) => ({
              mediaId: parseInt(mediaId),
              order: index,
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

      return updatedPlaylist;
    });

    const transformed = {
      id: playlist.id,
      title: playlist.title,
      mediaIds: playlist.playlistItems.map((item) => item.mediaId),
      items: playlist.playlistItems.map((item) => ({
        id: item.media.id,
        type: item.media.type,
        author: item.media.author,
        title: item.media.title,
        year: item.media.year,
        fileName: item.media.fileName,
        duration: item.media.duration,
        language: item.media.language,
        bpm: item.media.bpm,
      })),
      createdAt: playlist.createdAt,
      updatedAt: playlist.updatedAt,
    };

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
    const id = parseInt(req.params.id);

    // Check if playlist exists
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
 */
export async function addPlaylistItem(req, res, next) {
  try {
    const playlistId = parseInt(req.params.id);
    const { mediaId } = req.body;

    if (!mediaId) {
      return res.status(400).json({
        ok: false,
        message: "Media ID is required",
      });
    }

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

    // Check if media exists
    const media = await prisma.media.findUnique({
      where: { id: parseInt(mediaId) },
    });

    if (!media) {
      return res.status(404).json({
        ok: false,
        message: "Media not found",
      });
    }

    // Check if media is already in playlist
    const existingItem = playlist.playlistItems.find(
      (item) => item.mediaId === parseInt(mediaId)
    );
    if (existingItem) {
      return res.status(400).json({
        ok: false,
        message: "Media already in playlist",
      });
    }

    // Get next order number
    const nextOrder = playlist.playlistItems.length;

    const playlistItem = await prisma.playlistItem.create({
      data: {
        playlistId,
        mediaId: parseInt(mediaId),
        order: nextOrder,
      },
      include: {
        media: true,
      },
    });

    res.status(201).json({
      ok: true,
      item: {
        id: playlistItem.media.id,
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
 */
export async function removePlaylistItem(req, res, next) {
  try {
    const playlistId = parseInt(req.params.id);
    const mediaId = parseInt(req.params.mediaId);

    // Delete the playlist item
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

    // Reorder remaining items
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
