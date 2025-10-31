import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import casparRoutes from "./routes/caspar.routes.js";
import historyRoutes from "./routes/history.routes.js";
import mediaRoutes from "./routes/media.routes.js";
import playerRoutes from "./routes/player.routes.js";
import playlistRoutes from "./routes/playlist.routes.js";
import scheduleRoutes from "./routes/schedule.routes.js";
dotenv.config();
const app = express();
const port = process.env.PORT;
const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:4000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:4000",
];

app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (like mobile apps or curl requests)
      if (!origin) return callback(null, true);

      if (allowedOrigins.indexOf(origin) === -1) {
        const msg =
          "The CORS policy for this site does not allow access from the specified Origin.";
        return callback(new Error(msg), false);
      }
      return callback(null, true);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  })
);
app.use(express.json());
app.use(cors());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use("/api/media", mediaRoutes);
app.use("/api/caspar", casparRoutes);
app.use("/api/playlists", playlistRoutes);
app.use("/api/schedules", scheduleRoutes);
app.use("/api/history", historyRoutes);
app.use("/api/player", playerRoutes);

app.get("/", (req, res) => {
  res.send("API is running...");
});
app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.listen(port, () =>
  console.log(`Server is running on at http://localhost:${port}`)
);
