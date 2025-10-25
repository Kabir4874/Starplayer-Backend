import { Router } from "express";
import {
  createSchedule,
  deleteSchedule,
  getUpcomingSchedules,
  listSchedules,
} from "../controllers/schedule.controller.js";

const router = Router();

router.get("/", listSchedules);
router.get("/upcoming", getUpcomingSchedules);
router.post("/", createSchedule);
router.delete("/:id", deleteSchedule);

export default router;
