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
    type: http
    server: proxy.example.com
    port: 8080
`);
  assert.equal(result.format, "clash-yaml");
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0].name, "US-West");
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
