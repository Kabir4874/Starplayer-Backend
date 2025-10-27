import { prisma } from "../services/prisma.js";

export async function listHistory(req, res, next) {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const page = parseInt(req.query.page) || 1;
    const skip = (page - 1) * limit;

    const history = await prisma.history.findMany({
      include: {
        media: true,
      },
      orderBy: {
        datetime: "desc",
      },
      skip,
      take: limit,
    });

    const total = await prisma.history.count();

    const transformed = history.map((record) => ({
      id: record.id,
      mediaId: record.mediaId,
      datetime: record.datetime,
      media: {
        id: record.media.id,
        type: record.media.type,
        author: record.media.author,
        title: record.media.title,
        year: record.media.year,
        fileName: record.media.fileName,
        duration: record.media.duration,
        language: record.media.language,
        bpm: record.media.bpm,
      },
    }));

    res.json({
      ok: true,
      history: transformed,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/history - Add history record
 */
export async function addHistory(req, res, next) {
  try {
    const { mediaId } = req.body;

    if (!mediaId) {
      return res.status(400).json({
        ok: false,
        message: "Media ID is required",
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

    const history = await prisma.history.create({
      data: {
        mediaId: parseInt(mediaId),
        datetime: new Date(),
      },
      include: {
        media: true,
      },
    });

    const transformed = {
      id: history.id,
      mediaId: history.mediaId,
      datetime: history.datetime,
      media: {
        id: history.media.id,
        type: history.media.type,
        author: history.media.author,
        title: history.media.title,
        year: history.media.year,
        fileName: history.media.fileName,
        duration: history.media.duration,
        language: history.media.language,
        bpm: history.media.bpm,
      },
    };

    res.status(201).json({
      ok: true,
      history: transformed,
      message: "History record added",
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/history/today - Get today's history
 */
export async function getTodayHistory(req, res, next) {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const history = await prisma.history.findMany({
      where: {
        datetime: {
          gte: today,
          lt: tomorrow,
        },
      },
      include: {
        media: true,
      },
      orderBy: {
        datetime: "desc",
      },
    });

    const transformed = history.map((record) => ({
      id: record.id,
      mediaId: record.mediaId,
      datetime: record.datetime,
      media: {
        id: record.media.id,
        type: record.media.type,
        author: record.media.author,
        title: record.media.title,
        year: record.media.year,
        fileName: record.media.fileName,
        duration: record.media.duration,
        language: record.media.language,
        bpm: record.media.bpm,
      },
    }));

    res.json({
      ok: true,
      history: transformed,
      date: today,
      count: history.length,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /api/history/:id - Delete history record
 */
export async function deleteHistory(req, res, next) {
  try {
    const id = parseInt(req.params.id);

    const history = await prisma.history.findUnique({
      where: { id },
    });

    if (!history) {
      return res.status(404).json({
        ok: false,
        message: "History record not found",
      });
    }

    await prisma.history.delete({
      where: { id },
    });

    res.json({
      ok: true,
      message: "History record deleted",
    });
  } catch (error) {
    next(error);
  }
}
