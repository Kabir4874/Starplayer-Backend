// src/services/scheduler.js
import { casparPlay, casparStop } from "./caspar.js";
import { prisma } from "./prisma.js";

/**
 * Robust schedule runner with proper queue management:
 * - Polls DB for due schedules (datetime <= now)
 * - When due, stops current playback and plays the playlist sequentially
 * - After finishing ALL items in playlist, deletes the schedule
 * - Processes schedules in chronological order
 * - Prevents overlapping playback
 */

const CHANNEL = 1;
const LAYER = 10;
const TICK_MS = 2000; // poll every 2 seconds
const SAFETY_MIN_DURATION_MS = 5000; // fallback if media.duration missing (5s)

let _started = false;
let _tickHandle = null;

// In-process lock so the same schedule isn't picked twice within this instance.
const _claimed = new Set();

// Current running job state (for observability)
let _runningJob = null;

// Store current playing media for frontend
let _currentPlayingMedia = null;
let _currentMediaStartTime = null;

// Event emitter for frontend updates
const _eventCallbacks = new Set();

// Queue for multiple schedules - process them in order
let _scheduleQueue = [];
let _isProcessingQueue = false;

/**
 * Utility: sleep for ms
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Emit events to frontend
 */
function emitEvent(event, data) {
  _eventCallbacks.forEach((callback) => {
    try {
      callback(event, data);
    } catch (error) {
      console.error("Error in event callback:", error);
    }
  });
}

/**
 * Subscribe to scheduler events
 */
export function onSchedulerEvent(callback) {
  _eventCallbacks.add(callback);
  return () => _eventCallbacks.delete(callback);
}

/**
 * Get current playing media for frontend
 */
export function getCurrentPlayingMedia() {
  if (!_currentPlayingMedia) return null;

  // Calculate elapsed time
  const elapsed = _currentMediaStartTime
    ? Date.now() - _currentMediaStartTime
    : 0;
  const progress = _currentPlayingMedia.duration
    ? Math.min(100, (elapsed / (_currentPlayingMedia.duration * 1000)) * 100)
    : 0;

  return {
    ..._currentPlayingMedia,
    elapsed: Math.floor(elapsed / 1000),
    progress,
    startTime: _currentMediaStartTime,
  };
}

/**
 * Stop anything playing on Caspar on our channel/layer.
 * Ignore errors so scheduler never crashes.
 */
async function stopCurrentPlayback() {
  try {
    await casparStop(CHANNEL, LAYER);
  } catch (e) {
    // ignore; nothing playing or transient error
    console.log(
      "[Scheduler] Stop playback - nothing playing or error:",
      e.message
    );
  }
}

/**
 * Fetch all due schedules (oldest first).
 * We DO NOT delete here; deletion happens after successful run.
 */
async function getDueSchedules() {
  const now = new Date();
  return prisma.schedule.findMany({
    where: {
      datetime: { lte: now },
    },
    orderBy: { datetime: "asc" }, // Process in chronological order
    select: {
      id: true,
      datetime: true,
      playlistId: true,
    },
  });
}

/**
 * Resolve playlist items with media, in order.
 */
async function getPlaylistQueue(playlistId) {
  const items = await prisma.playlistItem.findMany({
    where: { playlistId: Number(playlistId) },
    orderBy: { order: "asc" },
    include: { media: true },
  });

  // Flatten to a simple play queue of media records (skip any missing)
  const queue = items.map((it) => it.media).filter((m) => m && m.fileName);

  return queue;
}

/**
 * Log a history record for the given media.
 */
async function logHistory(mediaId) {
  try {
    await prisma.history.create({
      data: {
        mediaId: Number(mediaId),
        datetime: new Date(),
      },
    });
  } catch (error) {
    console.warn("[Scheduler] Failed to log history:", error.message);
    // ignore history errors
  }
}

/**
 * Play a single media on Caspar and wait for its duration.
 * If duration missing, wait a small safety window.
 */
async function playMediaAndWait(media, scheduleId, index, total) {
  const fileName = media.fileName;
  if (!fileName) {
    console.warn("[Scheduler] Media missing fileName, skipping");
    return;
  }

  console.log(`[Scheduler] Playing media: ${fileName}`);

  // Set current playing media for frontend
  _currentPlayingMedia = {
    ...media,
    scheduleId,
    index,
    total,
    startTime: new Date(),
  };
  _currentMediaStartTime = Date.now();

  // Emit playback started event
  emitEvent("playback_started", {
    scheduleId,
    media,
    index,
    total,
    timestamp: new Date(),
  });

  // Start playing on CasparCG
  try {
    await casparPlay(fileName, CHANNEL, LAYER);
    console.log(`[Scheduler] Successfully sent play command for: ${fileName}`);
  } catch (error) {
    console.error(`[Scheduler] Failed to play ${fileName}:`, error.message);
    _currentPlayingMedia = null;
    _currentMediaStartTime = null;

    // Emit error event
    emitEvent("playback_error", {
      scheduleId,
      media,
      error: error.message,
      timestamp: new Date(),
    });

    throw error; // Re-throw to handle in caller
  }

  // Log history
  await logHistory(media.id);

  // Wait for the media duration (fallback if missing)
  const ms =
    typeof media.duration === "number" && media.duration > 0
      ? Math.max(1000, Math.floor(media.duration * 1000))
      : SAFETY_MIN_DURATION_MS;

  console.log(`[Scheduler] Waiting ${ms}ms for media to finish`);

  // Emit progress updates every second
  const startTime = Date.now();
  const progressInterval = setInterval(() => {
    const elapsed = Date.now() - startTime;
    const progress = Math.min(100, (elapsed / ms) * 100);

    emitEvent("playback_progress", {
      scheduleId,
      media,
      progress,
      elapsed: Math.floor(elapsed / 1000),
      remaining: Math.floor((ms - elapsed) / 1000),
      timestamp: new Date(),
    });
  }, 1000);

  await sleep(ms);

  // Clear interval and emit completion
  clearInterval(progressInterval);
  emitEvent("playback_completed", {
    scheduleId,
    media,
    timestamp: new Date(),
  });

  // Clear current playing media
  _currentPlayingMedia = null;
  _currentMediaStartTime = null;
}

/**
 * Run a playlist: stop current, then sequentially play all items.
 * Only delete schedule after ALL items are played.
 */
async function runPlaylist(playlistId, scheduleId) {
  console.log(
    `[Scheduler] Running playlist ${playlistId} for schedule #${scheduleId}`
  );

  // Emit schedule start event
  emitEvent("schedule_started", {
    scheduleId,
    playlistId,
    timestamp: new Date(),
  });

  const queue = await getPlaylistQueue(playlistId);
  console.log(`[Scheduler] Playlist queue length: ${queue.length}`);

  // If empty, just delete the schedule and return.
  if (!queue.length) {
    console.log(
      `[Scheduler] Schedule #${scheduleId}: playlist ${playlistId} has no items; removing schedule.`
    );
    await prisma.schedule.delete({ where: { id: Number(scheduleId) } });

    // Emit empty playlist event
    emitEvent("schedule_empty", {
      scheduleId,
      playlistId,
      timestamp: new Date(),
    });

    // Emit schedule deleted event for frontend refresh
    emitEvent("schedule_deleted", {
      scheduleId,
      playlistId,
      reason: "empty_playlist",
      timestamp: new Date(),
    });

    return;
  }

  // Stop current playback, then play every item
  console.log(
    `[Scheduler] Starting playlist ${playlistId} for schedule #${scheduleId}...`
  );
  await stopCurrentPlayback();

  let playbackSuccessful = true;

  for (let i = 0; i < queue.length; i++) {
    const m = queue[i];
    try {
      _runningJob = {
        scheduleId,
        playlistId,
        currentIndex: i,
        mediaId: m.id,
        fileName: m.fileName,
      };

      console.log(
        `[Scheduler] (#${scheduleId}) Playing [${i + 1}/${queue.length}] ${
          m.fileName
        }`
      );
      await playMediaAndWait(m, scheduleId, i, queue.length);
    } catch (err) {
      console.warn(
        `[Scheduler] Error playing "${m?.fileName || "unknown"}":`,
        err?.message || err
      );
      playbackSuccessful = false;
      // Emit error event but continue to next media
      emitEvent("playback_error", {
        scheduleId,
        media: m,
        error: err?.message || err,
        timestamp: new Date(),
      });
    }
  }

  // Finished -> stop & remove schedule ONLY if all items were played
  await stopCurrentPlayback();

  if (playbackSuccessful) {
    try {
      await prisma.schedule.delete({ where: { id: Number(scheduleId) } });
      console.log(
        `[Scheduler] Schedule #${scheduleId} completed; removed from database.`
      );

      // Emit schedule completion and deletion events
      emitEvent("schedule_completed", {
        scheduleId,
        playlistId,
        timestamp: new Date(),
      });

      emitEvent("schedule_deleted", {
        scheduleId,
        playlistId,
        reason: "completed",
        timestamp: new Date(),
      });
    } catch (e) {
      console.warn(
        `[Scheduler] Could not delete schedule #${scheduleId}:`,
        e?.message || e
      );

      // Emit deletion error event
      emitEvent("schedule_deletion_error", {
        scheduleId,
        error: e?.message || e,
        timestamp: new Date(),
      });
    }
  } else {
    console.warn(
      `[Scheduler] Schedule #${scheduleId} had playback errors; keeping in database for retry.`
    );

    emitEvent("schedule_failed", {
      scheduleId,
      playlistId,
      reason: "playback_errors",
      timestamp: new Date(),
    });
  }

  _runningJob = null;
  _currentPlayingMedia = null;
  _currentMediaStartTime = null;
}

/**
 * Process the schedule queue in order
 */
async function processScheduleQueue() {
  if (_isProcessingQueue || _scheduleQueue.length === 0) {
    return;
  }

  _isProcessingQueue = true;

  try {
    // Process schedules in chronological order
    _scheduleQueue.sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

    for (const schedule of _scheduleQueue) {
      if (_claimed.has(schedule.id)) {
        console.log(
          `[Scheduler] Schedule #${schedule.id} already claimed, skipping`
        );
        continue;
      }

      _claimed.add(schedule.id);

      try {
        console.log(
          `[Scheduler] Processing schedule #${schedule.id} from queue`
        );
        await runPlaylist(schedule.playlistId, schedule.id);
      } catch (err) {
        console.error(
          `[Scheduler] Fatal error running schedule #${schedule.id}:`,
          err?.message || err
        );
        // Emit fatal error event
        emitEvent("schedule_fatal_error", {
          scheduleId: schedule.id,
          error: err?.message || err,
          timestamp: new Date(),
        });
        // unclaim so it can be re-picked next tick if needed
        _claimed.delete(schedule.id);
      }
    }
  } finally {
    _isProcessingQueue = false;
    // Clear the queue after processing
    _scheduleQueue = [];
  }
}

/**
 * Try to pick due schedules and add them to queue.
 */
async function tick() {
  // If already running a job or processing queue, skip this tick
  if (_runningJob || _isProcessingQueue) {
    console.log(`[Scheduler] Tick skipped - job running or queue processing`);
    return;
  }

  // Find all due schedules
  const dueSchedules = await getDueSchedules();
  if (!dueSchedules.length) {
    console.log("[Scheduler] No due schedules found");
    return;
  }

  console.log(
    `[Scheduler] Found ${dueSchedules.length} due schedules:`,
    dueSchedules
  );

  // Filter out already claimed schedules
  const newSchedules = dueSchedules.filter(
    (schedule) => !_claimed.has(schedule.id)
  );

  if (newSchedules.length > 0) {
    console.log(
      `[Scheduler] Adding ${newSchedules.length} new schedules to queue`
    );
    _scheduleQueue.push(...newSchedules);

    // Start processing the queue
    processScheduleQueue().catch((e) =>
      console.error("[Scheduler] Queue processing error:", e?.message || e)
    );
  }
}

/**
 * Start the schedule runner (idempotent).
 */
export function startScheduleRunner() {
  if (_started) {
    console.log("[Scheduler] Already started, skipping");
    return;
  }
  _started = true;

  console.log("[Scheduler] Starting schedule runner...");
  _tickHandle = setInterval(() => {
    tick().catch((e) =>
      console.error("[Scheduler] Tick error:", e?.message || e)
    );
  }, TICK_MS);
}

/**
 * Optional: stop the runner (not typically needed)
 */
export function stopScheduleRunner() {
  if (_tickHandle) {
    clearInterval(_tickHandle);
    _tickHandle = null;
  }
  _started = false;
  _currentPlayingMedia = null;
  _currentMediaStartTime = null;
  _scheduleQueue = [];
  _isProcessingQueue = false;
  _claimed.clear();
  console.log("[Scheduler] Stopped");
}

/**
 * Get current scheduler status for monitoring
 */
export function getSchedulerStatus() {
  return {
    started: _started,
    runningJob: _runningJob,
    currentPlayingMedia: _currentPlayingMedia,
    claimed: Array.from(_claimed),
    scheduleQueue: _scheduleQueue,
    isProcessingQueue: _isProcessingQueue,
    tickHandle: _tickHandle !== null,
  };
}
