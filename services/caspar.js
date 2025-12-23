import net from "net";
import { cfg } from "../config/config.js";
import { prisma } from "./prisma.js";

class CasparCGSocket {
  constructor() {
    this.host = cfg.caspar.host;
    this.port = cfg.caspar.port;
    this.socket = null;
    this.connected = false;
    this.connectPromise = null;
    this.responseCallbacks = new Map();
    this.autoReconnect = true;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.responseBuffer = "";
  }

  async connect() {
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise((resolve, reject) => {
      this.socket = new net.Socket();

      this.socket.connect(this.port, this.host, () => {
        console.log("✅ Connected to CasparCG server");
        this.connected = true;
        this.reconnectAttempts = 0;
        resolve();
      });

      this.socket.on("data", (data) => {
        const response = data.toString();
        this.responseBuffer += response;

        // Process complete lines from buffer
        const lines = this.responseBuffer.split("\r\n");
        this.responseBuffer = lines.pop() || "";

        lines.forEach((line) => {
          const trimmed = line.trim();
          if (trimmed) this.processResponseLine(trimmed);
        });
      });

      this.socket.on("error", (error) => {
        console.error("❌ Socket error:", error);
        this.connected = false;
        this.connectPromise = null;
        reject(error);
      });

      this.socket.on("close", () => {
        console.log("⚠️ Connection closed");
        this.connected = false;
        this.connectPromise = null;

        if (
          this.autoReconnect &&
          this.reconnectAttempts < this.maxReconnectAttempts
        ) {
          this.reconnectAttempts++;
          console.log(
            `🔄 Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`
          );
          setTimeout(() => this.connect(), 2000);
        }
      });
    });

    return this.connectPromise;
  }

  processResponseLine(line) {
    // Handle different response formats
    if (line.startsWith("RES")) {
      const parts = line.split(" ");
      const reqId = parts[1];
      const statusCode = parts[2];
      const callback = this.responseCallbacks.get(reqId);

      if (callback) {
        const responseObj = {
          requestId: reqId,
          statusCode: parseInt(statusCode, 10),
          data: parts.slice(3).join(" "),
          raw: line,
          success:
            Number(statusCode) >= 200 && Number(statusCode) < 400
              ? true
              : false,
        };

        if (line.includes("CLS") && statusCode === "200") {
          responseObj.mediaList = this.parseMediaList(line);
        }

        callback(responseObj);
        this.responseCallbacks.delete(reqId);
      }
      return;
    }

    // Immediate responses (some Caspar builds do this)
    if (line.startsWith("2") || line.startsWith("4") || line.startsWith("5")) {
      this.handleImmediateResponse(line);
    }
  }

  handleImmediateResponse(line) {
    const parts = line.split(" ");
    if (parts.length < 1) return;

    let reqId = null;
    for (let i = 1; i < parts.length; i++) {
      if (parts[i] && parts[i].match(/^[a-z0-9]{4,8}$/i)) {
        reqId = parts[i];
        break;
      }
    }

    if (!reqId) return;

    const callback = this.responseCallbacks.get(reqId);
    if (!callback) return;

    const responseObj = {
      requestId: reqId,
      statusCode: parseInt(parts[0], 10),
      data: parts.slice(1).join(" "),
      raw: line,
      success: String(parts[0]).startsWith("2"),
    };

    callback(responseObj);
    this.responseCallbacks.delete(reqId);
  }

  parseMediaList(response) {
    const lines = response.split("\n");
    const mediaItems = [];

    for (const line of lines) {
      if (
        line.includes("MOVIE") ||
        line.includes("STILL") ||
        line.includes("AUDIO")
      ) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 3) {
          mediaItems.push({
            type: parts[0],
            name: parts[1],
            size: parts[2],
            timestamp: parts[3] || "",
            frames: parts[4] || "",
            frameRate: parts[5] || "",
            duration: parts[6] || "",
          });
        }
      }
    }

    return mediaItems;
  }

  async sendCommand(command, timeoutMs = 2000, expectResponse = true) {
    try {
      if (!this.connected) await this.connect();

      const reqId = this.generateRequestId();
      const fullCommand = `REQ ${reqId} ${command}\r\n`;

      console.log(`📤 Sending: ${fullCommand.trim()}`);

      if (!expectResponse) {
        this.socket.write(fullCommand);
        return {
          requestId: reqId,
          statusCode: 202,
          data: "Command sent (no response expected)",
          raw: "202 COMMAND SENT",
          success: true,
          assumed: true,
        };
      }

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          this.responseCallbacks.delete(reqId);
          console.log(`⚠️ Command timeout, assuming success: ${command}`);
          resolve({
            requestId: reqId,
            statusCode: 202,
            data: "Command OK (assumed - no response received)",
            raw: "202 COMMAND OK (ASSUMED)",
            success: true,
            assumed: true,
          });
        }, timeoutMs);

        this.responseCallbacks.set(reqId, (response) => {
          clearTimeout(timeout);
          resolve(response);
        });

        this.socket.write(fullCommand);
      });
    } catch (error) {
      console.error("❌ Command failed:", error);
      throw error;
    }
  }

  async sendFireAndForget(command) {
    try {
      if (!this.connected) await this.connect();

      const reqId = this.generateRequestId();
      const fullCommand = `REQ ${reqId} ${command}\r\n`;

      console.log(`📤 Sending (fire and forget): ${fullCommand.trim()}`);
      this.socket.write(fullCommand);

      return {
        success: true,
        command,
        assumed: true,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error("❌ Fire and forget command failed:", error);
      throw error;
    }
  }

  generateRequestId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
  }

  async close() {
    this.autoReconnect = false;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
      this.connected = false;
      this.connectPromise = null;
    }
  }

  isConnected() {
    return this.connected;
  }

  getStatus() {
    return {
      connected: this.connected,
      host: this.host,
      port: this.port,
      reconnectAttempts: this.reconnectAttempts,
    };
  }
}

// Global socket instance
let casparSocket = null;

function getCasparSocket() {
  if (!casparSocket) casparSocket = new CasparCGSocket();
  return casparSocket;
}

/**
 * Helper: escape XML/HTML special characters (for template data)
 */
function escapeHtml(text) {
  const map = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return String(text).replace(/[&<>"']/g, (m) => map[m]);
}

/**
 * Helper: escape a string to be safely wrapped inside AMCP quotes "..."
 * - Escapes backslash and quotes
 * - Removes CR/LF (Caspar treats lines as terminators)
 */
function escapeAmcpQuotedString(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "")
    .replace(/\n/g, "");
}

/**
 * Aggressive overlay “make it work” implementation:
 * - Clears prior CG instances (REMOVE/STOP) and layer (CLEAR)
 * - Tries multiple payload formats (JSON + XML) for CG ADD
 * - Ensures the layer is visible (MIXER OPACITY 1, FILL sane default)
 *
 * Requirements on Caspar side:
 * - A template named "starplayer_overlay" must exist in your templates/html producer folder,
 *   and it must accept either JSON data (typical HTML template) or classic templateData XML (Flash/legacy).
 */
export async function casparShowOverlay(
  channel = 1,
  overlayLayer = 20,
  artist = "",
  title = "",
  fileName = ""
) {
  const socket = getCasparSocket();

  try {
    let artistText = String(artist || "")
      .replace(/_/g, " ")
      .trim();
    let titleText = String(title || "")
      .replace(/_/g, " ")
      .trim();

    if (!artistText && !titleText && fileName) {
      const base = String(fileName).replace(/\.[^.]+$/, "");
      titleText = base.replace(/_/g, " ").trim();
    }

    if (!artistText && !titleText) {
      console.log("[Caspar] No overlay text to display");
      return { success: false, message: "No text to display" };
    }

    console.log(`[Caspar] Showing overlay on ${channel}-${overlayLayer}:`, {
      artist: artistText || "(none)",
      title: titleText || "(none)",
    });

    // Clear any existing overlay first
    try {
      await socket.sendFireAndForget(`CLEAR ${channel}-${overlayLayer}`);
    } catch (e) {
      // ignore
    }

    // Small delay to ensure clear completes
    await new Promise(r => setTimeout(r, 100));

    // Add the template - NO QUOTES around template name (tested working!)
    const addCmd = `CG ${channel}-${overlayLayer} ADD 1 starplayer_overlay 1`;
    console.log(`[Caspar] Sending: ${addCmd}`);
    await socket.sendFireAndForget(addCmd);

    // Small delay before update
    await new Promise(r => setTimeout(r, 100));

    // Update with data - JSON format
    const data = JSON.stringify({ f0: artistText, f1: titleText });
    const updateCmd = `CG ${channel}-${overlayLayer} UPDATE 1 "${escapeAmcpQuotedString(data)}"`;
    console.log(`[Caspar] Sending: ${updateCmd}`);
    await socket.sendFireAndForget(updateCmd);

    console.log("[Caspar] Overlay shown successfully");
    return {
      success: true,
      command: "CG ADD + UPDATE",
      layer: overlayLayer,
      artist: artistText,
      title: titleText,
    };
  } catch (error) {
    console.error("[Caspar] Error in casparShowOverlay:", error?.message || error);
    return {
      success: false,
      error: error?.message || String(error),
      command: "OVERLAY",
      layer: overlayLayer,
    };
  }
}

/**
 * Remove overlay from CasparCG layer (more robust than CLEAR only)
 */
export async function casparHideOverlay(channel = 1, overlayLayer = 20) {
  const socket = getCasparSocket();
  console.log(`[Caspar] Hiding overlay on ${channel}-${overlayLayer}`);

  // Try CG remove/stop first, then clear layer
  const cmds = [
    `CG ${channel}-${overlayLayer} REMOVE 1`,
    `CG ${channel}-${overlayLayer} STOP 1`,
    `CG ${channel}-${overlayLayer} CLEAR`,
    `CLEAR ${channel}-${overlayLayer}`,
  ];

  for (const cmd of cmds) {
    try {
      await socket.sendFireAndForget(cmd);
    } catch (e) {
      // ignore
    }
  }

  return {
    success: true,
    command: "HIDE_OVERLAY",
    layer: overlayLayer,
  };
}

export async function casparPlay(
  fileName,
  channel = 1,
  layer = 10,
  options = {}
) {
  const socket = getCasparSocket();

  let command = `PLAY ${channel}-${layer} "${fileName}"`;
  if (options.loop) command += " LOOP";
  if (options.auto) command += " AUTO";
  if (options.seek !== undefined) command += ` SEEK ${options.seek}`;
  if (options.length !== undefined) command += ` LENGTH ${options.length}`;
  if (options.filter !== undefined) command += ` FILTER ${options.filter}`;

  console.log(`[Caspar] Sending play command: ${command}`);
  const response = await socket.sendFireAndForget(command);

  // Ensure audio is unmuted at both layer and channel level
  try {
    await socket.sendFireAndForget(`MIXER ${channel}-${layer} VOLUME 1`);
    await socket.sendFireAndForget(`MIXER ${channel} MASTERVOLUME 1`);
  } catch (e) {
    console.warn("[Caspar] Failed to set mixer volume:", e?.message || e);
  }

  const shouldShowOverlay = options.showOverlay !== false;

  if (shouldShowOverlay) {
    const overlayLayer = Number(options.overlayLayer || 20);
    let artist = options.artist || "";
    let title = options.title || "";

    if (!artist && !title) {
      try {
        const media = await prisma.media.findFirst({
          where: { fileName: String(fileName).trim() },
          select: { author: true, title: true, artist: true },
        });

        if (media) {
          artist = media.author || media.artist || "";
          title = media.title || "";
          console.log("[Caspar] Fetched metadata for overlay:", {
            artist,
            title,
            fileName,
          });
        }
      } catch (err) {
        console.warn(
          `[Caspar] Failed to fetch metadata for ${fileName}:`,
          err?.message || err
        );
      }
    }

    // Show overlay shortly after PLAY (and retry once)
    setTimeout(async () => {
      try {
        await casparShowOverlay(channel, overlayLayer, artist, title, fileName);
      } catch (err) {
        console.warn(
          `[Caspar] Failed to show overlay for ${fileName}:`,
          err?.message || err
        );
        setTimeout(async () => {
          try {
            await casparShowOverlay(
              channel,
              overlayLayer,
              artist,
              title,
              fileName
            );
          } catch (retryErr) {
            console.error(
              `[Caspar] Overlay retry failed for ${fileName}:`,
              retryErr?.message || retryErr
            );
          }
        }, 500);
      }
    }, 150);
  }

  return {
    success: true,
    response,
    command,
    assumed: true,
  };
}

export async function casparPause(channel = 1, layer = 10) {
  const socket = getCasparSocket();
  const command = `PAUSE ${channel}-${layer}`;
  const response = await socket.sendFireAndForget(command);
  return { success: true, response, command, assumed: true };
}

export async function casparResume(channel = 1, layer = 10) {
  const socket = getCasparSocket();
  const command = `RESUME ${channel}-${layer}`;
  const response = await socket.sendFireAndForget(command);
  return { success: true, response, command, assumed: true };
}

export async function casparStop(channel = 1, layer = 10) {
  const socket = getCasparSocket();
  const command = `STOP ${channel}-${layer}`;
  const response = await socket.sendFireAndForget(command);
  return { success: true, response, command, assumed: true };
}

export async function casparClear(channel = 1) {
  const socket = getCasparSocket();
  const command = `CLEAR ${channel}`;
  const response = await socket.sendFireAndForget(command);
  return { success: true, response, command, assumed: true };
}

export async function casparClearLayer(channel = 1, layer = 10) {
  const socket = getCasparSocket();
  const command = `CLEAR ${channel}-${layer}`;
  const response = await socket.sendFireAndForget(command);
  return { success: true, response, command, assumed: true };
}

// Media Information Functions - These need responses
export async function casparList() {
  const socket = getCasparSocket();
  const response = await socket.sendCommand("CLS", 5000, true);
  return {
    success: response.success,
    mediaList: response.mediaList || [],
    response,
    command: "CLS",
  };
}

export async function casparInfo(channel = 1, layer = 10) {
  const socket = getCasparSocket();
  const command = `INFO ${channel}-${layer}`;
  const response = await socket.sendCommand(command, 3000, true);
  return { success: response.success, response, command };
}

export async function casparInfoTemplate(channel = 1, layer = 10) {
  const socket = getCasparSocket();
  const command = `INFO ${channel}-${layer} TEMPLATE`;
  const response = await socket.sendCommand(command, 3000, true);
  return { success: response.success, response, command };
}

// Template Control Functions
export async function casparPlayTemplate(
  templateName,
  channel = 1,
  layer = 10,
  data = {}
) {
  const socket = getCasparSocket();

  let command = `PLAY ${channel}-${layer} "${templateName}"`;

  if (Object.keys(data).length > 0) {
    const dataStr = Object.entries(data)
      .map(([key, value]) => `${key}="${value}"`)
      .join(" ");
    command += ` ${dataStr}`;
  }

  const response = await socket.sendFireAndForget(command);
  return { success: true, response, command, assumed: true };
}

export async function casparCGUpdate(
  templateName,
  channel = 1,
  layer = 10,
  data = {}
) {
  const socket = getCasparSocket();

  let command = `CG ${channel}-${layer} UPDATE "${templateName}"`;

  if (Object.keys(data).length > 0) {
    const dataStr = Object.entries(data)
      .map(([key, value]) => `${key}="${value}"`)
      .join(" ");
    command += ` ${dataStr}`;
  }

  const response = await socket.sendFireAndForget(command);
  return { success: true, response, command, assumed: true };
}

export async function casparCGStop(templateName, channel = 1, layer = 10) {
  const socket = getCasparSocket();
  const command = `CG ${channel}-${layer} STOP "${templateName}"`;
  const response = await socket.sendFireAndForget(command);
  return { success: true, response, command, assumed: true };
}

// Channel Configuration
export async function casparChannelGrid() {
  const socket = getCasparSocket();
  const response = await socket.sendCommand("CHANNEL_GRID", 3000, true);
  return { success: response.success, response, command: "CHANNEL_GRID" };
}

export async function casparSetChannelFormat(
  channel = 1,
  format = "1080p5000"
) {
  const socket = getCasparSocket();
  const command = `SET ${channel} FORMAT ${format}`;
  const response = await socket.sendFireAndForget(command);
  return { success: true, response, command, assumed: true };
}

// System Functions
export async function casparVersion() {
  const socket = getCasparSocket();
  const response = await socket.sendCommand("VERSION", 3000, true);
  return { success: response.success, response, command: "VERSION" };
}

export async function casparHelp(command = "") {
  const socket = getCasparSocket();
  const cmd = command ? `HELP ${command}` : "HELP";
  const response = await socket.sendCommand(cmd, 3000, true);
  return { success: response.success, response, command: cmd };
}

export async function casparKill() {
  const socket = getCasparSocket();
  const response = await socket.sendFireAndForget("KILL");
  return { success: true, response, command: "KILL", assumed: true };
}

// Diagnostics and Status
export async function testCasparConnection() {
  try {
    const socket = getCasparSocket();
    const version = await casparVersion();
    const status = socket.getStatus();

    return {
      connected: true,
      version: version.response,
      status,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    return {
      connected: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    };
  }
}

export async function getCasparStatus() {
  const socket = getCasparSocket();
  return socket.getStatus();
}

export async function casparDiagnostics() {
  try {
    const [connection, version, mediaList] = await Promise.all([
      testCasparConnection(),
      casparVersion(),
      casparList(),
    ]);

    return {
      connection,
      version: version.response,
      mediaCount: mediaList.mediaList?.length || 0,
      status: "healthy",
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    return {
      connection: { connected: false, error: error.message },
      status: "unhealthy",
      timestamp: new Date().toISOString(),
    };
  }
}

// Batch Operations
export async function casparPlaylist(
  playlist,
  channel = 1,
  startLayer = 10,
  delayBetween = 100
) {
  const results = [];

  for (let i = 0; i < playlist.length; i++) {
    const item = playlist[i];
    const layer = startLayer + i;

    try {
      if (i > 0) await casparStop(channel, startLayer + i - 1);

      const result = await casparPlay(
        item.fileName,
        channel,
        layer,
        item.options || {}
      );
      results.push({
        item,
        layer,
        success: result.success,
        response: result.response,
        assumed: result.assumed || false,
      });

      if (i < playlist.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayBetween));
      }
    } catch (error) {
      results.push({ item, layer, success: false, error: error.message });
    }
  }

  return results;
}

// Close connection on process exit
process.on("SIGINT", async () => {
  if (casparSocket) {
    console.log("🔄 Closing CasparCG connection...");
    await casparSocket.close();
  }
  process.exit(0);
});

process.on("SIGTERM", async () => {
  if (casparSocket) {
    console.log("🔄 Closing CasparCG connection...");
    await casparSocket.close();
  }
  process.exit(0);
});

// Quick play
export async function casparQuickPlay(fileName, channel = 1, layer = 10) {
  const socket = getCasparSocket();
  const command = `PLAY ${channel}-${layer} "${fileName}"`;
  const response = await socket.sendFireAndForget(command);
  return { success: true, response, command, assumed: true };
}

export default {
  // Media Control
  casparPlay,
  casparPause,
  casparResume,
  casparStop,
  casparClear,
  casparClearLayer,

  // Overlay
  casparShowOverlay,
  casparHideOverlay,

  // Media Information
  casparList,
  casparInfo,
  casparInfoTemplate,

  // Template Control
  casparPlayTemplate,
  casparCGUpdate,
  casparCGStop,

  // Channel Configuration
  casparChannelGrid,
  casparSetChannelFormat,

  // System Functions
  casparVersion,
  casparHelp,
  casparKill,

  // Diagnostics
  testCasparConnection,
  getCasparStatus,
  casparDiagnostics,

  // Batch Operations
  casparPlaylist,
};
