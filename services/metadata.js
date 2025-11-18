import ffprobeStatic from "ffprobe-static";
import ffmpeg from "fluent-ffmpeg";
import * as musicMetadata from "music-metadata";

ffmpeg.setFfprobePath(ffprobeStatic.path);

/* ───────────────────────── Helpers ───────────────────────── */

/**
 * Check if a token looks like a website / downloader prefix.
 * Examples caught: "SSYouTube.online", "yt1s.com", "y2mate.com"
 */
function isWebsiteToken(token) {
  if (!token) return false;
  const t = String(token).toLowerCase().trim();
  if (!t) return false;

  // Common downloaders / converters
  const known = [
    "ssyoutube.online",
    "ssyoutube",
    "yt1s.com",
    "yt1s",
    "y2mate.com",
    "y2mate",
    "tomp3",
    "savefrom",
  ];
  if (known.includes(t)) return true;

  // Generic domain pattern
  if (/(?:www\.)?[a-z0-9-]+\.(?:com|net|org|online|info|co|io|xyz)$/.test(t)) {
    return true;
  }
  return false;
}

/**
 * Check if token is a "quality / tech" marker like 144p, 720p, HD, 4K, etc.
 */
function isQualityToken(token) {
  if (!token) return false;
  const t = String(token).toLowerCase();
  return /\b(\d{3,4}p|[0-9]{3,4}x[0-9]{3,4}|4k|8k|hdr|uhd|hd|hq|1080i)\b/.test(
    t
  );
}

/**
 * Check if token is a common music/show prefix that should be ignored
 */
function isNoiseToken(token) {
  if (!token) return false;
  const t = String(token).toLowerCase();
  const noiseWords = [
    "coke",
    "studio",
    "bangla",
    "season",
    "episode",
    "ep",
    "official",
    "video",
    "audio",
    "lyrics",
    "lyric",
    "version",
    "full",
    "hd",
    "officialvideo",
    "officialaudio",
  ];
  return noiseWords.includes(t);
}

/**
 * Remove bracketed stuff + "official video" etc + quality tags
 * and collapse whitespace.
 */
function cleanTitleLikeString(str) {
  if (!str) return str;
  let r = String(str);

  // Remove [brackets] and (parentheses)
  r = r.replace(/\[[^\]]*\]/g, "");
  r = r.replace(/\([^)]*\)/g, "");

  // Remove common noise words
  r = r.replace(
    /\b(official\s*(video|audio|lyrics?|version)|lyric\s*video|music\s*video|full\s*video|audio\s*only)\b/gi,
    ""
  );

  // Remove quality markers
  r = r.replace(/\b(\d{3,4}p|4k|8k|hdr|uhd|hd|hq)\b/gi, "");

  // Collapse spaces
  r = r.replace(/\s+/g, " ").trim();
  return r;
}

/**
 * Parse filename to extract artist and title.
 * Improved logic to handle various patterns including tail artists.
 */
function parseFileName(filename) {
  const baseName = String(filename || "").replace(/\.[^/.]+$/, ""); // Remove extension

  // Normalize spaces and special characters
  let work = baseName.replace(/\s+/g, " ").trim();

  // Replace multiple dashes with single dash
  work = work.replace(/[-–—]+/g, " - ");

  // Strip common website/downloader prefixes
  work = work.replace(
    /^(?:www\.)?(?:[a-z0-9-]+\.)+(?:com|net|org|online|info|co|io|xyz)\s*[_-]\s*/i,
    ""
  );
  work = work.replace(
    /^(ssyoutube(?:\.online)?|yt1s|y2mate|tomp3|savefrom)\s*[_-]\s*/i,
    ""
  );

  let author = null;
  let title = work || baseName;

  const tokens = work.split(/\s+/).filter(Boolean);
  const connectorRegex = /^(x|ft\.?|feat\.?|featuring|vs\.?|&)$/i;

  // ── 1. "Artist - Title" (most common, keep first) ──────────────────────
  let m = work.match(/^(.*?)\s*[-–—]\s*(.+)$/);
  if (m) {
    const potentialAuthor = m[1]?.trim() || "";
    const potentialTitle = m[2]?.trim() || "";

    // Only use this pattern if the author part doesn't look like a title
    if (
      !isNoiseToken(potentialAuthor.split(/\s+/)[0]) &&
      potentialAuthor.length > 0 &&
      potentialTitle.length > 0
    ) {
      author = potentialAuthor;
      title = potentialTitle;
    }
  }

  // ── 2. "Title ... Artist" pattern (for cases like your example) ────────
  if (!author) {
    // Look for connector tokens (x, ft, feat) to identify artist at the end
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (connectorRegex.test(tokens[i])) {
        // Found a connector, check if we have artist names around it
        const artistStartIndex = findArtistStartIndex(tokens, i);
        if (artistStartIndex !== -1 && artistStartIndex > 0) {
          author = tokens.slice(artistStartIndex).join(" ").trim();
          title = tokens.slice(0, artistStartIndex).join(" ").trim();
          break;
        }
      }
    }
  }

  // ── 3. "Artist_Title" but avoid website prefixes on the left ───────────
  if (!author) {
    m = work.match(/^(.*?)_(.+)$/);
    if (m) {
      const left = m[1]?.trim() || "";
      const right = m[2]?.trim() || "";
      if (isWebsiteToken(left)) {
        title = right || work;
      } else {
        author = left || null;
        title = right || work;
      }
    }
  }

  // ── 4. Fallback: Try to extract artist from known patterns ─────────────
  if (!author) {
    // Look for any connector in the entire string
    for (let i = 0; i < tokens.length; i++) {
      if (connectorRegex.test(tokens[i])) {
        const artistStartIndex = findArtistStartIndex(tokens, i);
        if (artistStartIndex !== -1) {
          author = tokens.slice(artistStartIndex).join(" ").trim();
          title = tokens.slice(0, artistStartIndex).join(" ").trim();
          break;
        }
      }
    }
  }

  // Clean up the results
  title = cleanTitleLikeString(title || baseName);
  if (!title) {
    title = cleanTitleLikeString(baseName) || baseName;
  }

  // If we still don't have an author, use a more aggressive approach
  if (!author) {
    author = extractArtistFromTitle(title) || "Unknown Artist";
    if (author !== "Unknown Artist") {
      // Remove the artist name from title if we found it
      const artistRegex = new RegExp(
        author.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i"
      );
      title = cleanTitleLikeString(title.replace(artistRegex, ""));
    }
  }

  return { author, title };
}

/**
 * Helper to find where the artist name starts in token array
 */
function findArtistStartIndex(tokens, connectorIndex) {
  // Look backwards for the start of artist name
  let start = connectorIndex;
  let hasNameBefore = false;
  let hasNameAfter = false;

  // Check if there's a name before the connector
  if (connectorIndex > 0) {
    const tokenBefore = tokens[connectorIndex - 1];
    if (isNameLikeToken(tokenBefore) && !isNoiseToken(tokenBefore)) {
      hasNameBefore = true;
      start = connectorIndex - 1;
    }
  }

  // Check if there's a name after the connector
  if (connectorIndex < tokens.length - 1) {
    const tokenAfter = tokens[connectorIndex + 1];
    if (isNameLikeToken(tokenAfter) && !isNoiseToken(tokenAfter)) {
      hasNameAfter = true;
    }
  }

  // If we have names around connector, expand to find full artist name
  if (hasNameBefore || hasNameAfter) {
    // Expand backwards
    while (
      start > 0 &&
      isNameLikeToken(tokens[start - 1]) &&
      !isNoiseToken(tokens[start - 1])
    ) {
      start--;
    }

    // Expand forwards to include the full artist name
    let end = Math.min(connectorIndex + 2, tokens.length - 1);
    while (
      end < tokens.length - 1 &&
      isNameLikeToken(tokens[end + 1]) &&
      !isNoiseToken(tokens[end + 1])
    ) {
      end++;
    }

    return start;
  }

  return -1;
}

/**
 * Check if token looks like a name
 */
function isNameLikeToken(token) {
  if (!token) return false;
  const t = String(token);

  // Single letter tokens are usually not names (except initials)
  if (t.length === 1 && !/[A-Z]/.test(t)) return false;

  // Common noise words
  if (isNoiseToken(t)) return false;

  // Quality tokens
  if (isQualityToken(t)) return false;

  // Looks like capitalized name or has typical name pattern
  return (
    /^[A-ZÀ-Ý][a-zà-ÿ'.-]*$/.test(t) ||
    /^[A-Z]{2,}$/.test(t) ||
    /^[a-z]+$/.test(t)
  ); // Allow lowercase names too
}

/**
 * Extract artist name from title using common patterns
 */
function extractArtistFromTitle(title) {
  const tokens = title.split(/\s+/);
  const connectorRegex = /^(x|ft\.?|feat\.?|featuring|vs\.?|&)$/i;

  // Look for connector patterns
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (connectorRegex.test(tokens[i])) {
      const artistStartIndex = findArtistStartIndex(tokens, i);
      if (artistStartIndex !== -1) {
        return tokens.slice(artistStartIndex).join(" ").trim();
      }
    }
  }

  return null;
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

    // Parse filename for basic info (our improved heuristics)
    const fileInfo = parseFileName(originalName);

    // Extract duration from available sources
    let durationSec = 0;
    if (musicMeta?.format?.duration) {
      durationSec = extractDuration(musicMeta.format.duration);
    } else if (ffprobeMeta?.duration) {
      durationSec = extractDuration(ffprobeMeta.duration);
    }

    // Extract author/artist - prioritize metadata over filename parsing
    let author = null;
    if (musicMeta?.common?.artist) {
      author = musicMeta.common.artist;
    } else if (ffprobeMeta?.artist) {
      author = ffprobeMeta.artist;
    }

    // Use filename parsing only if metadata didn't provide artist
    if (!author || author === "Unknown Artist") {
      author = fileInfo.author || "Unknown Artist";
    }

    // Extract title - prioritize metadata over filename parsing
    let title = null;
    if (musicMeta?.common?.title) {
      title = cleanTitleLikeString(musicMeta.common.title);
    } else if (ffprobeMeta?.title) {
      title = cleanTitleLikeString(ffprobeMeta.title);
    }

    // Use filename parsing only if metadata didn't provide title
    if (!title) {
      title =
        fileInfo.title || originalName.replace(/\.[^/.]+$/, "") || originalName;
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
