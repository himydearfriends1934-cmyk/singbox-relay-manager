export const CONFIG_VERSION = 1;

export const DEFAULT_CONFIG_PATH = "data/relaykit.json";
export const DEFAULT_OUTPUT_PATH = "dist/openclash.yaml";

export const DEFAULT_NAMES = {
  hk: "HK-Relay",
  us: "US-Exit",
  chained: "US-via-HK",
  directUs: "US-Direct",
  group: "PROXY"
};

export const DEFAULT_SUBSCRIPTION = {
  output: DEFAULT_OUTPUT_PATH,
  includeDirectUs: true,
  mode: "rule",
  logLevel: "info",
  testUrl: "http://www.gstatic.com/generate_204",
  interval: 300,
  rules: [
    "DOMAIN-SUFFIX,local,DIRECT",
    "IP-CIDR,127.0.0.0/8,DIRECT",
    "IP-CIDR,10.0.0.0/8,DIRECT",
    "IP-CIDR,172.16.0.0/12,DIRECT",
    "IP-CIDR,192.168.0.0/16,DIRECT",
    "GEOIP,CN,DIRECT",
    "MATCH,PROXY"
  ]
};

export function createEmptyConfig() {
  return {
    version: CONFIG_VERSION,
    updatedAt: new Date().toISOString(),
    nodes: {
      hk: null,
      us: null,
      exits: []
    },
    subscription: { ...DEFAULT_SUBSCRIPTION }
  };
}
