#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG_PATH, DEFAULT_NAMES, DEFAULT_OUTPUT_PATH } from "./defaults.js";
import { parseShareLink } from "./linkParsers.js";
import { getExitLabels, getExitNodes, validateConfig, writeOpenClash } from "./openclash.js";
import { loadConfig, saveConfig } from "./store.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const MAX_BODY = 1024 * 1024;

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    if (key.includes("=")) {
      const [name, ...value] = key.split("=");
      flags[name] = value.join("=");
    } else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
      flags[key] = argv[++i];
    } else flags[key] = true;
  }
  return flags;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function authorized(request, password) {
  if (!password) return true;
  const header = request.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    return separator >= 0 && safeEqual(decoded.slice(separator + 1), password);
  } catch {
    return false;
  }
}

function json(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(value));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("请求内容过大"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new Error("请求 JSON 格式不正确")); }
    });
    request.on("error", reject);
  });
}

function normalizeId(value, fallback = "us-main") {
  return String(value || "").trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || fallback;
}

function publicConfig(config) {
  return {
    updatedAt: config.updatedAt,
    hk: config.nodes?.hk || null,
    exits: getExitNodes(config),
    subscription: {
      includeDirectUs: config.subscription?.includeDirectUs !== false,
      mode: config.subscription?.mode || "rule",
      testUrl: config.subscription?.testUrl,
      interval: config.subscription?.interval || 300,
      selectionMode: config.subscription?.selectionMode || "auto-manual",
      groups: Array.isArray(config.subscription?.groups) ? config.subscription.groups : []
    },
    validation: validateConfig(config)
  };
}

function parseNodeInput(input, role, id) {
  let node;
  if (input.link) node = parseShareLink(input.link);
  else if (input.node && typeof input.node === "object") node = structuredClone(input.node);
  else throw new Error(`${role === "hk" ? "香港" : id} 节点缺少分享链接或参数`);

  if (!node.type || !node.server || !Number(node.port)) {
    throw new Error(`${role === "hk" ? "香港" : id} 节点的协议、服务器和端口不能为空`);
  }
  node.port = Number(node.port);
  if (!Number.isInteger(node.port) || node.port < 1 || node.port > 65535) throw new Error("端口必须在 1-65535 之间");
  node.udp = node.udp !== false;
  if (role === "hk") node.name = DEFAULT_NAMES.hk;
  else {
    node.id = normalizeId(id);
    node.name = getExitLabels(node).direct;
  }
  return node;
}

function applyPanelConfig(current, body) {
  const config = structuredClone(current);
  config.nodes ||= { hk: null, us: null, exits: [] };
  if (body.hk) config.nodes.hk = parseNodeInput(body.hk, "hk");
  if (body.removeHk === true) config.nodes.hk = null;
  if (Array.isArray(body.exits)) {
    config.nodes.exits = body.exits.map((exit, index) => {
      const id = normalizeId(exit.id, `us-${index + 1}`);
      return parseNodeInput(exit, "us", id);
    });
    config.nodes.us = null;
  }
  config.subscription ||= {};
  if (body.subscription) {
    config.subscription.includeDirectUs = body.subscription.includeDirectUs !== false;
    config.subscription.mode = body.subscription.mode === "global" ? "global" : "rule";
    config.subscription.selectionMode = body.subscription.selectionMode === "auto" ? "auto" : "auto-manual";
    const interval = Number(body.subscription.interval || 300);
    config.subscription.interval = Number.isFinite(interval) && interval >= 30 ? interval : 300;
    if (Array.isArray(body.subscription.groups)) {
      const seenNames = new Set();
      config.subscription.groups = body.subscription.groups.slice(0, 12).map((group, index) => {
        const name = String(group.name || `策略组-${index + 1}`).trim().slice(0, 40);
        if (!name) throw new Error("策略组名称不能为空");
        if (seenNames.has(name)) throw new Error(`策略组名称不能重复：${name}`);
        seenNames.add(name);
        const preset = ["gpt", "video", "other", "custom"].includes(group.preset) ? group.preset : "custom";
        return {
          name,
          preset,
          selectionMode: group.selectionMode === "auto" ? "auto" : "auto-manual",
          domains: preset === "custom"
            ? String(group.domains || "").split(/[\n,]+/).map((item) => item.trim()).filter(Boolean).slice(0, 100)
            : undefined
        };
      });
      if (config.subscription.groups.filter((group) => group.preset === "other").length > 1) {
        throw new Error("只能添加一个“其他”兜底组");
      }
    }
  }
  return config;
}

function serveStatic(urlPath, response) {
  const files = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/styles.css": ["styles.css", "text/css; charset=utf-8"]
  };
  const target = files[urlPath];
  if (!target) return false;
  response.writeHead(200, {
    "content-type": target[1],
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer"
  });
  response.end(fs.readFileSync(path.join(PUBLIC_DIR, target[0])));
  return true;
}

export function createPanelServer(options = {}) {
  const configPath = options.configPath || DEFAULT_CONFIG_PATH;
  const outputPath = options.outputPath || DEFAULT_OUTPUT_PATH;
  const password = options.password || "";
  const token = options.token || "";

  return http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    try {
      if (["/openclash.yaml", "/sub/openclash.yaml"].includes(url.pathname)) {
        const subscriptionAuthorized = token
          ? safeEqual(url.searchParams.get("token"), token)
          : authorized(request, password);
        if (!subscriptionAuthorized) {
          response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
          response.end("Forbidden\n");
          return;
        }
        const config = loadConfig(configPath);
        const { yaml } = writeOpenClash(config, outputPath);
        response.writeHead(200, { "content-type": "text/yaml; charset=utf-8", "cache-control": "no-store" });
        response.end(yaml);
        return;
      }

      if (!authorized(request, password)) {
        response.writeHead(401, { "www-authenticate": 'Basic realm="RelayKit Panel", charset="UTF-8"' });
        response.end("Authentication required\n");
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/config") {
        json(response, 200, publicConfig(loadConfig(configPath)));
        return;
      }
      if (request.method === "PUT" && url.pathname === "/api/config") {
        const next = applyPanelConfig(loadConfig(configPath), await readBody(request));
        const validation = validateConfig(next);
        saveConfig(next, configPath);
        if (validation.ok) writeOpenClash(next, outputPath);
        json(response, 200, { ok: true, generated: validation.ok, ...publicConfig(loadConfig(configPath)) });
        return;
      }
      if (request.method === "GET" && serveStatic(url.pathname, response)) return;
      json(response, 404, { error: "Not found" });
    } catch (error) {
      json(response, 400, { error: error.message });
    }
  });
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  const host = flags.host || process.env.RELAYKIT_HOST || "0.0.0.0";
  const port = Number(flags.port || process.env.RELAYKIT_PORT || 8787);
  const password = flags.password || process.env.RELAYKIT_PASSWORD || "";
  const token = flags.token || process.env.RELAYKIT_TOKEN || "";
  if (!["127.0.0.1", "localhost", "::1"].includes(host) && (!password || !token)) {
    throw new Error("对外监听时必须同时设置面板密码和订阅 token");
  }
  const server = createPanelServer({ password, token, configPath: flags.config, outputPath: flags.output });
  server.listen(port, host, () => {
    console.log(`RelayKit panel: http://${host}:${port}`);
    console.log(`OpenClash subscription: http://${host}:${port}/openclash.yaml${token ? "?token=***" : ""}`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`Error: ${error.message}`); process.exitCode = 1; }
}
