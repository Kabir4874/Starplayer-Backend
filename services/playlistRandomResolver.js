// src/services/playlistRandomResolver.js
import { prisma } from "./prisma.js";

/**
 * Pick a random Media of given MediaType (SONG/JINGLE/SPOT),
 * excluding already used mediaIds (no reuse within single playlist).
 * No fallback to other types.
 */
async function pickRandomMediaByType(type, excludeIds = []) {
  const where =
    excludeIds.length > 0
      ? { type, NOT: { id: { in: excludeIds } } }
      : { type };

  const total = await prisma.media.count({ where });

  if (!total) return null; // No unique songs left, skip this slot

  const skip = Math.floor(Math.random() * total);
  const [result] = await prisma.media.findMany({
    where,
    orderBy: { id: "asc" },
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

  const usedMediaIds = new Set(
    (playlist.playlistItems || [])
      .filter((item) => item.mediaId)
      .map((item) => item.mediaId)
  );
  const resolved = [];

  for (const item of playlist.playlistItems) {
    if (item.kind === "RANDOM" || (!item.media && item.randomType)) {
      const randomType = "SONG";

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
