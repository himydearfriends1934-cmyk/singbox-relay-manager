import fs from "node:fs";
import path from "node:path";
import { createEmptyConfig, DEFAULT_CONFIG_PATH } from "./defaults.js";

export function resolvePath(filePath = DEFAULT_CONFIG_PATH) {
  return path.resolve(process.cwd(), filePath);
}

export function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function loadConfig(filePath = DEFAULT_CONFIG_PATH) {
  const resolved = resolvePath(filePath);
  if (!fs.existsSync(resolved)) return createEmptyConfig();
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

export function saveConfig(config, filePath = DEFAULT_CONFIG_PATH) {
  const resolved = resolvePath(filePath);
  ensureParentDir(resolved);
  const nextConfig = {
    ...config,
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(resolved, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  return resolved;
}

export function configExists(filePath = DEFAULT_CONFIG_PATH) {
  return fs.existsSync(resolvePath(filePath));
}
