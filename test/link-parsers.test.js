import assert from "node:assert/strict";
import test from "node:test";
import { parseShareLink } from "../src/linkParsers.js";
import { buildOpenClashConfig } from "../src/openclash.js";
import { createEmptyConfig } from "../src/defaults.js";

test("parses plain shadowsocks links", () => {
  const node = parseShareLink("ss://aes-128-gcm:secret@example.com:443#HK");
  assert.equal(node.type, "ss");
  assert.equal(node.server, "example.com");
  assert.equal(node.port, 443);
  assert.equal(node.cipher, "aes-128-gcm");
  assert.equal(node.password, "secret");
});

test("parses vmess json links", () => {
  const payload = Buffer.from(JSON.stringify({
    ps: "US",
    add: "us.example.com",
    port: "8443",
    id: "00000000-0000-4000-8000-000000000000",
    aid: "0",
    scy: "auto",
    net: "ws",
    host: "cdn.example.com",
    path: "/ws",
    tls: "tls",
    sni: "us.example.com"
  })).toString("base64");

  const node = parseShareLink(`vmess://${payload}`);
  assert.equal(node.type, "vmess");
  assert.equal(node.network, "ws");
  assert.equal(node["ws-opts"].path, "/ws");
  assert.equal(node.tls, true);
});

test("builds chained OpenClash config with dialer-proxy", () => {
  const config = createEmptyConfig();
  config.nodes.hk = {
    name: "HK-Relay",
    type: "ss",
    server: "hk.example.com",
    port: 443,
    cipher: "aes-128-gcm",
    password: "hk-secret",
    udp: true
  };
  config.nodes.us = {
    name: "US-Exit",
    type: "ss",
    server: "us.example.com",
    port: 443,
    cipher: "aes-128-gcm",
    password: "us-secret",
    udp: true
  };

  const output = buildOpenClashConfig(config);
  const chained = output.proxies.find((proxy) => proxy.name === "US-via-HK");
  assert.equal(chained["dialer-proxy"], "HK-Relay");
  assert.deepEqual(output["proxy-groups"][0].proxies.slice(0, 2), ["AUTO", "US-via-HK"]);
});

test("builds multiple US exits through the same HK relay", () => {
  const config = createEmptyConfig();
  config.nodes.hk = {
    name: "HK-Relay",
    type: "ss",
    server: "hk.example.com",
    port: 443,
    cipher: "aes-128-gcm",
    password: "hk-secret",
    udp: true
  };
  config.nodes.exits = [
    {
      id: "us-west",
      name: "US-WEST-Direct",
      type: "ss",
      server: "west.example.com",
      port: 443,
      cipher: "aes-128-gcm",
      password: "west-secret",
      udp: true
    },
    {
      id: "us-east",
      name: "US-EAST-Direct",
      type: "ss",
      server: "east.example.com",
      port: 443,
      cipher: "aes-128-gcm",
      password: "east-secret",
      udp: true
    }
  ];

  const output = buildOpenClashConfig(config);
  const west = output.proxies.find((proxy) => proxy.name === "US-WEST-via-HK");
  const east = output.proxies.find((proxy) => proxy.name === "US-EAST-via-HK");
  assert.equal(west["dialer-proxy"], "HK-Relay");
  assert.equal(east["dialer-proxy"], "HK-Relay");
  assert.deepEqual(output["proxy-groups"][0].proxies.slice(1, 5), [
    "US-WEST-via-HK",
    "US-WEST-Direct",
    "US-EAST-via-HK",
    "US-EAST-Direct"
  ]);
});

test("builds GPT, video and catch-all policy groups", () => {
  const config = createEmptyConfig();
  config.nodes.hk = { name: "HK-Relay", type: "ss", server: "hk.example.com", port: 443, cipher: "aes-128-gcm", password: "hk" };
  config.nodes.exits = [{ id: "us-main", type: "ss", server: "us.example.com", port: 443, cipher: "aes-128-gcm", password: "us" }];
  config.subscription.groups = [
    { name: "GPT AI", preset: "gpt", selectionMode: "auto" },
    { name: "视频", preset: "video", selectionMode: "auto-manual" },
    { name: "其他", preset: "other", selectionMode: "auto-manual" }
  ];

  const output = buildOpenClashConfig(config);
  const gpt = output["proxy-groups"].find((group) => group.name === "GPT AI");
  const video = output["proxy-groups"].find((group) => group.name === "视频");
  assert.equal(gpt.type, "url-test");
  assert.equal(video.type, "select");
  assert.match(output.rules.join("\n"), /DOMAIN-SUFFIX,openai.com,GPT AI/);
  assert.match(output.rules.join("\n"), /DOMAIN-SUFFIX,youtube.com,视频/);
  assert.equal(output.rules.at(-1), "MATCH,其他");
});
