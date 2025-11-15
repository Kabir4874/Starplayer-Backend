// src/services/scheduler.js
import { casparPause, casparPlay, casparResume, casparStop } from "./caspar.js";
import { prisma } from "./prisma.js";

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

// Control flags
let _paused = false;
let _cancelRequested = false;
let _skipRequested = false;

// Hard-abort flag: when true, processScheduleQueue will break early
let _forceAbortAll = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function emitEvent(event, data) {
  _eventCallbacks.forEach((callback) => {
    try {
      callback(event, data);
    } catch (error) {
      console.error("Error in event callback:", error);
    }
  });
}

export function onSchedulerEvent(callback) {
  _eventCallbacks.add(callback);
  return () => _eventCallbacks.delete(callback);
}

export function getCurrentPlayingMedia() {
  if (!_currentPlayingMedia) return null;

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
    paused: _paused,
  };
}

async function stopCurrentPlayback() {
  try {
    await casparStop(CHANNEL, LAYER);
  } catch (e) {
    console.log(
      "[Scheduler] Stop playback - nothing playing or error:",
      e.message
    );
  }
}

async function getDueSchedules() {
  const now = new Date();
  return prisma.schedule.findMany({
    where: {
      datetime: { lte: now },
    },
    orderBy: { datetime: "asc" },
    select: {
      id: true,
      datetime: true,
      playlistId: true,
    },
  });
}

async function getPlaylistQueue(playlistId) {
  const items = await prisma.playlistItem.findMany({
    where: { playlistId: Number(playlistId) },
    orderBy: { order: "asc" },
    include: { media: true },
  });

  const queue = items.map((it) => it.media).filter((m) => m && m.fileName);

  return queue;
}

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
  }
}

async function playMediaAndWait(media, scheduleId, index, total) {
  const fileName = media.fileName;
  if (!fileName) {
    console.warn("[Scheduler] Media missing fileName, skipping");
    return;
  }

  console.log(`[Scheduler] Playing media: ${fileName}`);

  _currentPlayingMedia = {
    ...media,
    scheduleId,
    playlistId: _runningJob?.playlistId ?? null,
    index,
    total,
    startTime: new Date(),
  };
  _currentMediaStartTime = Date.now();

  emitEvent("playback_started", {
    scheduleId,
    playlistId: _runningJob?.playlistId ?? null,
    media,
    index,
    total,
    timestamp: new Date(),
  });

  try {
    await casparPlay(fileName, CHANNEL, LAYER);
    console.log(`[Scheduler] Successfully sent play command for: ${fileName}`);
  } catch (error) {
    console.error(`[Scheduler] Failed to play ${fileName}:`, error.message);
    _currentPlayingMedia = null;
    _currentMediaStartTime = null;

    emitEvent("playback_error", {
      scheduleId,
      playlistId: _runningJob?.playlistId ?? null,
      media,
      error: error.message,
      timestamp: new Date(),
    });

    throw error;
  }

  await logHistory(media.id);

  const totalMs =
    typeof media.duration === "number" && media.duration > 0
      ? Math.max(1000, Math.floor(media.duration * 1000))
      : SAFETY_MIN_DURATION_MS;

  console.log(`[Scheduler] Waiting ${totalMs}ms for media to finish`);

  const startedAt = Date.now();
  let remaining = totalMs;

  const progressInterval = setInterval(() => {
    if (_cancelRequested) return;
    if (_paused) return;

    const elapsed = Date.now() - startedAt;
    const progress = Math.min(100, (elapsed / totalMs) * 100);

    emitEvent("playback_progress", {
      scheduleId,
      playlistId: _runningJob?.playlistId ?? null,
      media,
      progress,
      elapsed: Math.floor(elapsed / 1000),
      remaining: Math.max(0, Math.floor((totalMs - elapsed) / 1000)),
      timestamp: new Date(),
    });
  }, 1000);

  while (remaining > 0) {
    if (_cancelRequested || _skipRequested || _forceAbortAll) break;

    if (_paused) {
      await sleep(200);
      continue;
    }

    const chunk = Math.min(200, remaining);
    await sleep(chunk);
    remaining -= chunk;
  }

  clearInterval(progressInterval);

  if (_cancelRequested || _forceAbortAll) {
    console.log(
      "[Scheduler] playMediaAndWait: cancel/abort requested, aborting media early"
    );
  } else {
    emitEvent("playback_completed", {
      scheduleId,
      playlistId: _runningJob?.playlistId ?? null,
      media,
      skipped: _skipRequested,
      timestamp: new Date(),
    });
  }

  _currentPlayingMedia = null;
  _currentMediaStartTime = null;
  _skipRequested = false;
}

async function runPlaylist(playlistId, scheduleId) {
  console.log(
    `[Scheduler] Running playlist ${playlistId} for schedule #${scheduleId}`
  );

  emitEvent("schedule_started", {
    scheduleId,
    playlistId,
    timestamp: new Date(),
  });

  const queue = await getPlaylistQueue(playlistId);
  console.log(`[Scheduler] Playlist queue length: ${queue.length}`);

  if (!queue.length) {
    console.log(
      `[Scheduler] Schedule #${scheduleId}: playlist ${playlistId} has no items; removing schedule.`
    );
    try {
      await prisma.schedule.delete({ where: { id: Number(scheduleId) } });
    } catch (e) {
      console.warn(
        `[Scheduler] Could not delete empty playlist schedule #${scheduleId}:`,
        e?.message || e
      );
    }

    emitEvent("schedule_empty", {
      scheduleId,
      playlistId,
      timestamp: new Date(),
    });

    emitEvent("schedule_deleted", {
      scheduleId,
      playlistId,
      reason: "empty_playlist",
      timestamp: new Date(),
    });

    _claimed.delete(scheduleId);
    return;
  }

  console.log(
    `[Scheduler] Starting playlist ${playlistId} for schedule #${scheduleId}...`
  );
  await stopCurrentPlayback();

  let playbackSuccessful = true;

  for (let i = 0; i < queue.length; i++) {
    const m = queue[i];

    // Respect hard abort
    if (_forceAbortAll) {
      console.log(
        `[Scheduler] Force abort flag set while running schedule #${scheduleId}, breaking playlist loop.`
      );
      playbackSuccessful = false;
      break;
    }

    try {
      if (_cancelRequested) {
        console.log(
          `[Scheduler] Schedule #${scheduleId} cancel requested before item ${i}, aborting playlist.`
        );
        playbackSuccessful = false;
        break;
      }

      while (_paused && !_cancelRequested && !_forceAbortAll) {
        await sleep(200);
      }
      if (_cancelRequested || _forceAbortAll) {
        playbackSuccessful = false;
        break;
      }

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
      emitEvent("playback_error", {
        scheduleId,
        playlistId,
        media: m,
        error: err?.message || err,
        timestamp: new Date(),
      });
    }
  }

  await stopCurrentPlayback();

  if (_cancelRequested || _forceAbortAll) {
    console.log(
      `[Scheduler] Schedule #${scheduleId} cancelled/aborted by user, deleting schedule.`
    );
    try {
      await prisma.schedule.delete({ where: { id: Number(scheduleId) } });
    } catch (e) {
      console.warn(
        `[Scheduler] Could not delete cancelled schedule #${scheduleId}:`,
        e?.message || e
      );
    }

    emitEvent("schedule_stopped", {
      scheduleId,
      playlistId,
      reason: _forceAbortAll ? "user_stop_force" : "user_stop",
      timestamp: new Date(),
    });

    emitEvent("schedule_deleted", {
      scheduleId,
      playlistId,
      reason: "stopped",
      timestamp: new Date(),
    });

    _cancelRequested = false;
    _runningJob = null;
    _currentPlayingMedia = null;
    _currentMediaStartTime = null;
    _claimed.delete(scheduleId);
    return;
  }

  if (playbackSuccessful) {
    try {
      await prisma.schedule.delete({ where: { id: Number(scheduleId) } });
      console.log(
        `[Scheduler] Schedule #${scheduleId} completed; removed from database.`
      );

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

      emitEvent("schedule_deletion_error", {
        scheduleId,
        error: e?.message || e,
        timestamp: new Date(),
      });
    }
  } else {
    console.warn(
      `[Scheduler] Schedule #${scheduleId} had playback errors; keeping in database for retry (if not already deleted).`
    );

    emitEvent("schedule_failed", {
      scheduleId,
      playlistId,
      reason: "playback_errors",
      timestamp: new Date(),
    });

    _claimed.delete(scheduleId);
  }

  _runningJob = null;
  _currentPlayingMedia = null;
  _currentMediaStartTime = null;
}

async function processScheduleQueue() {
  if (_isProcessingQueue || _scheduleQueue.length === 0) {
    return;
  }

  _isProcessingQueue = true;

  try {
    _scheduleQueue.sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

    for (const schedule of _scheduleQueue) {
      if (_forceAbortAll) {
        console.log(
          "[Scheduler] Force abort flag set, breaking out of schedule queue loop."
        );
        break;
      }

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
        emitEvent("schedule_fatal_error", {
          scheduleId: schedule.id,
          error: err?.message || err,
          timestamp: new Date(),
        });
        _claimed.delete(schedule.id);
      }
    }
  } finally {
    // After processing (or force abort), clear queue state
    _isProcessingQueue = false;
    _scheduleQueue = [];
    _forceAbortAll = false;
  }
}

async function tick() {
  if (_runningJob || _isProcessingQueue) {
    console.log(`[Scheduler] Tick skipped - job running or queue processing`);
    return;
  }

  const dueSchedules = await getDueSchedules();
  if (!dueSchedules.length) {
    console.log("[Scheduler] No due schedules found");
    return;
  }

  console.log(
    `[Scheduler] Found ${dueSchedules.length} due schedules:`,
    dueSchedules
  );

  const newSchedules = dueSchedules.filter(
    (schedule) => !_claimed.has(schedule.id)
  );

  if (newSchedules.length > 0) {
    console.log(
      `[Scheduler] Adding ${newSchedules.length} new schedules to queue`
    );
    _scheduleQueue.push(...newSchedules);

    processScheduleQueue().catch((e) =>
      console.error("[Scheduler] Queue processing error:", e?.message || e)
    );
  }
}

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
  _paused = false;
  _cancelRequested = false;
  _skipRequested = false;
  _forceAbortAll = false;
  _runningJob = null;
  console.log("[Scheduler] Stopped");
}

export function getSchedulerStatus() {
  return {
    started: _started,
    runningJob: _runningJob,
    currentPlayingMedia: _currentPlayingMedia,
    claimed: Array.from(_claimed),
    scheduleQueue: _scheduleQueue,
    isProcessingQueue: _isProcessingQueue,
    tickHandle: _tickHandle !== null,
    paused: _paused,
    cancelRequested: _cancelRequested,
  };
}

export async function pauseCurrentSchedule() {
  if (!_runningJob) {
    console.log("[Scheduler] pauseCurrentSchedule: no running job");
    return false;
  }
  if (_paused) return true;

  _paused = true;

  try {
    await casparPause(CHANNEL, LAYER);
  } catch (e) {
    console.warn(
      "[Scheduler] pauseCurrentSchedule casparPause error:",
      e?.message || e
    );
  }

  emitEvent("schedule_paused", {
    scheduleId: _runningJob.scheduleId,
    playlistId: _runningJob.playlistId,
    mediaId: _runningJob.mediaId,
    timestamp: new Date(),
  });

  return true;
}

export async function resumeCurrentSchedule() {
  if (!_runningJob) {
    console.log("[Scheduler] resumeCurrentSchedule: no running job");
    return false;
  }
  if (!_paused) return true;

  _paused = false;

  try {
    await casparResume(CHANNEL, LAYER);
  } catch (e) {
    console.warn(
      "[Scheduler] resumeCurrentSchedule casparResume error:",
      e?.message || e
    );
  }

  emitEvent("schedule_resumed", {
    scheduleId: _runningJob.scheduleId,
    playlistId: _runningJob.playlistId,
    mediaId: _runningJob.mediaId,
    timestamp: new Date(),
  });

  return true;
}

export async function stopCurrentSchedule() {
  // If nothing is running and nothing is processing, nothing to stop
  if (!_runningJob && !_isProcessingQueue) {
    console.log("[Scheduler] stopCurrentSchedule: no running job/queue");
    return false;
  }

  const scheduleId = _runningJob?.scheduleId ?? null;
  const playlistId = _runningJob?.playlistId ?? null;
  const mediaId = _runningJob?.mediaId ?? null;

  console.log(
    "[Scheduler] stopCurrentSchedule called for schedule:",
    scheduleId,
    "playlist:",
    playlistId
  );

  // Flags: tell loops to abort ASAP
  _cancelRequested = true;
  _paused = false;
  _skipRequested = false;
  _forceAbortAll = true;

  // Immediately stop Caspar playback
  try {
    await casparStop(CHANNEL, LAYER);
  } catch (e) {
    console.warn(
      "[Scheduler] stopCurrentSchedule casparStop error:",
      e?.message || e
    );
  }

  // Immediately remove schedule from DB if we know its ID
  if (scheduleId != null) {
    try {
      await prisma.schedule.delete({ where: { id: Number(scheduleId) } });
      console.log(
        `[Scheduler] stopCurrentSchedule: schedule #${scheduleId} removed from database immediately.`
      );
    } catch (e) {
      console.warn(
        `[Scheduler] stopCurrentSchedule: could not delete schedule #${scheduleId}:`,
        e?.message || e
      );
    }

    // Clean up in-memory tracking for this schedule
    _claimed.delete(scheduleId);
    _scheduleQueue = _scheduleQueue.filter((s) => s.id !== scheduleId);
  }

  emitEvent("schedule_stopped", {
    scheduleId,
    playlistId,
    reason: "user_stop_force",
    timestamp: new Date(),
  });

  emitEvent("schedule_deleted", {
    scheduleId,
    playlistId,
    reason: "stopped",
    timestamp: new Date(),
  });

  // Clear current job & media so tick() doesn't think something is running
  _runningJob = null;
  _currentPlayingMedia = null;
  _currentMediaStartTime = null;

  // Mark queue processing as done from the scheduler's POV
  _isProcessingQueue = false;

  return {
    cancelled: true,
    scheduleId,
    playlistId,
    mediaId,
  };
}

// Backwards-compatible alias
export async function cancelCurrentSchedule() {
  return stopCurrentSchedule();
}

export async function nextInCurrentSchedule() {
  if (!_runningJob) {
    console.log("[Scheduler] nextInCurrentSchedule: no running job");
    return false;
  }

  _skipRequested = true;

  try {
    await casparStop(CHANNEL, LAYER);
  } catch (e) {
    console.warn(
      "[Scheduler] nextInCurrentSchedule casparStop error:",
      e?.message || e
    );
  }

  emitEvent("schedule_next_requested", {
    scheduleId: _runningJob.scheduleId,
    playlistId: _runningJob.playlistId,
    mediaId: _runningJob.mediaId,
    timestamp: new Date(),
  });

  return true;
}
