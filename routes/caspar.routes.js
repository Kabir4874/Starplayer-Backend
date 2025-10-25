import { Router } from "express";
import multer from "multer";
import {
  cgStop,
  cgUpdate,
  channelGrid,
  clear,
  clearLayer,
  diagnostics,
  health,
  help,
  info,
  infoTemplate,
  kill,
  listServerMedia,
  pause,
  play,
  playlist,
  playTemplate,
  resume,
  setChannelFormat,
  status,
  stop,
  testConnection,
  version,
} from "../controllers/caspar.controller.js";

const router = Router();

const parseFieldsOnly = multer().none();

// Health check
router.get("/health", health);

// Diagnostics & Status
router.get("/test", testConnection);
router.get("/status", status);
router.get("/diagnostics", diagnostics);

// System Information
router.get("/version", version);
router.get("/help", help);
router.post("/kill", parseFieldsOnly, kill);

// Media Information
router.get("/list", listServerMedia);
router.post("/info", parseFieldsOnly, info);
router.post("/info/template", parseFieldsOnly, infoTemplate);

// Media Playback Control
router.post("/play", parseFieldsOnly, play);
router.post("/pause", parseFieldsOnly, pause);
router.post("/resume", parseFieldsOnly, resume);
router.post("/stop", parseFieldsOnly, stop);
router.post("/clear", parseFieldsOnly, clear);
router.post("/clear/layer", parseFieldsOnly, clearLayer);

// Template Control
router.post("/template/play", parseFieldsOnly, playTemplate);
router.post("/template/update", parseFieldsOnly, cgUpdate);
router.post("/template/stop", parseFieldsOnly, cgStop);

// Channel Configuration
router.get("/channel/grid", channelGrid);
router.post("/channel/format", parseFieldsOnly, setChannelFormat);

// Batch Operations
router.post("/playlist", parseFieldsOnly, playlist);

export default router;
