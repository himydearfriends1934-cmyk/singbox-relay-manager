import assert from "node:assert/strict";
import test from "node:test";
import { parseShareLink } from "../src/linkParsers.js";
import { nodeToShareLink } from "../src/linkSerializers.js";

test("regenerates V2Ray-compatible links from imported parameters", () => {
  const nodes = [
    { name: "SS", type: "ss", server: "ss.example.com", port: 443, cipher: "aes-128-gcm", password: "secret" },
    { name: "VLESS", type: "vless", server: "vless.example.com", port: 8443, uuid: "00000000-0000-0000-0000-000000000001", tls: true, servername: "vless.example.com" },
    { name: "Trojan", type: "trojan", server: "trojan.example.com", port: 443, password: "secret", sni: "trojan.example.com" }
  ];
  for (const node of nodes) {
    const parsed = parseShareLink(nodeToShareLink(node));
    assert.equal(parsed.type, node.type);
    assert.equal(parsed.server, node.server);
    assert.equal(parsed.port, node.port);
  }
});

test("regenerates vmess links", () => {
  const link = nodeToShareLink({
    name: "VMess", type: "vmess", server: "vmess.example.com", port: 443,
    uuid: "00000000-0000-0000-0000-000000000002", cipher: "auto", tls: true,
    network: "ws", "ws-opts": { path: "/ws", headers: { Host: "cdn.example.com" } }
  });
  const parsed = parseShareLink(link);
  assert.equal(parsed.server, "vmess.example.com");
  assert.equal(parsed["ws-opts"].path, "/ws");
});
