import ffprobeStatic from "ffprobe-static";
import ffmpeg from "fluent-ffmpeg";

ffmpeg.setFfprobePath(ffprobeStatic.path);

/**
 * Parse filename to extract artist and title
 * Common patterns: "Artist - Title", "Artist_Title", "Artist - Title (Remix)"
 */
function parseFileName(filename) {
  const baseName = filename.replace(/\.[^/.]+$/, ""); // Remove extension

  // Try different patterns
  let artist = null;
  let title = baseName;
  let year = null;
  let bpm = null;

  // Pattern 1: "Artist - Title"
  if (baseName.includes(" - ")) {
    const parts = baseName.split(" - ");
    if (parts.length >= 2) {
      artist = parts[0].trim();
      title = parts.slice(1).join(" - ").trim();
    }
  }
  // Pattern 2: "Artist_Title"
  else if (baseName.includes("_")) {
    const parts = baseName.split("_");
    if (parts.length >= 2) {
      artist = parts[0].trim();
      title = parts.slice(1).join("_").trim();
    }
  }

  // Extract year from title (patterns like "Title (2023)" or "Title 2023")
  const yearMatch = title.match(/\((\d{4})\)|(\d{4})$/);
  if (yearMatch) {
    year = parseInt(yearMatch[1] || yearMatch[2]);
    title = title.replace(/\(\d{4}\)|\d{4}$/, "").trim();
  }

  // Extract BPM from filename (patterns like "Title 120BPM" or "Title [128BPM]")
  const bpmMatch =
    baseName.match(/(\d{2,3})\s*BPM/i) || baseName.match(/\[(\d{2,3})BPM\]/i);
  if (bpmMatch) {
    bpm = parseInt(bpmMatch[1]);
  }

  // Clean up common patterns
  title = title
    .replace(/\[Official Video\]/gi, "")
    .replace(/\(Official Audio\)/gi, "")
    .replace(/\(Official\)/gi, "")
    .replace(/\(Lyrics\)/gi, "")
    .replace(/\([^)]*mix\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  return { artist, title, year, bpm };
}

/**
 * Detect media type based on filename and duration
 */
function detectMediaType(filename, durationSec) {
  const lowerName = filename.toLowerCase();

  if (
    lowerName.includes("jingle") ||
    lowerName.includes("intro") ||
    lowerName.includes("outro")
  ) {
    return "JINGLE";
  }

  if (
    lowerName.includes("spot") ||
    lowerName.includes("ad") ||
    lowerName.includes("commercial")
  ) {
    return "SPOT";
  }

  if (durationSec && durationSec <= 60) {
    return "JINGLE";
  }

  if (durationSec && durationSec <= 120) {
    return "SPOT";
  }

  return "SONG";
}

/**
 * Detect language based on filename and metadata
 */
function detectLanguage(filename, artist, title) {
  const text = `${filename} ${artist || ""} ${title || ""}`.toLowerCase();

  // Italian indicators
  const italianWords = [
    "amore",
    "ciao",
    "grazie",
    "bella",
    "bello",
    "ragazzo",
    "ragazza",
    "cuore",
    "vita",
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

  // Default to English if no clear indicators
  return "ENGLISH";
}

/**
 * Extract comprehensive metadata using ffprobe and filename parsing
 */
export function probeFile(filePath, originalName) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) {
        // If ffprobe fails, use only filename parsing
        const fileInfo = parseFileName(originalName);
        const durationSec = null;
        const mediaType = detectMediaType(originalName, durationSec);
        const language = detectLanguage(
          originalName,
          fileInfo.artist,
          fileInfo.title
        );

        const missing = ["duration", "bpm", "title", "author", "year"].filter(
          (field) => {
            if (field === "title") return !fileInfo.title;
            if (field === "author") return !fileInfo.artist;
            if (field === "year") return !fileInfo.year;
            if (field === "bpm") return !fileInfo.bpm;
            if (field === "duration") return !durationSec;
            return true;
          }
        );

        resolve({
          durationSec,
          title: fileInfo.title || originalName.replace(/\.[^/.]+$/, ""),
          artist: fileInfo.artist || "Unknown Artist",
          year: fileInfo.year || new Date().getFullYear(),
          bpm: fileInfo.bpm,
          mediaType,
          language,
          missing,
        });
        return;
      }

      const format = data.format || {};
      const streams = data.streams || [];
      const tags = {
        ...(format.tags || {}),
        ...((streams[0] && streams[0].tags) || {}),
      };

      const durationSec = format.duration
        ? Math.round(Number(format.duration))
        : null;

      // Get metadata from file tags
      const tagTitle = tags.title || tags.TITLE;
      const tagArtist = tags.artist || tags.ARTIST || tags.Author;
      const tagYear = tags.date || tags.year || tags.YEAR;

      // Parse filename for additional info
      const fileInfo = parseFileName(originalName);

      // Combine tag data and filename data (prefer tags)
      const title =
        tagTitle || fileInfo.title || originalName.replace(/\.[^/.]+$/, "");
      const artist = tagArtist || fileInfo.artist || "Unknown Artist";

      let year = null;
      if (tagYear) {
        const y = String(tagYear).match(/\d{4}/);
        year = y ? Number(y[0]) : null;
      }
      year = year || fileInfo.year || new Date().getFullYear();

      const bpm = tags.TBPM
        ? Number(tags.TBPM)
        : tags.bpm
        ? Number(tags.bpm)
        : fileInfo.bpm;

      // Detect media type and language
      const mediaType = detectMediaType(originalName, durationSec);
      const language = detectLanguage(originalName, artist, title);

      // Determine missing metadata
      const missing = [];
      if (!tagTitle && !fileInfo.title) missing.push("title");
      if (!tagArtist && !fileInfo.artist) missing.push("author");
      if (!tagYear && !fileInfo.year) missing.push("year");
      if (!bpm) missing.push("bpm");
      if (!durationSec) missing.push("duration");

      resolve({
        durationSec,
        title,
        artist,
        year,
        bpm,
        mediaType,
        language,
        missing,
      });
    });
  });
}
