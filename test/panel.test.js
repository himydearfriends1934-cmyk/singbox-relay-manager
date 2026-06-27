import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPanelServer } from "../src/panel.js";

function auth(password) {
  return `Basic ${Buffer.from(`admin:${password}`).toString("base64")}`;
}

test("panel protects config and saves nodes through the API", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relaykit-panel-"));
  const configPath = path.join(dir, "relaykit.json");
  const outputPath = path.join(dir, "openclash.yaml");
  const server = createPanelServer({ configPath, outputPath, password: "panel-secret", token: "sub-secret" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;

  assert.equal((await fetch(`${base}/api/config`)).status, 401);

  const response = await fetch(`${base}/api/config`, {
    method: "PUT",
    headers: { authorization: auth("panel-secret"), "content-type": "application/json" },
    body: JSON.stringify({
      hk: { link: "ss://aes-128-gcm:hkpass@hk.example.com:443#HK" },
      exits: [{ id: "us-west", link: "ss://aes-128-gcm:uspass@us.example.com:8443#US" }],
      subscription: {
        includeDirectUs: true,
        mode: "rule",
        interval: 300,
        selectionMode: "auto-manual",
        groups: [{ name: "GPT AI", preset: "gpt", selectionMode: "auto" }]
      }
    })
  });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.generated, true);
  assert.equal(fs.existsSync(outputPath), true);
  assert.match(fs.readFileSync(outputPath, "utf8"), /US-WEST-via-HK/);
  assert.match(fs.readFileSync(outputPath, "utf8"), /name: GPT AI/);

  assert.equal((await fetch(`${base}/openclash.yaml`)).status, 403);
  const subscription = await fetch(`${base}/openclash.yaml?token=sub-secret`);
  assert.equal(subscription.status, 200);
  assert.match(await subscription.text(), /dialer-proxy: HK-Relay/);
});
