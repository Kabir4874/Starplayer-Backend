import fse from "fs-extra";
import mime from "mime-types";
import path from "path";
import { cfg } from "../config/config.js";

export async function moveToCasparMedia(tempPath, originalName) {
  await fse.ensureDir(cfg.mediaDir);

  const ext =
    path.extname(originalName) ||
    `.${mime.extension(mime.lookup(originalName) || "mp4")}`;
  const base = path
    .basename(originalName, path.extname(originalName))
    .replace(/[^\w\s\-\.]+/g, "_")
    .replace(/\s+/g, "_");

  let candidate = `${base}${ext}`;
  let dst = path.join(cfg.mediaDir, candidate);
  let i = 1;
  while (await fse.pathExists(dst)) {
    candidate = `${base}_${i}${ext}`;
    dst = path.join(cfg.mediaDir, candidate);
    i += 1;
  }
  await fse.move(tempPath, dst, { overwrite: false });
  return { absolutePath: dst, fileName: candidate };
}

export function casparBaseName(fileName) {
  return fileName.replace(/\.[^.]+$/, "");
}
