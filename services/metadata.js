import ffprobeStatic from "ffprobe-static";
import ffmpeg from "fluent-ffmpeg";
import * as musicMetadata from "music-metadata";

ffmpeg.setFfprobePath(ffprobeStatic.path);

/**
 * Parse filename to extract artist and title
 * Focused only on schema fields: author, title
 */
function parseFileName(filename) {
  const baseName = filename.replace(/\.[^/.]+$/, ""); // Remove extension

  let author = null;
  let title = baseName;

  // Common patterns for "Author - Title"
  const patterns = [
    /^(.*?)\s*[-–—]\s*(.*?)$/, // "Author - Title"
    /^(.*?)_(.*?)$/, // "Author_Title"
  ];

  for (const pattern of patterns) {
    const match = baseName.match(pattern);
    if (match) {
      author = match[1]?.trim() || null;
      title = match[2]?.trim() || baseName;
      break;
    }
  }

  // Clean up common unwanted patterns
  const cleanPatterns = [
    /\[[^\]]*\]/g,
    /\([^)]*\)/g,
    /(official\s*(video|audio|lyrics?|version))/gi,
    /(lyric\s*video)/gi,
  ];

  title = title.replace(cleanPatterns[0], "");
  title = title.replace(/\s+/g, " ").trim();

  return { author, title };
}

/**
 * Detect media type based on filename and duration
 * Only SONG, JINGLE, SPOT as per schema
 */
function detectMediaType(filename, durationSec) {
  const lowerName = filename.toLowerCase();

  // Jingle detection - short audio with specific keywords
  if (
    lowerName.includes("jingle") ||
    lowerName.includes("intro") ||
    lowerName.includes("outro")
  ) {
    return "JINGLE";
  }

  // Spot detection
  if (
    lowerName.includes("spot") ||
    lowerName.includes("ad") ||
    lowerName.includes("commercial")
  ) {
    return "SPOT";
  }

  // Duration-based detection
  if (durationSec && durationSec <= 30) return "JINGLE";
  if (durationSec && durationSec <= 120) return "SPOT";

  // Default to SONG
  return "SONG";
}

/**
 * Detect language - only ENGLISH, ITALIAN, SPANISH, OTHER as per schema
 */
function detectLanguage(filename, author, title) {
  const text = `${filename} ${author || ""} ${title || ""}`.toLowerCase();

  // Italian indicators
  const italianWords = [
    "amore",
    "ciao",
    "grazie",
    "bella",
    "bello",
    "ragazzo",
    "ragazza",
  ];
  if (italianWords.some((word) => text.includes(word))) {
    return "ITALIAN";
  }

  // Spanish indicators
  const spanishWords = [
    "amor",
    "hola",
    "gracias",
    "corazon",
    "vida",
    "mujer",
    "hombre",
  ];
  if (spanishWords.some((word) => text.includes(word))) {
    return "SPANISH";
  }

  // Default to ENGLISH
  return "ENGLISH";
}

/**
 * Extract year from various sources
 */
function extractYear(metadataYear, filename) {
  // Try to extract year from metadata first
  if (metadataYear) {
    const yearMatch = String(metadataYear).match(/\d{4}/);
    if (yearMatch) {
      const year = parseInt(yearMatch[0]);
      if (year > 1900 && year <= new Date().getFullYear() + 1) {
        return year;
      }
    }
  }

  // Try to extract from filename as fallback
  const yearMatch = filename.match(/(\d{4})/);
  if (yearMatch) {
    const year = parseInt(yearMatch[1]);
    if (year > 1900 && year <= new Date().getFullYear() + 1) {
      return year;
    }
  }

  // Default to current year
  return new Date().getFullYear();
}

/**
 * Extract BPM from metadata
 */
function extractBPM(metadataBPM) {
  if (!metadataBPM) return null;

  const bpm = parseInt(metadataBPM);
  if (!isNaN(bpm) && bpm > 30 && bpm < 300) {
    return bpm;
  }
  return null;
}

/**
 * Extract duration and round to seconds
 */
function extractDuration(duration) {
  if (!duration) return 0;
  return Math.round(duration);
}

/**
 * Extract metadata using ffprobe
 */
function extractMetadataWithFFprobe(filePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err || !data) {
        resolve(null);
        return;
      }

      const format = data.format || {};
      const streams = data.streams || [];

      // Merge all tags
      let mergedTags = { ...(format.tags || {}) };
      streams.forEach((stream) => {
        mergedTags = { ...mergedTags, ...(stream.tags || {}) };
      });

      // Helper function to get tag value case-insensitively
      const getTag = (keys) => {
        const lowerMap = {};
        Object.keys(mergedTags).forEach((k) => {
          lowerMap[k.toLowerCase()] = mergedTags[k];
        });

        for (const key of keys) {
          const value = lowerMap[key.toLowerCase()];
          if (
            value !== undefined &&
            value !== null &&
            `${value}`.trim() !== ""
          ) {
            return `${value}`.trim();
          }
        }
        return null;
      };

      resolve({
        duration: format.duration,
        bitrate: format.bitrate,
        title: getTag(["title", "TITLE"]),
        artist: getTag(["artist", "ARTIST", "author", "ALBUM_ARTIST"]),
        year: getTag(["date", "year", "YEAR", "creation_time"]),
        bpm: getTag(["TBPM", "bpm", "BPM", "tempo"]),
      });
    });
  });
}

/**
 * Main metadata extraction focused only on schema fields
 */
export async function probeFile(filePath, originalName) {
  try {
    let musicMeta = null;
    let ffprobeMeta = null;

    // Check if file exists before processing
    const fs = await import("fs-extra");
    if (!(await fs.pathExists(filePath))) {
      throw new Error(`File not found: ${filePath}`);
    }

    // Try music-metadata first (better for audio files)
    try {
      musicMeta = await musicMetadata.parseFile(filePath);
    } catch (error) {
      console.warn("music-metadata failed:", error.message);
    }

    // Try ffprobe as fallback
    try {
      ffprobeMeta = await extractMetadataWithFFprobe(filePath);
    } catch (error) {
      console.warn("ffprobe failed:", error.message);
    }

    // Parse filename for basic info
    const fileInfo = parseFileName(originalName);

    // Extract duration from available sources
    let durationSec = 0;
    if (musicMeta?.format?.duration) {
      durationSec = extractDuration(musicMeta.format.duration);
    } else if (ffprobeMeta?.duration) {
      durationSec = extractDuration(ffprobeMeta.duration);
    }

    // Extract author/artist
    let author = fileInfo.author || "Unknown Artist";
    if (musicMeta?.common?.artist) {
      author = musicMeta.common.artist;
    } else if (ffprobeMeta?.artist) {
      author = ffprobeMeta.artist;
    }

    // Extract title
    let title = fileInfo.title || originalName.replace(/\.[^/.]+$/, "");
    if (musicMeta?.common?.title) {
      title = musicMeta.common.title;
    } else if (ffprobeMeta?.title) {
      title = ffprobeMeta.title;
    }

    // Extract year
    let year = new Date().getFullYear();
    if (musicMeta?.common?.year) {
      year = extractYear(musicMeta.common.year, originalName);
    } else if (ffprobeMeta?.year) {
      year = extractYear(ffprobeMeta.year, originalName);
    }

    // Extract BPM
    let bpm = null;
    if (musicMeta?.common?.bpm) {
      bpm = extractBPM(musicMeta.common.bpm);
    } else if (ffprobeMeta?.bpm) {
      bpm = extractBPM(ffprobeMeta.bpm);
    }

    // Detect media type and language
    const mediaType = detectMediaType(originalName, durationSec);
    const language = detectLanguage(originalName, author, title);

    // Determine missing fields
    const missing = [];
    if (!title || title === originalName.replace(/\.[^/.]+$/, ""))
      missing.push("title");
    if (!author || author === "Unknown Artist") missing.push("author");
    if (!year) missing.push("year");
    if (!bpm) missing.push("bpm");
    if (!durationSec) missing.push("duration");

    return {
      // Required fields for Media model
      type: mediaType,
      author: author,
      title: title,
      year: year,
      fileName: originalName,
      language: language,
      bpm: bpm,
      durationSec: durationSec,
      missing: missing,

      // Additional info for debugging
      source: {
        musicMetadata: !!musicMeta,
        ffprobe: !!ffprobeMeta,
        filename: true,
      },
    };
  } catch (error) {
    console.error("Metadata extraction completely failed:", error);

    // Fallback to absolute minimum using filename only
    const fileInfo = parseFileName(originalName);
    const mediaType = detectMediaType(originalName, null);
    const language = detectLanguage(
      originalName,
      fileInfo.author,
      fileInfo.title
    );

    return {
      type: mediaType,
      author: fileInfo.author || "Unknown Artist",
      title: fileInfo.title || originalName.replace(/\.[^/.]+$/, ""),
      year: new Date().getFullYear(),
      fileName: originalName,
      language: language,
      bpm: null,
      durationSec: 0,
      missing: ["duration", "bpm"],
      source: {
        musicMetadata: false,
        ffprobe: false,
        filename: true,
      },
    };
  }
}

export { detectLanguage, detectMediaType, parseFileName };
