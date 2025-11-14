// src/routes/schedule.routes.js
import { Router } from "express";
import {
  createSchedule,
  deleteSchedule,
  getUpcomingSchedules,
  listSchedules,
  updateSchedule,
} from "../controllers/schedule.controller.js";
import {
  getSchedulerStatus,
  startScheduleRunner,
} from "../services/scheduler.js";

const router = Router();

// Initialize scheduler when this module is loaded
if (!global.__SCHEDULE_RUNNER_STARTED__) {
  try {
    startScheduleRunner();
    global.__SCHEDULE_RUNNER_STARTED__ = true;
    console.log("[ScheduleRouter] Scheduler started.");
  } catch (e) {
    console.warn(
      "[ScheduleRouter] Failed to start scheduler:",
      e?.message || e
    );
  }
}

router.get("/", listSchedules);
router.get("/upcoming", getUpcomingSchedules);
router.post("/", createSchedule);
router.delete("/:id", deleteSchedule);
router.put("/:id", updateSchedule);

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

export default router;
