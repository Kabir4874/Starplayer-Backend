import { Router } from "express";
import {
  getNowPlaying,
  pausePlayback,
  playMedia,
  playPlaylist,
  quickPlay,
  resumePlayback,
  stopPlayback,
} from "../controllers/player.controller.js";

const router = Router();

router.post("/play", playMedia);
router.post("/stop", stopPlayback);
router.post("/pause", pausePlayback);
router.post("/resume", resumePlayback);
router.post("/playlist/play", playPlaylist);
router.get("/now-playing", getNowPlaying);
router.post("/quick-play", quickPlay);

export default router;
