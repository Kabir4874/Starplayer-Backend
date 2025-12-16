import { Router } from "express";
import {
  addPlaylistItem,
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  listPlaylists,
  removePlaylistItem,
  resolvePlaylist,
  updatePlaylist,
} from "../controllers/playlist.controller.js";

const router = Router();

router.get("/", listPlaylists);
router.get("/:id", getPlaylist);
router.get("/:id/resolve", resolvePlaylist);
router.post("/", createPlaylist);
router.put("/:id", updatePlaylist);
router.delete("/:id", deletePlaylist);
router.post("/:id/items", addPlaylistItem);
router.delete("/:id/items/:mediaId", removePlaylistItem);

export default router;
