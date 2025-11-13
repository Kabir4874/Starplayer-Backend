// src/utils/firstBootReset.js
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { prisma } from "../services/prisma.js";

const FLAG_FILE = ".first_boot_reset_done";

export async function runFirstBootReset() {
  try {
    // Safety: only if explicitly enabled
    if (process.env.RESET_ON_FIRST_BOOT !== "true") {
      console.log("[RESET] RESET_ON_FIRST_BOOT is not true, skipping reset.");
      return;
    }

    const flagPath = path.join(process.cwd(), FLAG_FILE);

    // If flag exists, we already reset once
    if (fs.existsSync(flagPath)) {
      console.log("[RESET] First-boot reset already done, skipping.");
      return;
    }

    console.log(
      "[RESET] Running FIRST-BOOT reset: truncating DB + clearing media folder..."
    );

    // 1) TRUNCATE TABLES (deleteMany in FK-safe order)
    await prisma.$transaction([
      prisma.history.deleteMany(),
      prisma.schedule.deleteMany(),
      prisma.playlistItem.deleteMany(),
      prisma.playlist.deleteMany(),
      prisma.media.deleteMany(),
    ]);

    console.log("[RESET] Database tables truncated.");

    // 2) CLEAR CASPARCG MEDIA FOLDER
    const mediaFolder = process.env.CASPAR_MEDIA_DIR;
    if (!mediaFolder) {
      console.warn(
        "[RESET] CASPAR_MEDIA_DIR is not set, skipping media cleanup."
      );
    } else {
      try {
        const entries = await fsp.readdir(mediaFolder, { withFileTypes: true });

        // Remove everything inside, but optionally keep .gitkeep or similar
        for (const entry of entries) {
          // Example: keep ".gitkeep"
          if (entry.name === ".gitkeep") continue;

          const fullPath = path.join(mediaFolder, entry.name);
          await fsp.rm(fullPath, { recursive: true, force: true });
        }

        console.log("[RESET] CasparCG media folder cleared:", mediaFolder);
      } catch (err) {
        console.error("[RESET] Error clearing media folder:", err);
      }
    }

    // 3) WRITE FLAG FILE SO IT RUNS ONLY ONCE
    await fsp.writeFile(flagPath, new Date().toISOString(), "utf-8");
    console.log(
      "[RESET] First-boot reset complete, flag file created:",
      flagPath
    );
  } catch (err) {
    console.error("[RESET] First-boot reset FAILED:", err);
  }
}
