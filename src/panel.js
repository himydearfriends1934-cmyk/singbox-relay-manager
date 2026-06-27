#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG_PATH, DEFAULT_NAMES, DEFAULT_OUTPUT_PATH } from "./defaults.js";
import { parseShareLink } from "./linkParsers.js";
import { nodeToShareLink } from "./linkSerializers.js";
import { fetchSubscription } from "./subscriptions.js";
import { buildOpenClashConfig, getExitLabels, getExitNodes, validateConfig, writeOpenClash } from "./openclash.js";
import { loadConfig, saveConfig } from "./store.js";
import { toYaml } from "./yaml.js";

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

function subscriptionUrls(request, token) {
  const forwardedProto = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProto || (request.socket.encrypted ? "https" : "http");
  const origin = `${protocol}://${request.headers.host || "localhost"}`;
  const suffix = token ? `?token=${encodeURIComponent(token)}` : "";
  return {
    v2ray: `${origin}/v2ray.txt${suffix}`,
    openclash: `${origin}/openclash.yaml${suffix}`
  };
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
  const controller = config.subscription?.controller || {};
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
      groups: Array.isArray(config.subscription?.groups) ? config.subscription.groups : [],
      controller: {
        url: controller.url || "",
        configured: Boolean(controller.url)
      }
    },
    sources: {
      hkSubscription: config.sources?.hkSubscription || "",
      usSubscription: config.sources?.usSubscription || "",
      usSubscriptions: Array.isArray(config.sources?.usSubscriptions)
        ? config.sources.usSubscriptions
        : config.sources?.usSubscription ? [config.sources.usSubscription] : [],
      lastImport: config.sources?.lastImport || null
    },
    outputs: { linkCount: sourceLinks(config).length },
    validation: validateConfig(config)
  };
}

function controllerUrl(value) {
  const text = String(value || "").trim().replace(/\/+$/, "");
  if (!text) return "";
  const parsed = new URL(text);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("OpenClash 控制器地址必须使用 http 或 https");
  return text;
}

function resolveProxyRoute(name, proxies, visited = new Set()) {
  if (!name || visited.has(name)) return [];
  visited.add(name);
  const proxy = proxies[name];
  if (!proxy) return [name];
  const next = proxy.now;
  return next && next !== name ? [name, ...resolveProxyRoute(next, proxies, visited)] : [name];
}

async function getRuntimeStatus(config) {
  const controller = config.subscription?.controller || {};
  if (!controller.url) {
    return { configured: false, online: false, message: "请先配置 OpenClash 控制器" };
  }

  const headers = controller.secret ? { authorization: `Bearer ${controller.secret}` } : {};
  try {
    const base = controllerUrl(controller.url);
    const [proxyResponse, connectionResponse] = await Promise.all([
      fetch(`${base}/proxies`, { headers, signal: AbortSignal.timeout(5000) }),
      fetch(`${base}/connections`, { headers, signal: AbortSignal.timeout(5000) }).catch(() => null)
    ]);
    if (!proxyResponse.ok) throw new Error(`控制器返回 HTTP ${proxyResponse.status}`);
    const proxyData = await proxyResponse.json();
    const proxies = proxyData.proxies || {};
    const names = { ...DEFAULT_NAMES, ...(config.subscription?.names || {}) };
    const groupNames = [
      names.group,
      ...(Array.isArray(config.subscription?.groups) ? config.subscription.groups.filter((group) => group.enabled !== false).map((group) => group.name) : [])
    ];
    const groups = [...new Set(groupNames)].filter((name) => proxies[name]).map((name) => ({
      name,
      route: resolveProxyRoute(name, proxies),
      type: proxies[name].type || ""
    }));

    let connections = [];
    if (connectionResponse?.ok) {
      const connectionData = await connectionResponse.json();
      const counts = new Map();
      for (const connection of connectionData.connections || []) {
        const chain = Array.isArray(connection.chains) ? connection.chains.join(" → ") : "";
        if (chain) counts.set(chain, (counts.get(chain) || 0) + 1);
      }
      connections = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([chain, count]) => ({ chain, count }));
    }
    return { configured: true, online: true, checkedAt: new Date().toISOString(), groups, connections };
  } catch (error) {
    return { configured: true, online: false, message: error.name === "TimeoutError" ? "连接 OpenClash 超时" : error.message };
  }
}

function parseNodeInput(input, role, id) {
  let node;
  if (input.link) {
    node = parseShareLink(input.link);
    node.sourceLink = input.link;
  }
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

function sourceLinks(config) {
  return [...new Set([config.nodes?.hk, ...getExitNodes(config)]
    .filter(Boolean)
    .map((node) => node.sourceLink || nodeToShareLink(node))
    .filter(Boolean))];
}

function outputPayload(config, format) {
  const validation = validateConfig(config);
  if (!validation.ok) throw new Error(validation.issues.join(" "));
  if (format === "provider") {
    return { content: toYaml({ proxies: buildOpenClashConfig(config).proxies }), type: "text/yaml; charset=utf-8", filename: "relaykit-provider.yaml" };
  }
  const links = sourceLinks(config);
  if (links.length === 0) throw new Error("当前节点没有可导出的原始分享链接，请使用 OpenClash YAML");
  const raw = `${links.join("\n")}\n`;
  if (format === "v2ray") return { content: Buffer.from(raw).toString("base64"), type: "text/plain; charset=utf-8", filename: "v2ray-subscription.txt" };
  return { content: raw, type: "text/plain; charset=utf-8", filename: "relaykit-links.txt" };
}

async function applyPanelConfig(current, body) {
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
  if (body.subscriptionSources && typeof body.subscriptionSources === "object") {
    config.sources ||= {};
    config.sources.hkSubscription = String(body.subscriptionSources.hkSubscription || "").trim();
    const usSubscriptions = Array.isArray(body.subscriptionSources.usSubscriptions)
      ? body.subscriptionSources.usSubscriptions.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 20)
      : [String(body.subscriptionSources.usSubscription || "").trim()].filter(Boolean);
    config.sources.usSubscriptions = [...new Set(usSubscriptions)];
    config.sources.usSubscription = config.sources.usSubscriptions[0] || "";
  }
  if (body.importSubscriptions === true) {
    config.sources ||= {};
    const summary = { importedAt: new Date().toISOString() };
    if (config.sources.hkSubscription) {
      const imported = await fetchSubscription(config.sources.hkSubscription);
      config.nodes.hk = parseNodeInput({ node: imported.nodes[0] }, "hk");
      summary.hk = { count: imported.detectedCount, used: 1, available: imported.nodes.length, filtered: imported.filteredCount, format: imported.format };
    }
    const usSubscriptionUrls = Array.isArray(config.sources.usSubscriptions) && config.sources.usSubscriptions.length
      ? config.sources.usSubscriptions
      : config.sources.usSubscription ? [config.sources.usSubscription] : [];
    if (usSubscriptionUrls.length) {
      const imports = [];
      for (const subscriptionUrl of usSubscriptionUrls) imports.push(await fetchSubscription(subscriptionUrl));
      const existingExits = Array.isArray(config.nodes.exits) ? config.nodes.exits : [];
      const combinedNodes = [...existingExits];
      const seenNodes = new Set();
      const nodeKey = (node) => JSON.stringify([
        node.type, node.server, Number(node.port), node.uuid || "", node.password || "",
        node.method || node.cipher || "", node.path || "", node.sni || node.serverName || ""
      ]);
      for (const node of existingExits) seenNodes.add(nodeKey(node));
      for (const imported of imports) {
        for (const node of imported.nodes) {
          const key = nodeKey(node);
          if (!seenNodes.has(key)) { seenNodes.add(key); combinedNodes.push(node); }
        }
      }
      const usedIds = new Set();
      config.nodes.exits = combinedNodes.map((node, index) => {
        const baseId = normalizeId(node.id || node.name, `us-${index + 1}`);
        let id = baseId;
        let suffix = 2;
        while (usedIds.has(id)) id = `${baseId}-${suffix++}`;
        usedIds.add(id);
        return parseNodeInput({ node }, "us", id);
      });
      config.nodes.us = null;
      summary.us = {
        subscriptions: imports.length,
        count: imports.reduce((sum, imported) => sum + imported.detectedCount, 0),
        used: combinedNodes.length - existingExits.length,
        total: combinedNodes.length,
        filtered: imports.reduce((sum, imported) => sum + imported.filteredCount, 0),
        format: imports.map((imported) => imported.format).join("+")
      };
    }
    if (!summary.hk && !summary.us) throw new Error("请至少填写一个订阅地址");
    config.sources.lastImport = summary;
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
    if (body.subscription.controller) {
      if (body.subscription.controller.clear === true) {
        delete config.subscription.controller;
      } else {
        const previous = config.subscription.controller || {};
        const url = controllerUrl(body.subscription.controller.url ?? previous.url);
        const secret = String(body.subscription.controller.secret || previous.secret || "").trim();
        config.subscription.controller = { url, secret };
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
    "cache-control": "no-store, max-age=0",
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

      if (["/v2ray.txt", "/sub/v2ray"].includes(url.pathname)) {
        const subscriptionAuthorized = token
          ? safeEqual(url.searchParams.get("token"), token)
          : authorized(request, password);
        if (!subscriptionAuthorized) {
          response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
          response.end("Forbidden\n");
          return;
        }
        const output = outputPayload(loadConfig(configPath), "v2ray");
        response.writeHead(200, { "content-type": output.type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
        response.end(output.content);
        return;
      }

      if (!authorized(request, password)) {
        response.writeHead(401, { "www-authenticate": 'Basic realm="RelayKit Panel", charset="UTF-8"' });
        response.end("Authentication required\n");
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/config") {
        json(response, 200, { ...publicConfig(loadConfig(configPath)), subscriptionUrls: subscriptionUrls(request, token) });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/runtime") {
        json(response, 200, await getRuntimeStatus(loadConfig(configPath)));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/openclash.yaml") {
        const config = loadConfig(configPath);
        const validation = validateConfig(config);
        if (!validation.ok) throw new Error(validation.issues.join(" "));
        const { yaml } = writeOpenClash(config, outputPath);
        response.writeHead(200, {
          "content-type": "text/yaml; charset=utf-8",
          "content-disposition": 'attachment; filename="openclash.yaml"',
          "cache-control": "no-store",
          "x-content-type-options": "nosniff"
        });
        response.end(yaml);
        return;
      }
      if (request.method === "GET" && ["/api/sub/v2ray", "/api/sub/raw", "/api/provider.yaml"].includes(url.pathname)) {
        const format = url.pathname.endsWith("v2ray") ? "v2ray" : url.pathname.endsWith("provider.yaml") ? "provider" : "raw";
        const output = outputPayload(loadConfig(configPath), format);
        response.writeHead(200, {
          "content-type": output.type,
          "content-disposition": `attachment; filename="${output.filename}"`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff"
        });
        response.end(output.content);
        return;
      }
      if (request.method === "PUT" && url.pathname === "/api/config") {
        const next = await applyPanelConfig(loadConfig(configPath), await readBody(request));
        const validation = validateConfig(next);
        saveConfig(next, configPath);
        if (validation.ok) writeOpenClash(next, outputPath);
        json(response, 200, { ok: true, generated: validation.ok, ...publicConfig(loadConfig(configPath)), subscriptionUrls: subscriptionUrls(request, token) });
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
