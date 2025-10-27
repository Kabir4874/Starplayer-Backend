import { prisma } from "../services/prisma.js";

/**
 * GET /api/schedules - Get all schedules
 */
export async function listSchedules(req, res, next) {
  try {
    const schedules = await prisma.schedule.findMany({
      include: {
        playlist: {
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
        },
      },
      orderBy: {
        datetime: "asc",
      },
    });

    const transformed = schedules.map((schedule) => ({
      id: schedule.id,
      playlistId: schedule.playlistId,
      datetime: schedule.datetime,
      playlist: {
        id: schedule.playlist.id,
        title: schedule.playlist.title,
        mediaIds: schedule.playlist.playlistItems.map((item) => item.mediaId),
      },
    }));

    res.json({
      ok: true,
      schedules: transformed,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/schedules - Create new schedule
 */
export async function createSchedule(req, res, next) {
  try {
    const { playlistId, datetime } = req.body;

    if (!playlistId || !datetime) {
      return res.status(400).json({
        ok: false,
        message: "Playlist ID and datetime are required",
      });
    }

    // Check if playlist exists
    const playlist = await prisma.playlist.findUnique({
      where: { id: parseInt(playlistId) },
    });

    if (!playlist) {
      return res.status(404).json({
        ok: false,
        message: "Playlist not found",
      });
    }

    const schedule = await prisma.schedule.create({
      data: {
        playlistId: parseInt(playlistId),
        datetime: new Date(datetime),
      },
      include: {
        playlist: {
          include: {
            playlistItems: {
              include: {
                media: true,
              },
            },
          },
        },
      },
    });

    const transformed = {
      id: schedule.id,
      playlistId: schedule.playlistId,
      datetime: schedule.datetime,
      playlist: {
        id: schedule.playlist.id,
        title: schedule.playlist.title,
        mediaIds: schedule.playlist.playlistItems.map((item) => item.mediaId),
      },
    };

    res.status(201).json({
      ok: true,
      schedule: transformed,
      message: "Schedule created successfully",
    });
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /api/schedules/:id - Delete schedule
 */
export async function deleteSchedule(req, res, next) {
  try {
    const id = parseInt(req.params.id);

    const schedule = await prisma.schedule.findUnique({
      where: { id },
    });

    if (!schedule) {
      return res.status(404).json({
        ok: false,
        message: "Schedule not found",
      });
    }

    await prisma.schedule.delete({
      where: { id },
    });

    res.json({
      ok: true,
      message: "Schedule deleted successfully",
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/schedules/upcoming - Get upcoming schedules
 */
export async function getUpcomingSchedules(req, res, next) {
  try {
    const now = new Date();

    const schedules = await prisma.schedule.findMany({
      where: {
        datetime: {
          gte: now,
        },
      },
      include: {
        playlist: {
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
        },
      },
      orderBy: {
        datetime: "asc",
      },
      take: 10, // Limit to next 10 schedules
    });

    const transformed = schedules.map((schedule) => ({
      id: schedule.id,
      playlistId: schedule.playlistId,
      datetime: schedule.datetime,
      playlist: {
        id: schedule.playlist.id,
        title: schedule.playlist.title,
        mediaIds: schedule.playlist.playlistItems.map((item) => item.mediaId),
        items: schedule.playlist.playlistItems.map((item) => ({
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
      },
    }));

    res.json({
      ok: true,
      schedules: transformed,
      currentTime: now,
    });
  } catch (error) {
    next(error);
  }
}
