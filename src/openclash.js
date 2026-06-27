import fs from "node:fs";
import { DEFAULT_NAMES, DEFAULT_OUTPUT_PATH } from "./defaults.js";
import { ensureParentDir, resolvePath } from "./store.js";
import { toYaml } from "./yaml.js";

const COMPLEX_CHAIN_TYPES = new Set(["hysteria2", "tuic", "wireguard"]);
const DEFAULT_EXIT_ID = "us-main";
const GROUP_PRESET_DOMAINS = {
  gpt: ["openai.com", "chatgpt.com", "oaistatic.com", "oaiusercontent.com"],
  video: ["youtube.com", "youtu.be", "googlevideo.com", "ytimg.com", "netflix.com", "nflxvideo.net", "disneyplus.com", "hulu.com"]
};

function cloneProxy(proxy, name) {
  const cloned = structuredClone(proxy);
  cloned.name = name;
  delete cloned.sourceName;
  delete cloned.id;
  return dropUndefined(cloned);
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

function normalizeId(value, fallback = DEFAULT_EXIT_ID) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return fallback;
  return text
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || fallback;
}

function titleFromId(id) {
  return normalizeId(id)
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => part.toUpperCase())
    .join("-");
}

export function getExitNodes(config) {
  const exits = Array.isArray(config.nodes?.exits) ? config.nodes.exits : [];
  if (exits.length > 0) {
    return exits.map((exit, index) => ({
      ...exit,
      id: normalizeId(exit.id, index === 0 ? DEFAULT_EXIT_ID : `us-${index + 1}`)
    }));
  }

  if (config.nodes?.us) {
    return [{
      ...config.nodes.us,
      id: DEFAULT_EXIT_ID
    }];
  }

  return [];
}

export function getExitLabels(exit, names = DEFAULT_NAMES) {
  const id = normalizeId(exit.id);
  if (id === DEFAULT_EXIT_ID) {
    return {
      id,
      direct: names.directUs,
      chained: names.chained
    };
  }

  const label = titleFromId(id);
  return {
    id,
    direct: `${label}-Direct`,
    chained: `${label}-via-HK`
  };
}

export function validateConfig(config) {
  const issues = [];
  const exits = getExitNodes(config);
  if (!config.nodes?.hk) issues.push("HK node is missing.");
  if (exits.length === 0) issues.push("At least one US exit node is missing.");

  const hk = config.nodes?.hk;
  if (hk) {
    if (!hk.type) issues.push("HK node type is missing.");
    if (!hk.server) issues.push("HK node server is missing.");
    if (!hk.port) issues.push("HK node port is missing.");
  }

  for (const exit of exits) {
    const prefix = `US exit "${normalizeId(exit.id)}"`;
    if (!exit.type) issues.push(`${prefix} type is missing.`);
    if (!exit.server) issues.push(`${prefix} server is missing.`);
    if (!exit.port) issues.push(`${prefix} port is missing.`);
  }

  const warnings = [];
  for (const exit of exits) {
    if (COMPLEX_CHAIN_TYPES.has(exit.type)) {
      warnings.push(`US exit "${normalizeId(exit.id)}" type "${exit.type}" can work, but ss/vmess/trojan are usually easier to chain with dialer-proxy.`);
    }
  }

  return { ok: issues.length === 0, issues, warnings };
}

export function buildOpenClashConfig(config) {
  const validation = validateConfig(config);
  if (!validation.ok) {
    throw new Error(validation.issues.join(" "));
  }

  const subscription = config.subscription || {};
  const names = {
    ...DEFAULT_NAMES,
    ...(subscription.names || {})
  };
  const exits = getExitNodes(config);

  const hk = cloneProxy(config.nodes.hk, names.hk);
  const proxies = [hk];
  const groupProxies = [];

  for (const exit of exits) {
    const labels = getExitLabels(exit, names);
    const usViaHk = cloneProxy(exit, labels.chained);
    usViaHk["dialer-proxy"] = names.hk;
    proxies.push(usViaHk);
    groupProxies.push(labels.chained);

    if (subscription.includeDirectUs !== false) {
      const usDirect = cloneProxy(exit, labels.direct);
      proxies.push(usDirect);
      groupProxies.push(labels.direct);
    }
  }

  groupProxies.push(names.hk, "DIRECT");

  const automaticProxies = groupProxies.filter((name) => name !== "DIRECT");
  const interval = subscription.interval || 300;
  const testUrl = subscription.testUrl || "http://www.gstatic.com/generate_204";
  const policyGroups = [];

  function addPolicyGroup(name, selectionMode, automaticName) {
    if (selectionMode === "auto") {
      policyGroups.push({ name, type: "url-test", proxies: automaticProxies, url: testUrl, interval });
      return;
    }
    policyGroups.push({ name, type: "select", proxies: [automaticName, ...groupProxies] });
    policyGroups.push({ name: automaticName, type: "url-test", proxies: automaticProxies, url: testUrl, interval });
  }

  addPolicyGroup(names.group, subscription.selectionMode, "AUTO");
  const configuredGroups = Array.isArray(subscription.groups) ? subscription.groups : [];
  const usedNames = new Set([names.group, "AUTO"]);
  const enabledGroups = [];
  for (const [index, group] of configuredGroups.entries()) {
    if (group?.enabled === false) continue;
    const name = String(group?.name || `策略组-${index + 1}`).trim();
    if (!name || usedNames.has(name)) continue;
    usedNames.add(name);
    const automaticName = `${name}-AUTO`;
    usedNames.add(automaticName);
    addPolicyGroup(name, group.selectionMode, automaticName);
    enabledGroups.push({ ...group, name });
  }

  const routedRules = [];
  for (const group of enabledGroups) {
    if (group.preset === "other") continue;
    const domains = group.preset === "custom"
      ? (Array.isArray(group.domains) ? group.domains : [])
      : (GROUP_PRESET_DOMAINS[group.preset] || []);
    for (const domain of domains) {
      const cleanDomain = String(domain).trim().replace(/^\.+/, "");
      if (cleanDomain) routedRules.push(`DOMAIN-SUFFIX,${cleanDomain},${group.name}`);
    }
  }
  const otherGroup = enabledGroups.find((group) => group.preset === "other");
  const baseRules = subscription.rules || ["MATCH,PROXY"];
  const rules = [
    ...routedRules,
    ...baseRules.map((rule) => rule.startsWith("MATCH,") && otherGroup ? `MATCH,${otherGroup.name}` : rule)
  ];

  return dropUndefined({
    "mixed-port": 7890,
    "allow-lan": true,
    mode: subscription.mode || "rule",
    "log-level": subscription.logLevel || "info",
    proxies,
    "proxy-groups": policyGroups,
    rules
  });
}

export function writeOpenClash(config, outputPath = config.subscription?.output || DEFAULT_OUTPUT_PATH) {
  const resolved = resolvePath(outputPath);
  ensureParentDir(resolved);
  const yaml = toYaml(buildOpenClashConfig(config));
  fs.writeFileSync(resolved, yaml, "utf8");
  return { path: resolved, yaml };
}
