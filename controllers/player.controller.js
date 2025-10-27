import {
  casparPause,
  casparPlay,
  casparResume,
  casparStop,
} from "../services/caspar.js";
import { prisma } from "../services/prisma.js";

/**
 * POST /api/player/play - Play media with options
 */
export async function playMedia(req, res, next) {
  try {
    const {
      mediaId,
      fileName,
      channel = 1,
      layer = 10,
      playOnCaspar = true,
      playInBrowser = true,
    } = req.body;

    let media;
    if (mediaId) {
      media = await prisma.media.findUnique({
        where: { id: parseInt(mediaId) },
      });
    } else if (fileName) {
      media = await prisma.media.findFirst({
        where: { fileName },
      });
    }

    if (!media && !fileName) {
      return res.status(404).json({
        ok: false,
        message: "Media not found",
      });
    }

    const targetFileName = media ? media.fileName : fileName;

    // Play on CasparCG if requested
    let casparResponse = null;
    if (playOnCaspar) {
      try {
        casparResponse = await casparPlay(targetFileName, channel, layer);
      } catch (error) {
        console.error("CasparCG play error:", error);
      }
    }

    // Add to history
    if (media) {
      await prisma.history.create({
        data: {
          mediaId: media.id,
          datetime: new Date(),
        },
      });
    }

    res.json({
      ok: true,
      media: media || { fileName: targetFileName },
      playOnCaspar: playOnCaspar,
      playInBrowser: playInBrowser,
      casparResponse: casparResponse,
      streamUrl: `/api/media/stream/${targetFileName}`,
      message: "Media playback started",
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/player/stop - Stop playback
 */
export async function stopPlayback(req, res, next) {
  try {
    const { channel = 1, layer = 10 } = req.body;

    const casparResponse = await casparStop(channel, layer);

    res.json({
      ok: true,
      casparResponse: casparResponse,
      message: "Playback stopped",
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/player/pause - Pause playback
 */
export async function pausePlayback(req, res, next) {
  try {
    const { channel = 1, layer = 10 } = req.body;

    const casparResponse = await casparPause(channel, layer);

    res.json({
      ok: true,
      casparResponse: casparResponse,
      message: "Playback paused",
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/player/resume - Resume playback
 */
export async function resumePlayback(req, res, next) {
  try {
    const { channel = 1, layer = 10 } = req.body;

    const casparResponse = await casparResume(channel, layer);

    res.json({
      ok: true,
      casparResponse: casparResponse,
      message: "Playback resumed",
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/player/playlist/play - Play entire playlist
 */
export async function playPlaylist(req, res, next) {
  try {
    const {
      playlistId,
      channel = 1,
      startLayer = 10,
      delayBetween = 2000,
    } = req.body;

    const playlist = await prisma.playlist.findUnique({
      where: { id: parseInt(playlistId) },
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

    if (playlist.playlistItems.length === 0) {
      return res.status(400).json({
        ok: false,
        message: "Playlist is empty",
      });
    }

    // Play first item immediately
    const firstItem = playlist.playlistItems[0];
    await casparPlay(firstItem.media.fileName, channel, startLayer);

    // Add first item to history
    await prisma.history.create({
      data: {
        mediaId: firstItem.mediaId,
        datetime: new Date(),
      },
    });

    res.json({
      ok: true,
      playlist: {
        id: playlist.id,
        title: playlist.title,
        totalItems: playlist.playlistItems.length,
      },
      currentlyPlaying: {
        media: firstItem.media,
        layer: startLayer,
      },
      message: `Playlist "${playlist.title}" started playing`,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/player/now-playing - Get currently playing media
 */
export async function getNowPlaying(req, res, next) {
  try {
    // Get the most recent history entry as "now playing"
    const recentPlay = await prisma.history.findFirst({
      orderBy: {
        datetime: "desc",
      },
      include: {
        media: true,
      },
    });

    res.json({
      ok: true,
      nowPlaying: recentPlay || null,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/player/quick-play - Quick play by filename (for testing)
 */
export async function quickPlay(req, res, next) {
  try {
    const { fileName, channel = 1, layer = 10 } = req.body;

    if (!fileName) {
      return res.status(400).json({
        ok: false,
        message: "FileName is required",
      });
    }

    const casparResponse = await casparPlay(fileName, channel, layer);

    res.json({
      ok: true,
      fileName,
      casparResponse,
      message: `Quick playing: ${fileName}`,
    });
  } catch (error) {
    next(error);
  }
}
