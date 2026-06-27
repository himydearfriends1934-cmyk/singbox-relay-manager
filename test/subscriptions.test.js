import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { fetchSubscription, parseSubscriptionText } from "../src/subscriptions.js";

test("parses plain and base64 share-link subscriptions", () => {
  const links = [
    "ss://aes-128-gcm:one@one.example.com:443#One",
    "trojan://secret@two.example.com:8443?sni=two.example.com#Two"
  ];
  const plain = parseSubscriptionText(links.join("\n"));
  assert.equal(plain.format, "links");
  assert.equal(plain.nodes.length, 2);

  const encoded = Buffer.from(links.join("\n")).toString("base64");
  const base64 = parseSubscriptionText(encoded);
  assert.equal(base64.format, "base64");
  assert.equal(base64.nodes[1].type, "trojan");
});

test("parses Clash YAML subscriptions and filters unsupported proxies", () => {
  const result = parseSubscriptionText(`
proxies:
  - name: US-West
    type: ss
    server: west.example.com
    port: 443
    cipher: aes-128-gcm
    password: secret
  - name: Unsupported
    type: direct
  - name: AnyTLS
    type: anytls
    server: anytls.example.com
    port: 443
    password: secret
`);
  assert.equal(result.format, "clash-yaml");
  assert.equal(result.nodes.length, 2);
  assert.equal(result.nodes[0].name, "US-West");
  assert.equal(result.nodes[1].type, "anytls");
  assert.equal(result.detectedCount, 3);
  assert.equal(result.filteredCount, 1);
});

test("parses plain and base64 sing-box JSON subscriptions", () => {
  const document = JSON.stringify({ outbounds: [
    { type: "direct", tag: "direct" },
    {
      type: "shadowsocks", tag: "US-SS", server: "ss.example.com", server_port: 443,
      method: "aes-128-gcm", password: "secret"
    },
    {
      type: "vless", tag: "US-Reality", server: "reality.example.com", server_port: 8443,
      uuid: "00000000-0000-0000-0000-000000000001",
      tls: { enabled: true, server_name: "reality.example.com", insecure: false,
        reality: { public_key: "public-key", short_id: "abcd" }, utls: { fingerprint: "chrome" } },
      transport: { type: "grpc", service_name: "relay" }
    }
  ] });

  const plain = parseSubscriptionText(document);
  assert.equal(plain.format, "sing-box-json");
  assert.equal(plain.detectedCount, 3);
  assert.equal(plain.nodes.length, 2);
  assert.equal(plain.nodes[0].type, "ss");
  assert.equal(plain.nodes[0].port, 443);
  assert.equal(plain.nodes[0].cipher, "aes-128-gcm");
  assert.equal(plain.nodes[1].servername, "reality.example.com");
  assert.equal(plain.nodes[1]["grpc-opts"]["grpc-service-name"], "relay");

  const encoded = parseSubscriptionText(Buffer.from(document).toString("base64"));
  assert.equal(encoded.format, "base64+sing-box-json");
  assert.equal(encoded.nodes.length, 2);
});

test("downloads subscription URLs with Clash-compatible headers", async (t) => {
  const server = http.createServer((request, response) => {
    assert.equal(request.headers["user-agent"], "clash.meta");
    response.end("ss://aes-128-gcm:secret@sub.example.com:443#Imported");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const result = await fetchSubscription(`http://127.0.0.1:${server.address().port}/sub`);
  assert.equal(result.nodes[0].server, "sub.example.com");
});
