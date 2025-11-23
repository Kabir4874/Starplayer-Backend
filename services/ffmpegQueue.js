// src/services/ffmpegQueue.js
// Simple queue to limit how many ffmpeg jobs run at once on low-config PCs.

const MAX_CONCURRENT_FFMPEG = Number(
  process.env.FFMPEG_CONCURRENCY || 2 // You can set FFMPEG_CONCURRENCY=1 for very weak machines
);

let running = 0;
const jobQueue = [];

/**
 * Internal: starts next job if we have capacity.
 */
function runNext() {
  if (running >= MAX_CONCURRENT_FFMPEG) return;
  const job = jobQueue.shift();
  if (!job) return;

  running++;
  job()
    .catch((err) => {
      // We log, but we do NOT rethrow here so the queue keeps moving
      console.error("[FFMPEG_QUEUE] job error:", err?.message || err);
    })
    .finally(() => {
      running--;
      // Schedule next on next tick so event loop stays responsive
      setImmediate(runNext);
    });
}

export function enqueueFfmpeg(taskFn) {
  return new Promise((resolve, reject) => {
    const wrapped = () =>
      Promise.resolve().then(taskFn).then(resolve).catch(reject);

    jobQueue.push(wrapped);
    runNext();
  });
}
