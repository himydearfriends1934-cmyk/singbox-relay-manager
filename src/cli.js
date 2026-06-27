#!/usr/bin/env node
import http from "node:http";
import { createEmptyConfig, DEFAULT_CONFIG_PATH, DEFAULT_NAMES, DEFAULT_OUTPUT_PATH } from "./defaults.js";
import { parseShareLink } from "./linkParsers.js";
import { loadConfig, saveConfig, configExists, resolvePath } from "./store.js";
import { getExitLabels, getExitNodes, validateConfig, writeOpenClash } from "./openclash.js";

const ROLE_NAMES = {
  hk: DEFAULT_NAMES.hk,
  us: DEFAULT_NAMES.us
};

function printHelp() {
  console.log(`SingBox Relay Manager

Usage:
  relaykit init [--force]
  relaykit import <hk|us> --link <share-link>
  relaykit set <hk|us> --type <type> --server <ip/domain> --port <port> [fields...]
  relaykit replace <hk|us> --link <share-link>
  relaykit add-us <id> --link <share-link>
  relaykit set-us <id> --type <type> --server <ip/domain> --port <port> [fields...]
  relaykit replace-us <id> --link <share-link>
  relaykit remove-us <id>
  relaykit gen [--output dist/openclash.yaml]
  relaykit status
  relaykit validate
  relaykit serve [--port 8787] [--token secret]

Examples:
  relaykit import hk --link "ss://..."
  relaykit import us --link "vmess://..."
  relaykit add-us us-west --link "ss://..."
  relaykit replace-us us-west --link "trojan://..."
  relaykit replace us --link "trojan://..."
  relaykit gen --output dist/openclash.yaml
`);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const body = arg.slice(2);
    if (body.includes("=")) {
      const [key, ...rest] = body.split("=");
      flags[key] = rest.join("=");
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      flags[body] = next;
      index += 1;
    } else {
      flags[body] = true;
    }
  }

  return { positional, flags };
}

function requireRole(role) {
  if (!["hk", "us"].includes(role)) {
    throw new Error("Role must be hk or us.");
  }
}

function normalizeId(value, fallback = "us-main") {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return fallback;
  return text
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || fallback;
}

function parseBool(value, fallback = undefined) {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function numberValue(value, fallback = undefined) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Invalid number: ${value}`);
  return number;
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

function nodeFromFlags(role, flags) {
  const type = flags.type;
  if (!type) throw new Error("Missing --type.");
  if (!flags.server) throw new Error("Missing --server.");
  if (!flags.port) throw new Error("Missing --port.");

  const node = {
    name: ROLE_NAMES[role],
    type,
    server: flags.server,
    port: numberValue(flags.port),
    udp: parseBool(flags.udp, true)
  };

  if (type === "ss") {
    node.cipher = flags.cipher || flags.method;
    node.password = flags.password;
  }

  if (type === "vmess") {
    node.uuid = flags.uuid || flags.id;
    node.alterId = numberValue(flags.alterId || flags.aid, 0);
    node.cipher = flags.cipher || "auto";
    node.tls = parseBool(flags.tls, false);
    node.network = flags.network;
    node.servername = flags.servername || flags.sni;
    if (flags.path || flags.host) {
      node["ws-opts"] = {
        path: flags.path || "/",
        headers: flags.host ? { Host: flags.host } : undefined
      };
    }
  }

  if (type === "vless") {
    node.uuid = flags.uuid || flags.id;
    node.tls = parseBool(flags.tls, flags.security === "tls" || flags.security === "reality");
    node.network = flags.network || flags["network-type"];
    node.servername = flags.servername || flags.sni;
    node.flow = flags.flow;
    if (flags.publicKey || flags["public-key"] || flags.shortId || flags["short-id"]) {
      node["client-fingerprint"] = flags.fp || flags["client-fingerprint"];
      node["reality-opts"] = {
        "public-key": flags.publicKey || flags["public-key"],
        "short-id": flags.shortId || flags["short-id"]
      };
    }
  }

  if (type === "trojan") {
    node.password = flags.password;
    node.sni = flags.sni;
    node.servername = flags.servername || flags.sni;
    node["skip-cert-verify"] = parseBool(flags.insecure || flags["skip-cert-verify"]);
  }

  if (type === "hysteria2" || type === "hy2") {
    node.type = "hysteria2";
    node.password = flags.password;
    node.sni = flags.sni;
    node["skip-cert-verify"] = parseBool(flags.insecure || flags["skip-cert-verify"]);
    node.obfs = flags.obfs;
    node["obfs-password"] = flags["obfs-password"];
  }

  if (type === "tuic") {
    node.uuid = flags.uuid || flags.id;
    node.password = flags.password;
    node.sni = flags.sni;
    node["congestion-controller"] = flags["congestion-controller"] || flags.congestion;
    node["udp-relay-mode"] = flags["udp-relay-mode"];
  }

  return dropUndefined(node);
}

function setNode(config, role, node) {
  requireRole(role);
  if (role === "us") {
    return upsertExit(config, "us-main", node);
  }

  config.nodes[role] = {
    ...node,
    name: ROLE_NAMES[role],
    sourceName: node.name && node.name !== ROLE_NAMES[role] ? node.name : undefined
  };
  return config;
}

function ensureExits(config) {
  if (!config.nodes) config.nodes = {};
  if (!Array.isArray(config.nodes.exits)) config.nodes.exits = [];
  if (config.nodes.exits.length === 0 && config.nodes.us) {
    config.nodes.exits.push({
      ...config.nodes.us,
      id: "us-main"
    });
    config.nodes.us = null;
  }
  return config.nodes.exits;
}

function upsertExit(config, id, node) {
  const normalizedId = normalizeId(id);
  const exits = ensureExits(config);
  const index = exits.findIndex((exit) => normalizeId(exit.id) === normalizedId);
  const labels = getExitLabels({ id: normalizedId });
  const nextNode = {
    ...node,
    id: normalizedId,
    name: labels.direct,
    sourceName: node.name && node.name !== labels.direct ? node.name : undefined
  };

  if (index >= 0) exits[index] = nextNode;
  else exits.push(nextNode);

  config.nodes.us = null;
  return config;
}

function removeExit(config, id) {
  const normalizedId = normalizeId(id);
  const exits = ensureExits(config);
  const nextExits = exits.filter((exit) => normalizeId(exit.id) !== normalizedId);
  if (nextExits.length === exits.length) {
    throw new Error(`US exit not found: ${normalizedId}`);
  }
  config.nodes.exits = nextExits;
  config.nodes.us = null;
  return config;
}

function printStatus(config) {
  const hk = config.nodes?.hk;
  if (!hk) {
    console.log("HK: not set");
  } else {
    console.log(`HK: ${hk.type} ${hk.server}:${hk.port} (${hk.name})`);
  }

  const exits = getExitNodes(config);
  if (exits.length === 0) {
    console.log("US exits: not set");
  } else {
    console.log(`US exits: ${exits.length}`);
    for (const exit of exits) {
      const labels = getExitLabels(exit);
      console.log(`- ${exit.id}: ${exit.type} ${exit.server}:${exit.port} (${labels.chained})`);
    }
  }

  const validation = validateConfig(config);
  console.log(`Config: ${validation.ok ? "ready" : "incomplete"}`);
  for (const issue of validation.issues) console.log(`- ${issue}`);
  for (const warning of validation.warnings) console.log(`- Warning: ${warning}`);
}

function saveAndMaybeGenerate(config, flags) {
  const saved = saveConfig(config, flags.config || DEFAULT_CONFIG_PATH);
  console.log(`Saved config: ${saved}`);
  if (flags.gen !== false && flags["no-gen"] !== true) {
    const validation = validateConfig(config);
    if (!validation.ok) {
      console.log(`Skipped subscription generation: ${validation.issues.join(" ")}`);
      return;
    }
    const output = flags.output || config.subscription?.output || DEFAULT_OUTPUT_PATH;
    const result = writeOpenClash(config, output);
    console.log(`Generated OpenClash subscription: ${result.path}`);
  }
}

async function serveSubscription(config, flags) {
  const port = Number(flags.port || 8787);
  const host = flags.host || "0.0.0.0";
  const token = flags.token;
  const configPath = flags.config || DEFAULT_CONFIG_PATH;

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (token && url.searchParams.get("token") !== token) {
      response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      response.end("Forbidden\n");
      return;
    }

    if (!["/", "/openclash.yaml", "/sub/openclash.yaml"].includes(url.pathname)) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found\n");
      return;
    }

    const latestConfig = loadConfig(configPath);
    const { yaml } = writeOpenClash(latestConfig, latestConfig.subscription?.output || DEFAULT_OUTPUT_PATH);
    response.writeHead(200, {
      "content-type": "text/yaml; charset=utf-8",
      "cache-control": "no-store"
    });
    response.end(yaml);
  });

  server.listen(port, host, () => {
    const suffix = token ? `?token=${encodeURIComponent(token)}` : "";
    console.log(`Serving OpenClash subscription: http://${host}:${port}/openclash.yaml${suffix}`);
  });
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0] || "help";

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "init") {
    if (configExists(flags.config || DEFAULT_CONFIG_PATH) && !flags.force) {
      throw new Error(`Config already exists: ${resolvePath(flags.config || DEFAULT_CONFIG_PATH)}. Use --force to overwrite.`);
    }
    const saved = saveConfig(createEmptyConfig(), flags.config || DEFAULT_CONFIG_PATH);
    console.log(`Initialized config: ${saved}`);
    return;
  }

  const config = loadConfig(flags.config || DEFAULT_CONFIG_PATH);

  if (command === "import" || command === "replace") {
    const role = positional[1];
    requireRole(role);
    if (!flags.link) throw new Error("Missing --link.");
    const node = parseShareLink(flags.link);
    setNode(config, role, node);
    saveAndMaybeGenerate(config, flags);
    return;
  }

  if (command === "add-us" || command === "replace-us") {
    const id = positional[1];
    if (!id) throw new Error("Missing US exit id.");
    if (!flags.link) throw new Error("Missing --link.");
    const node = parseShareLink(flags.link);
    upsertExit(config, id, node);
    saveAndMaybeGenerate(config, flags);
    return;
  }

  if (command === "set-us") {
    const id = positional[1];
    if (!id) throw new Error("Missing US exit id.");
    const node = nodeFromFlags("us", flags);
    upsertExit(config, id, node);
    saveAndMaybeGenerate(config, flags);
    return;
  }

  if (command === "remove-us") {
    const id = positional[1];
    if (!id) throw new Error("Missing US exit id.");
    removeExit(config, id);
    saveAndMaybeGenerate(config, flags);
    return;
  }

  if (command === "set") {
    const role = positional[1];
    requireRole(role);
    const node = nodeFromFlags(role, flags);
    setNode(config, role, node);
    saveAndMaybeGenerate(config, flags);
    return;
  }

  if (command === "gen") {
    if (flags.output) config.subscription.output = flags.output;
    const saved = saveConfig(config, flags.config || DEFAULT_CONFIG_PATH);
    const result = writeOpenClash(config, flags.output || config.subscription.output);
    console.log(`Saved config: ${saved}`);
    console.log(`Generated OpenClash subscription: ${result.path}`);
    return;
  }

  if (command === "status") {
    printStatus(config);
    return;
  }

  if (command === "validate") {
    const validation = validateConfig(config);
    for (const issue of validation.issues) console.log(`Issue: ${issue}`);
    for (const warning of validation.warnings) console.log(`Warning: ${warning}`);
    if (!validation.ok) process.exitCode = 1;
    else console.log("Config is ready.");
    return;
  }

  if (command === "serve") {
    const validation = validateConfig(config);
    if (!validation.ok) throw new Error(validation.issues.join(" "));
    await serveSubscription(config, flags);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
