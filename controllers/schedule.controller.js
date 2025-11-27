// src/controllers/schedule.controller.js
import { prisma } from "../services/prisma.js";

/* ───────────────────────── Helpers ───────────────────────── */

/**
 * Same serializer as playlist.controller (duplicated here to avoid extra imports).
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
 * GET /api/schedules - Get all schedules (with slim playlist info)
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
        mediaIds: (schedule.playlist.playlistItems || [])
          .filter((it) => it.kind === "FIXED" && it.mediaId != null)
          .map((it) => it.mediaId),
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
 * Body: { playlistId:number, datetime: ISO string }
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

    const pid = parseInt(playlistId, 10);
    if (Number.isNaN(pid)) {
      return res.status(400).json({
        ok: false,
        message: "Invalid playlistId",
      });
    }

    const playlist = await prisma.playlist.findUnique({
      where: { id: pid },
    });
    if (!playlist) {
      return res.status(404).json({
        ok: false,
        message: "Playlist not found",
      });
    }

    const dt = new Date(datetime);
    if (Number.isNaN(dt.getTime())) {
      return res.status(400).json({
        ok: false,
        message: "Invalid datetime",
      });
    }

    const schedule = await prisma.schedule.create({
      data: {
        playlistId: pid,
        datetime: dt,
      },
      include: {
        playlist: {
          include: {
            playlistItems: {
              include: {
                media: true,
              },
              orderBy: { order: "asc" },
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
        mediaIds: (schedule.playlist.playlistItems || [])
          .filter((it) => it.kind === "FIXED" && it.mediaId != null)
          .map((it) => it.mediaId),
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
    const id = parseInt(req.params.id, 10);

    if (Number.isNaN(id)) {
      return res
        .status(400)
        .json({ ok: false, message: "Invalid schedule id" });
    }

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
 * GET /api/schedules/upcoming - Get upcoming schedules (next 10)
 */
export async function getUpcomingSchedules(req, res, next) {
  try {
    const now = new Date();

    const schedules = await prisma.schedule.findMany({
      where: {
        datetime: { gte: now },
      },
      include: {
        playlist: {
          include: {
            playlistItems: {
              include: { media: true },
              orderBy: { order: "asc" },
            },
          },
        },
      },
      orderBy: {
        datetime: "asc",
      },
      take: 10,
    });

    const transformed = schedules.map((schedule) => ({
      id: schedule.id,
      playlistId: schedule.playlistId,
      datetime: schedule.datetime,
      playlist: serializePlaylistForClient(schedule.playlist),
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

/**
 * PUT /api/schedules/:id - Update schedule
 * Body can include { playlistId?: number, datetime?: ISO string }
 */
export async function updateSchedule(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    const { playlistId, datetime } = req.body;

    if (Number.isNaN(id)) {
      return res
        .status(400)
        .json({ ok: false, message: "Invalid schedule id" });
    }

    const existing = await prisma.schedule.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ ok: false, message: "Schedule not found" });
    }

    const data = {};

    if (playlistId !== undefined && playlistId !== null) {
      const pid = parseInt(playlistId, 10);
      if (Number.isNaN(pid)) {
        return res
          .status(400)
          .json({ ok: false, message: "Invalid playlistId" });
      }
      const playlist = await prisma.playlist.findUnique({ where: { id: pid } });
      if (!playlist) {
        return res
          .status(404)
          .json({ ok: false, message: "Playlist not found" });
      }
      data.playlistId = pid;
    }

    if (datetime !== undefined && datetime !== null) {
      const dt = new Date(datetime);
      if (Number.isNaN(dt.getTime())) {
        return res.status(400).json({ ok: false, message: "Invalid datetime" });
      }
      data.datetime = dt;
    }

    if (!Object.keys(data).length) {
      return res.status(400).json({
        ok: false,
        message: "Nothing to update. Provide playlistId and/or datetime.",
      });
    }

    const schedule = await prisma.schedule.update({
      where: { id },
      data,
      include: {
        playlist: {
          include: {
            playlistItems: {
              include: { media: true },
              orderBy: { order: "asc" },
            },
          },
        },
      },
    });

    const transformed = {
      id: schedule.id,
      playlistId: schedule.playlistId,
      datetime: schedule.datetime,
      playlist: serializePlaylistForClient(schedule.playlist),
    };

    res.json({
      ok: true,
      schedule: transformed,
      message: "Schedule updated successfully",
    });
  } catch (error) {
    next(error);
  }
}
