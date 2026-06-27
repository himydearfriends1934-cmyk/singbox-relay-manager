import { parse as parseYaml } from "yaml";
import { parseShareLink } from "./linkParsers.js";

const SUPPORTED_TYPES = new Set([
  "ss", "ssr", "vmess", "vless", "trojan", "hysteria", "hysteria2", "hy2", "tuic",
  "anytls", "mieru", "snell", "socks5", "http", "wireguard", "ssh", "masque",
  "trusttunnel", "openvpn", "sudoku", "tailscale"
]);
const LINK_PATTERN = /(?:ss|ssr|vmess|vless|trojan|hysteria|hysteria2|hy2|tuic|anytls):\/\/[^\s"'<>]+/gi;
const MAX_SUBSCRIPTION_SIZE = 5 * 1024 * 1024;

function normalizeClashNode(proxy) {
  if (!proxy || typeof proxy !== "object" || Array.isArray(proxy)) return null;
  const node = structuredClone(proxy);
  node.type = String(node.type || "").toLowerCase();
  if (!SUPPORTED_TYPES.has(node.type)) return null;
  if (node.type === "hy2") node.type = "hysteria2";
  node.port = Number(node.port);
  if (!node.server || !Number.isInteger(node.port) || node.port < 1 || node.port > 65535) return null;
  delete node["dialer-proxy"];
  node.udp = node.udp !== false;
  return node;
}

function normalizeSingBoxNode(outbound) {
  if (!outbound || typeof outbound !== "object" || Array.isArray(outbound)) return null;
  const aliases = { shadowsocks: "ss", socks: "socks5" };
  const type = aliases[String(outbound.type || "").toLowerCase()] || String(outbound.type || "").toLowerCase();
  if (!SUPPORTED_TYPES.has(type)) return null;

  const node = structuredClone(outbound);
  node.type = type === "hy2" ? "hysteria2" : type;
  node.name = node.name || node.tag;
  node.port = Number(node.port || node.server_port);
  if (!node.server || !Number.isInteger(node.port) || node.port < 1 || node.port > 65535) return null;
  if (node.method && !node.cipher) node.cipher = node.method;
  if (node.alter_id !== undefined && node.alterId === undefined) node.alterId = Number(node.alter_id);

  if (node.tls && typeof node.tls === "object") {
    const tls = node.tls;
    node.tls = tls.enabled !== false;
    node.servername = tls.server_name || tls.servername || tls.sni;
    node["skip-cert-verify"] = tls.insecure === true;
    if (tls.reality && typeof tls.reality === "object") {
      node["client-fingerprint"] = tls.utls?.fingerprint || tls.reality.fingerprint;
      node["reality-opts"] = {
        "public-key": tls.reality.public_key,
        "short-id": tls.reality.short_id
      };
    }
  }

  if (node.transport && typeof node.transport === "object") {
    const transport = node.transport;
    node.network = transport.type;
    if (transport.type === "ws") {
      node["ws-opts"] = { path: transport.path || "/" };
      if (transport.headers) node["ws-opts"].headers = transport.headers;
    } else if (transport.type === "grpc") {
      node["grpc-opts"] = { "grpc-service-name": transport.service_name || "" };
    }
  }

  if (node.obfs && typeof node.obfs === "object") {
    node["obfs-password"] = node.obfs.password;
    node.obfs = node.obfs.type;
  }
  node.udp = node.udp !== false;
  for (const key of ["tag", "server_port", "method", "alter_id", "transport", "multiplex", "detour", "domain_resolver"]) delete node[key];
  return node;
}

function decodeBase64Subscription(text) {
  const compact = text.trim().replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!compact || !/^[A-Za-z0-9+/=]+$/.test(compact)) return "";
  try {
    const decoded = Buffer.from(compact, "base64").toString("utf8");
    return decoded.includes("://") || /^[\s\r\n]*[\[{]/.test(decoded) || /(?:^|\n)\s*(?:proxies|outbounds):/m.test(decoded)
      ? decoded
      : "";
  } catch {
    return "";
  }
}

function nodesFromLinks(text) {
  const links = String(text || "").match(LINK_PATTERN) || [];
  const nodes = [];
  for (const link of links) {
    try {
      const sourceLink = link.trim();
      nodes.push({ ...parseShareLink(sourceLink), sourceLink });
    } catch { /* Ignore unsupported or malformed entries. */ }
  }
  return { nodes, detectedCount: links.length };
}

function deduplicate(nodes) {
  const seen = new Set();
  return nodes.filter((node) => {
    const key = JSON.stringify([node.type, node.server, node.port, node.uuid, node.password, node.cipher, node.name]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseSsd(text) {
  const match = String(text || "").trim().match(/^ssd:\/\/([^\s]+)/i);
  if (!match) return null;
  try {
    const encoded = match[1].replace(/-/g, "+").replace(/_/g, "/");
    const document = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    const servers = Array.isArray(document?.servers) ? document.servers : [];
    const nodes = servers.map((server, index) => normalizeClashNode({
      name: server.remarks || `${document.airport || "SSD"}-${index + 1}`,
      type: "ss", server: server.server, port: server.port || document.port,
      cipher: server.encryption || document.encryption,
      password: server.password || document.password,
      plugin: server.plugin, "plugin-opts": server.plugin_options, udp: true
    })).filter(Boolean);
    return { nodes, detectedCount: servers.length };
  } catch { return null; }
}

function safeFormatHint(text) {
  const raw = String(text || "").trim();
  if (/^\s*</.test(raw)) return "服务器返回了 HTML 页面（订阅地址可能不正确或已过期）";
  const schemes = [...new Set([...raw.matchAll(/\b([a-z][a-z0-9+.-]{1,20}):\/\//gi)].map((match) => match[1].toLowerCase()))];
  if (schemes.length) return `检测到协议：${schemes.slice(0, 8).join(", ")}`;
  try {
    const document = parseYaml(raw);
    if (document && typeof document === "object") {
      const keys = Object.keys(document).slice(0, 8);
      if (keys.length) return `检测到结构字段：${keys.join(", ")}`;
    }
  } catch { /* Use the generic hint below. */ }
  return `响应大小 ${Buffer.byteLength(raw)} 字节，格式未知`;
}

export function parseSubscriptionText(input) {
  const text = String(input || "").replace(/^\uFEFF/, "").trim();
  if (!text) throw new Error("订阅内容为空");

  let candidate = text;
  let parsedLinks = nodesFromLinks(candidate);
  let nodes = parsedLinks.nodes;
  let detectedCount = parsedLinks.detectedCount;
  let format = "links";
  if (nodes.length === 0) {
    const ssd = parseSsd(candidate);
    if (ssd) {
      nodes = ssd.nodes;
      detectedCount = ssd.detectedCount;
      format = "ssd";
    }
  }
  if (nodes.length === 0) {
    const decoded = decodeBase64Subscription(text);
    if (decoded) {
      candidate = decoded.replace(/^\uFEFF/, "").trim();
      parsedLinks = nodesFromLinks(candidate);
      nodes = parsedLinks.nodes;
      detectedCount = parsedLinks.detectedCount;
      format = "base64";
      if (nodes.length === 0) {
        const ssd = parseSsd(candidate);
        if (ssd) {
          nodes = ssd.nodes;
          detectedCount = ssd.detectedCount;
          format = "base64+ssd";
        }
      }
    }
  }
  if (nodes.length === 0) {
    try {
      const document = parseYaml(candidate);
      const proxies = Array.isArray(document?.proxies) ? document.proxies : [];
      const outbounds = Array.isArray(document?.outbounds) ? document.outbounds : [];
      if (proxies.length) {
        detectedCount = proxies.length;
        nodes = proxies.map(normalizeClashNode).filter(Boolean);
        format = candidate === text ? "clash-yaml" : "base64+clash-yaml";
      } else if (outbounds.length) {
        detectedCount = outbounds.length;
        nodes = outbounds.map(normalizeSingBoxNode).filter(Boolean);
        format = candidate === text ? "sing-box-json" : "base64+sing-box-json";
      }
    } catch {
      // The final error below is clearer for panel users.
    }
  }
  nodes = deduplicate(nodes);
  if (nodes.length === 0) throw new Error(`订阅中没有识别到支持的节点。${safeFormatHint(candidate)}`);
  return { nodes, format, detectedCount, filteredCount: Math.max(0, detectedCount - nodes.length) };
}

async function readLimitedBody(response) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_SUBSCRIPTION_SIZE) throw new Error("订阅内容超过 5MB 限制");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_SUBSCRIPTION_SIZE) {
      await reader.cancel();
      throw new Error("订阅内容超过 5MB 限制");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

export async function fetchSubscription(subscriptionUrl) {
  const url = new URL(String(subscriptionUrl || "").trim());
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("订阅地址必须使用 http 或 https");
  const response = await fetch(url, {
    headers: { "user-agent": "clash.meta", accept: "text/yaml,text/plain,*/*" },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`订阅下载失败：HTTP ${response.status}`);
  return parseSubscriptionText(await readLimitedBody(response));
}
