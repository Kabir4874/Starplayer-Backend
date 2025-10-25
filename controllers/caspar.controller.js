import { cfg } from "../config/config.js";
import {
  casparCGStop,
  casparCGUpdate,
  casparChannelGrid,
  casparClear,
  casparClearLayer,
  casparDiagnostics,
  casparHelp,
  casparInfo,
  casparInfoTemplate,
  casparKill,
  casparList,
  casparPause,
  casparPlay,
  casparPlaylist,
  casparPlayTemplate,
  casparResume,
  casparSetChannelFormat,
  casparStop,
  casparVersion,
  getCasparStatus,
  testCasparConnection,
} from "../services/caspar.js";
import { casparBaseName } from "../services/file.js";
import { prisma } from "../services/prisma.js";

function parseIntOrDefault(v, dflt) {
  if (v === undefined || v === null) return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? n : dflt;
}

function parseBoolean(v, dflt = false) {
  if (v === undefined || v === null) return dflt;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    return v.toLowerCase() === "true" || v === "1";
  }
  return Boolean(v);
}

// Media Playback Controllers
export async function play(req, res, next) {
  try {
    let { fileName, id, channel, layer, loop, auto, seek, length, filter } =
      req.body || {};

    // Resolve filename by id if needed
    if (!fileName && id != null) {
      const row = await prisma.media.findUnique({ where: { id: Number(id) } });
      if (!row)
        return res.status(404).json({ ok: false, message: "Media not found" });
      fileName = row.fileName;
    }

    if (!fileName || typeof fileName !== "string" || !fileName.trim()) {
      return res
        .status(400)
        .json({ ok: false, message: 'Provide "fileName" or "id".' });
    }

    // Sanitize channel/layer with safe defaults
    const ch = parseIntOrDefault(channel, cfg.caspar.channel || 1);
    const ly = parseIntOrDefault(layer, cfg.caspar.layer || 10);

    const base = casparBaseName(fileName.trim());

    // Build options object
    const options = {};
    if (loop !== undefined) options.loop = parseBoolean(loop);
    if (auto !== undefined) options.auto = parseBoolean(auto);
    if (seek !== undefined) options.seek = parseInt(seek);
    if (length !== undefined) options.length = parseInt(length);
    if (filter !== undefined) options.filter = filter;

    // Detailed debug logging
    console.log("[CASPAR PLAY REQUEST]", {
      channel: ch,
      layer: ly,
      base,
      options,
      fullCommand: `PLAY ${ch}-${ly} "${base}"`,
    });

    const result = await casparPlay(base, ch, ly, options);

    return res.json({
      ok: true, // Always true for fire-and-forget commands
      command: "PLAY",
      channel: ch,
      layer: ly,
      fileName: base,
      options: options,
      response: result.response,
      assumed: true,
      message: "Command sent successfully to CasparCG",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[PLAY ERROR]", error);
    next(error);
  }
}

export async function pause(req, res, next) {
  try {
    const ch = parseIntOrDefault(req.body?.channel, cfg.caspar.channel || 1);
    const ly = parseIntOrDefault(req.body?.layer, cfg.caspar.layer || 10);

    console.log("[CASPAR PAUSE REQUEST]", { channel: ch, layer: ly });

    const result = await casparPause(ch, ly);

    res.json({
      ok: true, // Always true for fire-and-forget commands
      command: "PAUSE",
      channel: ch,
      layer: ly,
      response: result.response,
      assumed: true,
      message: "Pause command sent successfully to CasparCG",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[PAUSE ERROR]", error);
    next(error);
  }
}

export async function resume(req, res, next) {
  try {
    const ch = parseIntOrDefault(req.body?.channel, cfg.caspar.channel || 1);
    const ly = parseIntOrDefault(req.body?.layer, cfg.caspar.layer || 10);

    console.log("[CASPAR RESUME REQUEST]", { channel: ch, layer: ly });

    const result = await casparResume(ch, ly);

    res.json({
      ok: true, // Always true for fire-and-forget commands
      command: "RESUME",
      channel: ch,
      layer: ly,
      response: result.response,
      assumed: true,
      message: "Resume command sent successfully to CasparCG",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[RESUME ERROR]", error);
    next(error);
  }
}

export async function stop(req, res, next) {
  try {
    const ch = parseIntOrDefault(req.body?.channel, cfg.caspar.channel || 1);
    const ly = parseIntOrDefault(req.body?.layer, cfg.caspar.layer || 10);

    console.log("[CASPAR STOP REQUEST]", { channel: ch, layer: ly });

    const result = await casparStop(ch, ly);

    res.json({
      ok: true, // Always true for fire-and-forget commands
      command: "STOP",
      channel: ch,
      layer: ly,
      response: result.response,
      assumed: true,
      message: "Stop command sent successfully to CasparCG",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[STOP ERROR]", error);
    next(error);
  }
}

export async function clear(req, res, next) {
  try {
    const ch = parseIntOrDefault(req.body?.channel, cfg.caspar.channel || 1);

    console.log("[CASPAR CLEAR REQUEST]", { channel: ch });

    const result = await casparClear(ch);

    res.json({
      ok: true, // Always true for fire-and-forget commands
      command: "CLEAR",
      channel: ch,
      response: result.response,
      assumed: true,
      message: "Clear command sent successfully to CasparCG",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[CLEAR ERROR]", error);
    next(error);
  }
}

export async function clearLayer(req, res, next) {
  try {
    const ch = parseIntOrDefault(req.body?.channel, cfg.caspar.channel || 1);
    const ly = parseIntOrDefault(req.body?.layer, cfg.caspar.layer || 10);

    console.log("[CASPAR CLEAR LAYER REQUEST]", { channel: ch, layer: ly });

    const result = await casparClearLayer(ch, ly);

    res.json({
      ok: true, // Always true for fire-and-forget commands
      command: "CLEAR",
      channel: ch,
      layer: ly,
      response: result.response,
      assumed: true,
      message: "Clear layer command sent successfully to CasparCG",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[CLEAR LAYER ERROR]", error);
    next(error);
  }
}

// Media Information Controllers
export async function listServerMedia(req, res, next) {
  try {
    console.log("[CASPAR LIST REQUEST]");

    const result = await casparList();

    res.json({
      ok: result.success,
      items: result.mediaList,
      count: result.mediaList?.length || 0,
      response: result.response,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[LIST ERROR]", error);
    next(error);
  }
}

export async function info(req, res, next) {
  try {
    const ch = parseIntOrDefault(req.body?.channel, cfg.caspar.channel || 1);
    const ly = parseIntOrDefault(req.body?.layer, cfg.caspar.layer || 10);

    console.log("[CASPAR INFO REQUEST]", { channel: ch, layer: ly });

    const result = await casparInfo(ch, ly);

    res.json({
      ok: result.success,
      command: "INFO",
      channel: ch,
      layer: ly,
      response: result.response,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[INFO ERROR]", error);
    next(error);
  }
}

export async function infoTemplate(req, res, next) {
  try {
    const ch = parseIntOrDefault(req.body?.channel, cfg.caspar.channel || 1);
    const ly = parseIntOrDefault(req.body?.layer, cfg.caspar.layer || 10);

    console.log("[CASPAR INFO TEMPLATE REQUEST]", { channel: ch, layer: ly });

    const result = await casparInfoTemplate(ch, ly);

    res.json({
      ok: result.success,
      command: "INFO TEMPLATE",
      channel: ch,
      layer: ly,
      response: result.response,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[INFO TEMPLATE ERROR]", error);
    next(error);
  }
}

// Template Control Controllers
export async function playTemplate(req, res, next) {
  try {
    const { templateName, channel, layer, data } = req.body || {};

    if (
      !templateName ||
      typeof templateName !== "string" ||
      !templateName.trim()
    ) {
      return res
        .status(400)
        .json({ ok: false, message: 'Provide "templateName".' });
    }

    const ch = parseIntOrDefault(channel, cfg.caspar.channel || 1);
    const ly = parseIntOrDefault(layer, cfg.caspar.layer || 20); // Different layer for templates

    console.log("[CASPAR PLAY TEMPLATE REQUEST]", {
      channel: ch,
      layer: ly,
      templateName,
      data: data || {},
    });

    const result = await casparPlayTemplate(
      templateName.trim(),
      ch,
      ly,
      data || {}
    );

    return res.json({
      ok: true, // Always true for fire-and-forget commands
      command: "PLAY TEMPLATE",
      channel: ch,
      layer: ly,
      templateName: templateName.trim(),
      data: data || {},
      response: result.response,
      assumed: true,
      message: "Template play command sent successfully to CasparCG",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[PLAY TEMPLATE ERROR]", error);
    next(error);
  }
}

export async function cgUpdate(req, res, next) {
  try {
    const { templateName, channel, layer, data } = req.body || {};

    if (
      !templateName ||
      typeof templateName !== "string" ||
      !templateName.trim()
    ) {
      return res
        .status(400)
        .json({ ok: false, message: 'Provide "templateName".' });
    }

    const ch = parseIntOrDefault(channel, cfg.caspar.channel || 1);
    const ly = parseIntOrDefault(layer, cfg.caspar.layer || 20);

    console.log("[CASPAR CG UPDATE REQUEST]", {
      channel: ch,
      layer: ly,
      templateName,
      data: data || {},
    });

    const result = await casparCGUpdate(
      templateName.trim(),
      ch,
      ly,
      data || {}
    );

    return res.json({
      ok: true, // Always true for fire-and-forget commands
      command: "CG UPDATE",
      channel: ch,
      layer: ly,
      templateName: templateName.trim(),
      data: data || {},
      response: result.response,
      assumed: true,
      message: "CG update command sent successfully to CasparCG",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[CG UPDATE ERROR]", error);
    next(error);
  }
}

export async function cgStop(req, res, next) {
  try {
    const { templateName, channel, layer } = req.body || {};

    if (
      !templateName ||
      typeof templateName !== "string" ||
      !templateName.trim()
    ) {
      return res
        .status(400)
        .json({ ok: false, message: 'Provide "templateName".' });
    }

    const ch = parseIntOrDefault(channel, cfg.caspar.channel || 1);
    const ly = parseIntOrDefault(layer, cfg.caspar.layer || 20);

    console.log("[CASPAR CG STOP REQUEST]", {
      channel: ch,
      layer: ly,
      templateName,
    });

    const result = await casparCGStop(templateName.trim(), ch, ly);

    return res.json({
      ok: true, // Always true for fire-and-forget commands
      command: "CG STOP",
      channel: ch,
      layer: ly,
      templateName: templateName.trim(),
      response: result.response,
      assumed: true,
      message: "CG stop command sent successfully to CasparCG",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[CG STOP ERROR]", error);
    next(error);
  }
}

// Channel Configuration Controllers
export async function channelGrid(req, res, next) {
  try {
    console.log("[CASPAR CHANNEL GRID REQUEST]");

    const result = await casparChannelGrid();

    res.json({
      ok: result.success,
      command: "CHANNEL_GRID",
      response: result.response,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[CHANNEL GRID ERROR]", error);
    next(error);
  }
}

export async function setChannelFormat(req, res, next) {
  try {
    const { channel, format } = req.body || {};

    if (!format || typeof format !== "string" || !format.trim()) {
      return res.status(400).json({ ok: false, message: 'Provide "format".' });
    }

    const ch = parseIntOrDefault(channel, cfg.caspar.channel || 1);

    console.log("[CASPAR SET CHANNEL FORMAT REQUEST]", {
      channel: ch,
      format,
    });

    const result = await casparSetChannelFormat(ch, format.trim());

    return res.json({
      ok: true, // Always true for fire-and-forget commands
      command: "SET FORMAT",
      channel: ch,
      format: format.trim(),
      response: result.response,
      assumed: true,
      message: "Set format command sent successfully to CasparCG",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[SET CHANNEL FORMAT ERROR]", error);
    next(error);
  }
}

// System Controllers
export async function version(req, res, next) {
  try {
    console.log("[CASPAR VERSION REQUEST]");

    const result = await casparVersion();

    res.json({
      ok: result.success,
      command: "VERSION",
      response: result.response,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[VERSION ERROR]", error);
    next(error);
  }
}

export async function help(req, res, next) {
  try {
    const { command } = req.query || {};

    console.log("[CASPAR HELP REQUEST]", { command });

    const result = await casparHelp(command);

    res.json({
      ok: result.success,
      command: "HELP",
      query: command || "",
      response: result.response,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[HELP ERROR]", error);
    next(error);
  }
}

export async function kill(req, res, next) {
  try {
    console.log("[CASPAR KILL REQUEST]");

    const result = await casparKill();

    res.json({
      ok: true, // Always true for fire-and-forget commands
      command: "KILL",
      response: result.response,
      assumed: true,
      message: "Kill command sent successfully to CasparCG",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[KILL ERROR]", error);
    next(error);
  }
}

// Diagnostics Controllers
export async function testConnection(req, res, next) {
  try {
    console.log("[CASPAR CONNECTION TEST REQUEST]");

    const result = await testCasparConnection();

    res.json({
      ok: result.connected,
      connected: result.connected,
      version: result.version,
      status: result.status,
      error: result.error,
      timestamp: result.timestamp,
    });
  } catch (error) {
    console.error("[CONNECTION TEST ERROR]", error);
    next(error);
  }
}

export async function status(req, res, next) {
  try {
    console.log("[CASPAR STATUS REQUEST]");

    const result = await getCasparStatus();

    res.json({
      ok: true,
      status: result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[STATUS ERROR]", error);
    next(error);
  }
}

export async function diagnostics(req, res, next) {
  try {
    console.log("[CASPAR DIAGNOSTICS REQUEST]");

    const result = await casparDiagnostics();

    res.json({
      ok: result.status === "healthy",
      diagnostics: result,
      timestamp: result.timestamp,
    });
  } catch (error) {
    console.error("[DIAGNOSTICS ERROR]", error);
    next(error);
  }
}

// Batch Operations Controller
export async function playlist(req, res, next) {
  try {
    const { playlist, channel, startLayer, delayBetween } = req.body || {};

    if (!Array.isArray(playlist) || playlist.length === 0) {
      return res.status(400).json({
        ok: false,
        message: 'Provide "playlist" array with media items.',
      });
    }

    const ch = parseIntOrDefault(channel, cfg.caspar.channel || 1);
    const startLy = parseIntOrDefault(startLayer, cfg.caspar.layer || 10);
    const delay = parseIntOrDefault(delayBetween, 100);

    console.log("[CASPAR PLAYLIST REQUEST]", {
      channel: ch,
      startLayer: startLy,
      itemCount: playlist.length,
      delayBetween: delay,
    });

    const results = await casparPlaylist(playlist, ch, startLy, delay);

    const successCount = results.filter((r) => r.success).length;
    const failedCount = results.filter((r) => !r.success).length;

    return res.json({
      ok: failedCount === 0,
      command: "PLAYLIST",
      channel: ch,
      startLayer: startLy,
      totalItems: playlist.length,
      successCount,
      failedCount,
      results: results,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[PLAYLIST ERROR]", error);
    next(error);
  }
}

// Health check
export async function health(req, res, next) {
  try {
    const connection = await testCasparConnection();

    res.json({
      ok: connection.connected,
      service: "casparcg",
      connected: connection.connected,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  } catch (error) {
    console.error("[HEALTH ERROR]", error);
    next(error);
  }
}
