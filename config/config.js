import "dotenv/config";

export const cfg = {
  port: Number(process.env.PORT || 4000),
  caspar: {
    host: process.env.CASPAR_HOST || "127.0.0.1",
    port: Number(process.env.CASPAR_PORT || 5250),
    channel: Number(process.env.CASPAR_CHANNEL || 1),
    layer: Number(process.env.CASPAR_LAYER || 10),
  },
  mediaDir: process.env.CASPAR_MEDIA_DIR,
};
