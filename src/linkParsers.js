const URL_TYPES = new Set(["vless", "trojan", "hysteria2", "hy2", "tuic"]);

function decodeBase64Url(input) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function asPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function boolFromParam(value) {
  if (value === null || value === undefined) return undefined;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function cleanName(value) {
  if (!value) return undefined;
  return decodeURIComponent(String(value)).trim() || undefined;
}

function parseHostPort(raw) {
  const target = raw.includes("://") ? raw : `relay://${raw}`;
  const parsed = new URL(target);
  return {
    server: parsed.hostname,
    port: asPort(parsed.port)
  };
}

function parseSs(link) {
  const withoutScheme = link.slice("ss://".length);
  const hashIndex = withoutScheme.indexOf("#");
  const name = hashIndex >= 0 ? cleanName(withoutScheme.slice(hashIndex + 1)) : undefined;
  const beforeHash = hashIndex >= 0 ? withoutScheme.slice(0, hashIndex) : withoutScheme;
  const beforeQuery = beforeHash.split("?")[0];

  let credentials;
  let endpoint;

  if (beforeQuery.includes("@")) {
    const atIndex = beforeQuery.lastIndexOf("@");
    credentials = beforeQuery.slice(0, atIndex);
    endpoint = beforeQuery.slice(atIndex + 1);
    try {
      if (!credentials.includes(":")) credentials = decodeBase64Url(credentials);
    } catch {
      // Some ss links use plain method:password credentials.
    }
  } else {
    const decoded = decodeBase64Url(beforeQuery);
    const atIndex = decoded.lastIndexOf("@");
    if (atIndex < 0) throw new Error("Invalid ss link: missing endpoint");
    credentials = decoded.slice(0, atIndex);
    endpoint = decoded.slice(atIndex + 1);
  }

  const colonIndex = credentials.indexOf(":");
  if (colonIndex < 0) throw new Error("Invalid ss link: missing cipher/password");

  return {
    name,
    type: "ss",
    ...parseHostPort(endpoint),
    cipher: decodeURIComponent(credentials.slice(0, colonIndex)),
    password: decodeURIComponent(credentials.slice(colonIndex + 1)),
    udp: true
  };
}

function parseVmess(link) {
  const encoded = link.slice("vmess://".length).split("#")[0].split("?")[0];
  const config = JSON.parse(decodeBase64Url(encoded));
  const node = {
    name: config.ps,
    type: "vmess",
    server: config.add,
    port: asPort(config.port),
    uuid: config.id,
    alterId: Number(config.aid || 0),
    cipher: config.scy || "auto",
    udp: true
  };

  if (config.tls && config.tls !== "none") {
    node.tls = true;
    if (config.sni) node.servername = config.sni;
  }

  if (config.net && config.net !== "tcp") {
    node.network = config.net;
    if (config.net === "ws") {
      node["ws-opts"] = {
        path: config.path || "/"
      };
      if (config.host) node["ws-opts"].headers = { Host: config.host };
    }
    if (config.net === "grpc") {
      node["grpc-opts"] = {
        "grpc-service-name": config.path || config.type || ""
      };
    }
  }

  return node;
}

function parseUrlProxy(link) {
  const parsed = new URL(link);
  const params = parsed.searchParams;
  const type = parsed.protocol.slice(0, -1).toLowerCase();
  const normalizedType = type === "hy2" ? "hysteria2" : type;
  if (!URL_TYPES.has(type)) throw new Error(`Unsupported link type: ${type}`);

  const node = {
    name: cleanName(parsed.hash ? parsed.hash.slice(1) : undefined),
    type: normalizedType,
    server: parsed.hostname,
    port: asPort(parsed.port),
    udp: true
  };

  if (normalizedType === "vless") {
    node.uuid = decodeURIComponent(parsed.username);
    node.tls = ["tls", "reality"].includes(params.get("security"));
    node.network = params.get("type") || undefined;
    node.servername = params.get("sni") || undefined;
    node.flow = params.get("flow") || undefined;

    if (params.get("security") === "reality") {
      node["client-fingerprint"] = params.get("fp") || undefined;
      node["reality-opts"] = {
        "public-key": params.get("pbk") || undefined,
        "short-id": params.get("sid") || undefined
      };
    }
  }

  if (normalizedType === "trojan") {
    node.password = decodeURIComponent(parsed.username);
    node.sni = params.get("sni") || undefined;
    node.servername = node.sni;
    node["skip-cert-verify"] = boolFromParam(params.get("allowInsecure") || params.get("insecure"));
  }

  if (normalizedType === "hysteria2") {
    node.password = decodeURIComponent(parsed.username);
    node.sni = params.get("sni") || undefined;
    node["skip-cert-verify"] = boolFromParam(params.get("insecure"));
    if (params.get("obfs")) node.obfs = params.get("obfs");
    if (params.get("obfs-password")) node["obfs-password"] = params.get("obfs-password");
  }

  if (normalizedType === "tuic") {
    const [uuid, password] = decodeURIComponent(parsed.username).split(":");
    node.uuid = uuid;
    node.password = password || decodeURIComponent(parsed.password || "");
    node.sni = params.get("sni") || undefined;
    node["congestion-controller"] = params.get("congestion_control") || params.get("congestion-controller") || undefined;
    node["udp-relay-mode"] = params.get("udp_relay_mode") || params.get("udp-relay-mode") || undefined;
  }

  return dropUndefined(node);
}

function dropUndefined(value) {
  if (Array.isArray(value)) return value.map(dropUndefined);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined && item !== "")
      .map(([key, item]) => [key, dropUndefined(item)])
  );
}

export function parseShareLink(link) {
  const value = String(link || "").trim();
  if (value.startsWith("ss://")) return parseSs(value);
  if (value.startsWith("vmess://")) return parseVmess(value);
  if ([...URL_TYPES].some((type) => value.startsWith(`${type}://`))) return parseUrlProxy(value);
  throw new Error("Unsupported link. Supported: ss, vmess, vless, trojan, hysteria2/hy2, tuic.");
}
