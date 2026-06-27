import { parse as parseYaml } from "yaml";
import { parseShareLink } from "./linkParsers.js";

const SUPPORTED_TYPES = new Set(["ss", "vmess", "vless", "trojan", "hysteria2", "hy2", "tuic"]);
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

function decodeBase64Subscription(text) {
  const compact = text.trim().replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!compact || !/^[A-Za-z0-9+/=]+$/.test(compact)) return "";
  try {
    const decoded = Buffer.from(compact, "base64").toString("utf8");
    return decoded.includes("://") ? decoded : "";
  } catch {
    return "";
  }
}

function nodesFromLinks(text) {
  const links = String(text || "").match(LINK_PATTERN) || [];
  const nodes = [];
  for (const link of links) {
    try { nodes.push(parseShareLink(link.trim())); } catch { /* Ignore unsupported or malformed entries. */ }
  }
  return nodes;
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

  let nodes = nodesFromLinks(text);
  let format = "links";
  if (nodes.length === 0) {
    const decoded = decodeBase64Subscription(text);
    if (decoded) {
      nodes = nodesFromLinks(decoded);
      format = "base64";
    }
  }
  if (nodes.length === 0) {
    try {
      const document = parseYaml(text);
      const proxies = Array.isArray(document?.proxies) ? document.proxies : [];
      nodes = proxies.map(normalizeClashNode).filter(Boolean);
      format = "clash-yaml";
    } catch {
      // The final error below is clearer for panel users.
    }
  }
  nodes = deduplicate(nodes);
  if (nodes.length === 0) throw new Error("订阅中没有识别到支持的节点");
  return { nodes, format };
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
