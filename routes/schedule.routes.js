import { Router } from "express";
import {
  createSchedule,
  deleteSchedule,
  getUpcomingSchedules,
  listSchedules,
  updateSchedule,
} from "../controllers/schedule.controller.js";

const router = Router();

router.get("/", listSchedules);
router.get("/upcoming", getUpcomingSchedules);
router.post("/", createSchedule);
router.delete("/:id", deleteSchedule);
router.put("/:id", updateSchedule);

export default router;
