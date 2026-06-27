function b64url(value) {
  return Buffer.from(String(value)).toString("base64url");
}

function endpoint(node) {
  const host = String(node.server);
  return `${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${Number(node.port)}`;
}

function name(node) {
  return node.name ? `#${encodeURIComponent(node.name)}` : "";
}

function qs(values) {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== "" && value !== false);
  return entries.length ? `?${entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join("&")}` : "";
}

function transport(node) {
  const result = { type: node.network };
  if (node.network === "ws") {
    result.path = node["ws-opts"]?.path;
    result.host = node["ws-opts"]?.headers?.Host || node["ws-opts"]?.headers?.host;
  } else if (node.network === "grpc") {
    result.serviceName = node["grpc-opts"]?.["grpc-service-name"];
  }
  return result;
}

function shadowsocks(node) {
  if (!node.cipher || node.password === undefined) return null;
  return `ss://${b64url(`${node.cipher}:${node.password}`)}@${endpoint(node)}${name(node)}`;
}

function vmess(node) {
  if (!node.uuid) return null;
  const network = node.network || "tcp";
  const data = {
    v: "2", ps: node.name || "RelayKit", add: node.server, port: String(node.port), id: node.uuid,
    aid: String(node.alterId || 0), scy: node.cipher || "auto", net: network, type: "none",
    host: network === "ws" ? node["ws-opts"]?.headers?.Host || "" : "",
    path: network === "ws" ? node["ws-opts"]?.path || "/" : network === "grpc" ? node["grpc-opts"]?.["grpc-service-name"] || "" : "",
    tls: node.tls ? "tls" : "", sni: node.servername || node.sni || ""
  };
  return `vmess://${Buffer.from(JSON.stringify(data)).toString("base64")}`;
}

function urlNode(node) {
  const params = transport(node);
  let user;
  if (node.type === "vless") {
    if (!node.uuid) return null;
    user = encodeURIComponent(node.uuid);
    Object.assign(params, {
      security: node["reality-opts"] ? "reality" : node.tls ? "tls" : "none",
      sni: node.servername || node.sni, fp: node["client-fingerprint"],
      pbk: node["reality-opts"]?.["public-key"], sid: node["reality-opts"]?.["short-id"], flow: node.flow
    });
  } else if (["trojan", "hysteria2", "anytls"].includes(node.type)) {
    if (node.password === undefined) return null;
    user = encodeURIComponent(node.password);
    Object.assign(params, { sni: node.sni || node.servername, insecure: node["skip-cert-verify"] ? 1 : undefined });
    if (node.type === "hysteria2") Object.assign(params, { obfs: node.obfs, "obfs-password": node["obfs-password"] });
  } else if (node.type === "tuic") {
    if (!node.uuid) return null;
    user = `${encodeURIComponent(node.uuid)}:${encodeURIComponent(node.password || "")}`;
    Object.assign(params, { sni: node.sni || node.servername, congestion_control: node["congestion-controller"], udp_relay_mode: node["udp-relay-mode"] });
  } else return null;
  return `${node.type}://${user}@${endpoint(node)}${qs(params)}${name(node)}`;
}

export function nodeToShareLink(node) {
  if (!node?.type || !node.server || !Number(node.port)) return null;
  if (node.type === "ss") return shadowsocks(node);
  if (node.type === "vmess") return vmess(node);
  return urlNode(node);
}
