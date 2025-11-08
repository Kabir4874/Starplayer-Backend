// src/routes/scheduler.routes.js
import { Router } from "express";
import {
  getCurrentPlayingMedia,
  getSchedulerStatus,
  onSchedulerEvent,
} from "../services/scheduler.js";

const router = Router();

/**
 * GET /api/scheduler/status - Get scheduler status
 */
router.get("/status", (req, res) => {
  try {
    const status = getSchedulerStatus();
    res.json({
      ok: true,
      status,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: "Failed to get scheduler status",
      error: error.message,
    });
  }
});

/**
 * GET /api/scheduler/current-media - Get current playing media
 */
router.get("/current-media", (req, res) => {
  try {
    const currentMedia = getCurrentPlayingMedia();
    res.json({
      ok: true,
      currentMedia,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: "Failed to get current media",
      error: error.message,
    });
  }
});

/**
 * GET /api/scheduler/events - Server-Sent Events for real-time updates
 */
router.get("/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Subscribe to scheduler events
  const unsubscribe = onSchedulerEvent((event, data) => {
    sendEvent(event, data);
  });

  // Send initial connection event
  sendEvent("connected", { timestamp: new Date().toISOString() });

  // Handle client disconnect
  req.on("close", () => {
    unsubscribe();
    res.end();
  });

  // Keep connection alive
  const keepAlive = setInterval(() => {
    res.write(": keepalive\n\n");
  }, 30000);

  req.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
    res.end();
  });
});

export default router;
