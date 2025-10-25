import { Router } from "express";
import {
  addMedia,
  deleteMedia,
  getMedia,
  getMediaStats,
  listMedia,
  searchSuggestions,
  streamMedia,
  updateMedia,
  uploadMiddleware,
} from "../controllers/media.controller.js";

const router = Router();

router.get("/", listMedia);
router.get("/stats", getMediaStats);
router.get("/search/suggest", searchSuggestions);
router.get("/stream/:fileName", streamMedia);
router.get("/:id", getMedia);
router.post("/", uploadMiddleware, addMedia);
router.put("/:id", updateMedia);
router.delete("/:id", deleteMedia);

export default router;
