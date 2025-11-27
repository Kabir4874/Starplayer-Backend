// src/services/playlistRandomResolver.js
import { prisma } from "./prisma.js";

/**
 * Pick a random Media of given MediaType (SONG/JINGLE/SPOT),
 * optionally excluding some mediaIds (already used in this playlist instance).
 */
async function pickRandomMediaByType(type, excludeIds = []) {
  const where = {
    type,
    ...(excludeIds.length ? { NOT: { id: { in: excludeIds } } } : {}),
  };

  const total = await prisma.media.count({ where });
  if (!total) return null;

  const skip = Math.floor(Math.random() * total);
  const [result] = await prisma.media.findMany({
    where,
    orderBy: { id: "asc" }, // deterministic ordering + random skip
    skip,
    take: 1,
  });

  return result || null;
}

/**
 * Resolve a Playlist (including RANDOM slots) into an ordered list of
 * "playable" items for a single run of that playlist.
 *
 * Each returned item:
 *   {
 *     playlistId,
 *     playlistItemId,
 *     kind: "FIXED"|"RANDOM",
 *     randomType: "SONG"|"JINGLE"|"SPOT"|null,
 *     media: Media
 *   }
 *
 * NOTE: RANDOM items are resolved fresh on each call, so if a playlist
 * is used multiple times in schedules, it will produce different songs.
 */
export async function resolvePlaylistForSchedule(playlistId) {
  const playlist = await prisma.playlist.findUnique({
    where: { id: playlistId },
    include: {
      playlistItems: {
        include: { media: true },
        orderBy: { order: "asc" },
      },
    },
  });

  if (!playlist) {
    throw new Error(`Playlist not found for id=${playlistId}`);
  }

  const usedMediaIds = new Set();
  const resolved = [];

  for (const item of playlist.playlistItems) {
    if (item.kind === "RANDOM" || (!item.media && item.randomType)) {
      const randomType = item.randomType || "SONG";

      const media = await pickRandomMediaByType(
        randomType,
        Array.from(usedMediaIds)
      );

      if (!media) {
        // No candidate available for this RANDOM slot; skip it
        // or you can choose to throw if you prefer strict behaviour.
        // For now we just skip.
        continue;
      }

      usedMediaIds.add(media.id);

      resolved.push({
        playlistId: playlist.id,
        playlistItemId: item.id,
        kind: "RANDOM",
        randomType,
        media,
      });
    } else if (item.media) {
      const media = item.media;
      usedMediaIds.add(media.id);

      resolved.push({
        playlistId: playlist.id,
        playlistItemId: item.id,
        kind: item.kind || "FIXED",
        randomType: null,
        media,
      });
    }
  }

  return resolved;
}

/**
 * Helper to resolve just *one* RANDOM slot (if you ever need it separately).
 */
export async function resolveSingleRandomSlot(
  randomType,
  excludeMediaIds = []
) {
  const type = (randomType || "SONG").toUpperCase();
  if (!["SONG", "JINGLE", "SPOT"].includes(type)) {
    throw new Error(`Invalid randomType: ${randomType}`);
  }
  const media = await pickRandomMediaByType(type, excludeMediaIds);
  return media;
}
