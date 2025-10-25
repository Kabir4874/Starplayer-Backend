import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import casparRoutes from "./routes/caspar.routes.js";
import historyRoutes from "./routes/history.routes.js";
import mediaRoutes from "./routes/media.routes.js";
import playlistRoutes from "./routes/playlist.routes.js";
import scheduleRoutes from "./routes/schedule.routes.js";
dotenv.config();
const app = express();
const port = process.env.PORT;
app.use(cors({ origin: ["http://localhost:5173"], credentials: true }));
app.use(express.json());
app.use(cors());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use("/api/media", mediaRoutes);
app.use("/api/caspar", casparRoutes);
app.use("/api/playlists", playlistRoutes);
app.use("/api/schedules", scheduleRoutes);
app.use("/api/history", historyRoutes);

app.get("/", (req, res) => {
  res.send("API is running...");
});
app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.listen(port, () =>
  console.log(`Server is running on at http://localhost:${port}`)
);
