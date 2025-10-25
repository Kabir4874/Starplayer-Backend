import net from "net";
import { cfg } from "../config/config.js";

class CasparCGSocket {
  constructor() {
    this.host = cfg.caspar.host;
    this.port = cfg.caspar.port;
    this.socket = null;
    this.connected = false;
    this.connectPromise = null;
    this.responseCallbacks = new Map();
    this.requestId = 1;
    this.autoReconnect = true;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.responseBuffer = "";
  }

  async connect() {
    if (this.connectPromise) {
      return this.connectPromise;
    }

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
        console.log("📥 Received raw data:", response);

        // Process complete lines from buffer
        const lines = this.responseBuffer.split("\r\n");

        // Keep the last incomplete line in buffer
        this.responseBuffer = lines.pop() || "";

        lines.forEach((line) => {
          if (line.trim()) {
            console.log("📥 Processing line:", line);
            this.processResponseLine(line.trim());
          }
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

        // Auto-reconnect logic
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
    console.log("🔍 Processing response line:", line);

    // Handle different response formats
    if (line.startsWith("RES")) {
      const parts = line.split(" ");
      const reqId = parts[1];
      const statusCode = parts[2];
      const callback = this.responseCallbacks.get(reqId);

      console.log("🔍 Found RES response:", {
        reqId,
        statusCode,
        hasCallback: !!callback,
      });

      if (callback) {
        const responseObj = {
          requestId: reqId,
          statusCode: parseInt(statusCode),
          data: parts.slice(3).join(" "),
          raw: line,
          success: statusCode >= 200 && statusCode < 400,
        };

        // Parse CLS response into structured data
        if (line.includes("CLS") && statusCode === "200") {
          responseObj.mediaList = this.parseMediaList(line);
        }

        callback(responseObj);
        this.responseCallbacks.delete(reqId);
      }
    } else if (line.startsWith("2")) {
      // Handle immediate success responses (e.g., "202 PLAY OK")
      console.log("🔍 Found immediate success response:", line);
      this.handleImmediateResponse(line);
    } else if (line.startsWith("4") || line.startsWith("5")) {
      // Handle immediate error responses
      console.log("🔍 Found immediate error response:", line);
      this.handleImmediateResponse(line);
    } else {
      console.log("🔍 Unknown response format, ignoring:", line);
    }
  }

  handleImmediateResponse(line) {
    const parts = line.split(" ");
    if (parts.length >= 2) {
      // Try to find request ID in the response
      let reqId = null;

      // Look for potential request ID (usually after status code)
      for (let i = 1; i < parts.length; i++) {
        if (parts[i] && parts[i].match(/^[a-z0-9]{4,6}$/i)) {
          reqId = parts[i];
          break;
        }
      }

      if (reqId) {
        const callback = this.responseCallbacks.get(reqId);
        if (callback) {
          const responseObj = {
            requestId: reqId,
            statusCode: parseInt(parts[0]),
            data: parts.slice(1).join(" "),
            raw: line,
            success: parts[0].startsWith("2"),
          };
          console.log("🔍 Calling callback for immediate response:", reqId);
          callback(responseObj);
          this.responseCallbacks.delete(reqId);
        }
      }
    }
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
      if (!this.connected) {
        await this.connect();
      }

      const reqId = this.generateRequestId();
      const fullCommand = `REQ ${reqId} ${command}\r\n`;

      console.log(`📤 Sending: ${fullCommand.trim()}`);

      // For commands that don't need responses, just send and return success
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

      return new Promise((resolve, reject) => {
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
          console.log("✅ Received response for command:", command);
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
      if (!this.connected) {
        await this.connect();
      }

      const reqId = this.generateRequestId();
      const fullCommand = `REQ ${reqId} ${command}\r\n`;

      console.log(`📤 Sending (fire and forget): ${fullCommand.trim()}`);

      this.socket.write(fullCommand);

      // Immediately return success for fire-and-forget commands
      return {
        success: true,
        command: command,
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
  if (!casparSocket) {
    casparSocket = new CasparCGSocket();
  }
  return casparSocket;
}

// Media Control Functions - Use fire and forget for all control commands
export async function casparPlay(
  fileBaseName,
  channel = 1,
  layer = 10,
  options = {}
) {
  const socket = getCasparSocket();

  // Build play command with options
  let command = `PLAY ${channel}-${layer} "${fileBaseName}"`;

  if (options.loop) command += " LOOP";
  if (options.auto) command += " AUTO";
  if (options.seek !== undefined) command += ` SEEK ${options.seek}`;
  if (options.length !== undefined) command += ` LENGTH ${options.length}`;
  if (options.filter !== undefined) command += ` FILTER ${options.filter}`;

  // Use fire and forget for PLAY commands
  const response = await socket.sendFireAndForget(command);
  return {
    success: true,
    response: response,
    command: command,
    assumed: true,
  };
}

export async function casparPause(channel = 1, layer = 10) {
  const socket = getCasparSocket();
  const command = `PAUSE ${channel}-${layer}`;
  const response = await socket.sendFireAndForget(command);
  return {
    success: true,
    response: response,
    command: command,
    assumed: true,
  };
}

export async function casparResume(channel = 1, layer = 10) {
  const socket = getCasparSocket();
  const command = `RESUME ${channel}-${layer}`;
  const response = await socket.sendFireAndForget(command);
  return {
    success: true,
    response: response,
    command: command,
    assumed: true,
  };
}

export async function casparStop(channel = 1, layer = 10) {
  const socket = getCasparSocket();
  const command = `STOP ${channel}-${layer}`;
  const response = await socket.sendFireAndForget(command);
  return {
    success: true,
    response: response,
    command: command,
    assumed: true,
  };
}

export async function casparClear(channel = 1) {
  const socket = getCasparSocket();
  const command = `CLEAR ${channel}`;
  const response = await socket.sendFireAndForget(command);
  return {
    success: true,
    response: response,
    command: command,
    assumed: true,
  };
}

export async function casparClearLayer(channel = 1, layer = 10) {
  const socket = getCasparSocket();
  const command = `CLEAR ${channel}-${layer}`;
  const response = await socket.sendFireAndForget(command);
  return {
    success: true,
    response: response,
    command: command,
    assumed: true,
  };
}

// Media Information Functions - These need responses
export async function casparList() {
  const socket = getCasparSocket();
  const response = await socket.sendCommand("CLS", 5000, true);
  return {
    success: response.success,
    mediaList: response.mediaList || [],
    response: response,
    command: "CLS",
  };
}

export async function casparInfo(channel = 1, layer = 10) {
  const socket = getCasparSocket();
  const command = `INFO ${channel}-${layer}`;
  const response = await socket.sendCommand(command, 3000, true);
  return {
    success: response.success,
    response: response,
    command: command,
  };
}

export async function casparInfoTemplate(channel = 1, layer = 10) {
  const socket = getCasparSocket();
  const command = `INFO ${channel}-${layer} TEMPLATE`;
  const response = await socket.sendCommand(command, 3000, true);
  return {
    success: response.success,
    response: response,
    command: command,
  };
}

// Template Control Functions - Use fire and forget
export async function casparPlayTemplate(
  templateName,
  channel = 1,
  layer = 10,
  data = {}
) {
  const socket = getCasparSocket();

  let command = `PLAY ${channel}-${layer} "${templateName}"`;

  // Add template data
  if (Object.keys(data).length > 0) {
    const dataStr = Object.entries(data)
      .map(([key, value]) => `${key}="${value}"`)
      .join(" ");
    command += ` ${dataStr}`;
  }

  const response = await socket.sendFireAndForget(command);
  return {
    success: true,
    response: response,
    command: command,
    assumed: true,
  };
}

export async function casparCGUpdate(
  templateName,
  channel = 1,
  layer = 10,
  data = {}
) {
  const socket = getCasparSocket();

  let command = `CG ${channel}-${layer} UPDATE "${templateName}"`;

  // Add template data
  if (Object.keys(data).length > 0) {
    const dataStr = Object.entries(data)
      .map(([key, value]) => `${key}="${value}"`)
      .join(" ");
    command += ` ${dataStr}`;
  }

  const response = await socket.sendFireAndForget(command);
  return {
    success: true,
    response: response,
    command: command,
    assumed: true,
  };
}

export async function casparCGStop(templateName, channel = 1, layer = 10) {
  const socket = getCasparSocket();
  const command = `CG ${channel}-${layer} STOP "${templateName}"`;
  const response = await socket.sendFireAndForget(command);
  return {
    success: true,
    response: response,
    command: command,
    assumed: true,
  };
}

// Channel Configuration Functions - Use fire and forget
export async function casparChannelGrid() {
  const socket = getCasparSocket();
  const response = await socket.sendCommand("CHANNEL_GRID", 3000, true);
  return {
    success: response.success,
    response: response,
    command: "CHANNEL_GRID",
  };
}

export async function casparSetChannelFormat(
  channel = 1,
  format = "1080p5000"
) {
  const socket = getCasparSocket();
  const command = `SET ${channel} FORMAT ${format}`;
  const response = await socket.sendFireAndForget(command);
  return {
    success: true,
    response: response,
    command: command,
    assumed: true,
  };
}

// System Functions - These need responses
export async function casparVersion() {
  const socket = getCasparSocket();
  const response = await socket.sendCommand("VERSION", 3000, true);
  return {
    success: response.success,
    response: response,
    command: "VERSION",
  };
}

export async function casparHelp(command = "") {
  const socket = getCasparSocket();
  const cmd = command ? `HELP ${command}` : "HELP";
  const response = await socket.sendCommand(cmd, 3000, true);
  return {
    success: response.success,
    response: response,
    command: cmd,
  };
}

export async function casparKill() {
  const socket = getCasparSocket();
  const response = await socket.sendFireAndForget("KILL");
  return {
    success: true,
    response: response,
    command: "KILL",
    assumed: true,
  };
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
      status: status,
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
      // Stop previous item if not first
      if (i > 0) {
        await casparStop(channel, startLayer + i - 1);
      }

      // Play current item
      const result = await casparPlay(
        item.fileName,
        channel,
        layer,
        item.options || {}
      );
      results.push({
        item: item,
        layer: layer,
        success: result.success,
        response: result.response,
        assumed: result.assumed || false,
      });

      // Wait before next command if not last item
      if (i < playlist.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayBetween));
      }
    } catch (error) {
      results.push({
        item: item,
        layer: layer,
        success: false,
        error: error.message,
      });
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

// Add to existing exports
export async function casparQuickPlay(fileName, channel = 1, layer = 10) {
  const socket = getCasparSocket();
  const command = `PLAY ${channel}-${layer} "${fileName}"`;

  // Use fire and forget for quick responses
  const response = await socket.sendFireAndForget(command);
  return {
    success: true,
    response: response,
    command: command,
    assumed: true,
  };
}

export default {
  // Media Control
  casparPlay,
  casparPause,
  casparResume,
  casparStop,
  casparClear,
  casparClearLayer,

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
