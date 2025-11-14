import fsp from "fs/promises";
import path from "path";
import { prisma } from "../services/prisma.js";

export async function runFirstBootReset() {
  try {
    if (process.env.RESET_ON_FIRST_BOOT !== "true") {
      console.log("[RESET] RESET_ON_FIRST_BOOT is not true, skipping reset.");
      return;
    }

    console.log(
      "[RESET] Running RESET: truncating DB + clearing media folder..."
    );

    await prisma.$transaction([
      prisma.history.deleteMany(),
      prisma.schedule.deleteMany(),
      prisma.playlistItem.deleteMany(),
      prisma.playlist.deleteMany(),
      prisma.media.deleteMany(),
    ]);

    console.log("[RESET] Database tables truncated.");

    const mediaFolder = process.env.CASPAR_MEDIA_DIR;
    if (!mediaFolder) {
      console.warn(
        "[RESET] CASPAR_MEDIA_DIR is not set, skipping media cleanup."
      );
    } else {
      try {
        const entries = await fsp.readdir(mediaFolder, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.name === ".gitkeep") continue;

          const fullPath = path.join(mediaFolder, entry.name);
          await fsp.rm(fullPath, { recursive: true, force: true });
        }

        console.log("[RESET] CasparCG media folder cleared:", mediaFolder);
      } catch (err) {
        console.error("[RESET] Error clearing media folder:", err);
      }
    }

    console.log("[RESET] Reset complete!");
  } catch (err) {
    console.error("[RESET] Reset FAILED:", err);
  }
}
