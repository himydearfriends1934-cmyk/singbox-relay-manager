import { parse as parseYaml } from "yaml";
import { parseShareLink } from "./linkParsers.js";

const SUPPORTED_TYPES = new Set([
  "ss", "ssr", "vmess", "vless", "trojan", "hysteria", "hysteria2", "hy2", "tuic",
  "anytls", "mieru", "snell", "socks5", "http", "wireguard", "ssh", "masque",
  "trusttunnel", "openvpn", "sudoku", "tailscale"
]);
const LINK_PATTERN = /(?:ss|vmess|vless|trojan|hysteria2|hy2|tuic):\/\/[^\s"'<>]+/gi;
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

export function parseSubscriptionText(input) {
  const text = String(input || "").replace(/^\uFEFF/, "").trim();
  if (!text) throw new Error("订阅内容为空");

  let candidate = text;
  let parsedLinks = nodesFromLinks(candidate);
  let nodes = parsedLinks.nodes;
  let detectedCount = parsedLinks.detectedCount;
  let format = "links";
  if (nodes.length === 0) {
    const decoded = decodeBase64Subscription(text);
    if (decoded) {
      candidate = decoded.replace(/^\uFEFF/, "").trim();
      parsedLinks = nodesFromLinks(candidate);
      nodes = parsedLinks.nodes;
      detectedCount = parsedLinks.detectedCount;
      format = "base64";
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
  if (nodes.length === 0) throw new Error("订阅中没有识别到支持的节点");
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
