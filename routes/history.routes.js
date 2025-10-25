import { Router } from "express";
import {
  addHistory,
  deleteHistory,
  getTodayHistory,
  listHistory,
} from "../controllers/history.controller.js";

const router = Router();

router.get("/", listHistory);
router.get("/today", getTodayHistory);
router.post("/", addHistory);
router.delete("/:id", deleteHistory);

export default router;
