const $ = (selector, root = document) => root.querySelector(selector);
const list = $("#exitList");
const groupList = $("#groupList");
let config;
let runtimeBusy = false;

function cleanNode(node) {
  if (!node) return null;
  const copy = structuredClone(node);
  delete copy.id; delete copy.name; delete copy.sourceName;
  delete copy.sourceLink;
  return copy;
}

function addExit(exit = {}) {
  const item = $("#exitTemplate").content.firstElementChild.cloneNode(true);
  $(".exit-id", item).value = exit.id || "";
  $(".exit-json", item).value = exit.type ? JSON.stringify(cleanNode(exit), null, 2) : "";
  $(".remove", item).onclick = () => item.remove();
  list.append(item);
}

const GROUP_NAMES = { gpt: "GPT AI", video: "视频", other: "其他", custom: "自定义" };

function addGroup(group = {}) {
  const item = $("#groupTemplate").content.firstElementChild.cloneNode(true);
  const preset = group.preset || "custom";
  $(".group-name", item).value = group.name || GROUP_NAMES[preset];
  $(".group-preset", item).value = preset;
  $(".group-mode", item).value = group.selectionMode || "auto-manual";
  $(".group-domains", item).value = Array.isArray(group.domains) ? group.domains.join("\n") : "";
  const syncDomains = () => { $(".domain-field", item).hidden = $(".group-preset", item).value !== "custom"; };
  $(".group-preset", item).addEventListener("change", syncDomains);
  $(".group-remove", item).onclick = () => item.remove();
  syncDomains();
  groupList.append(item);
}

function showMessage(text, type = "") {
  const el = $("#message"); el.textContent = text; el.className = type;
}

function routeItem(title, value) {
  const item = document.createElement("div");
  item.className = "route-item";
  const label = document.createElement("b"); label.textContent = title;
  const route = document.createElement("span"); route.textContent = value;
  item.append(label, route);
  return item;
}

async function refreshRuntime() {
  if (runtimeBusy) return;
  runtimeBusy = true;
  const state = $("#runtimeState");
  try {
    const response = await fetch("/api/runtime", { cache: "no-store" });
    const runtime = await response.json();
    state.className = `runtime-state ${runtime.online ? "online" : runtime.configured ? "error" : ""}`;
    $("span", state).textContent = runtime.online ? "实时在线" : runtime.message || "未连接";
    const routes = $("#runtimeRoutes");
    routes.replaceChildren();
    if (runtime.online && runtime.groups?.length) {
      runtime.groups.forEach((group) => routes.append(routeItem(group.name, group.route.join(" → "))));
    } else {
      routes.append(routeItem("状态", runtime.online ? "控制器在线，尚未发现匹配的策略组" : runtime.message || "未配置控制器"));
    }
    const connections = runtime.connections || [];
    $("#activeConnections").textContent = connections.length
      ? `活跃连接：${connections.map((item) => `${item.chain} (${item.count})`).join(" · ")}`
      : runtime.online ? "当前没有活跃连接" : "";
  } catch {
    state.className = "runtime-state error";
    $("span", state).textContent = "状态读取失败";
  } finally { runtimeBusy = false; }
}

function render(data) {
  config = data;
  $("#health").classList.toggle("ok", data.validation.ok);
  $("#health span").textContent = data.validation.ok ? "配置就绪" : "等待配置";
  $(".download-yaml").classList.toggle("disabled", !data.validation.ok);
  $(".download-yaml").setAttribute("aria-disabled", String(!data.validation.ok));
  document.querySelectorAll(".output-link").forEach((link) => {
    const disabled = !data.validation.ok || (link.classList.contains("link-output") && !data.outputs?.linkCount);
    link.classList.toggle("disabled", disabled);
    link.setAttribute("aria-disabled", String(disabled));
  });
  $("#hkStatus").textContent = data.hk ? `${data.hk.server}:${data.hk.port}` : "未配置";
  $("#hkMeta").textContent = data.hk ? data.hk.type.toUpperCase() : "等待节点参数";
  $("#exitCount").textContent = `${data.exits.length} 台`;
  $("#updatedAt").textContent = data.updatedAt ? new Date(data.updatedAt).toLocaleString("zh-CN", { month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" }) : "—";
  $("#hkJson").value = data.hk ? JSON.stringify(cleanNode(data.hk), null, 2) : "";
  $("#includeDirect").checked = data.subscription.includeDirectUs;
  $("#mode").value = data.subscription.mode;
  $("#interval").value = data.subscription.interval;
  $("#selectionMode").value = data.subscription.selectionMode || "auto-manual";
  $("#controllerUrl").value = data.subscription.controller?.url || "";
  $("#controllerSecret").value = "";
  $("#hkSubscription").value = data.sources?.hkSubscription || "";
  $("#usSubscription").value = data.sources?.usSubscription || "";
  const imported = data.sources?.lastImport;
  $("#importResult").textContent = imported
    ? `上次导入：香港使用 ${imported.hk?.used || 0}/${imported.hk?.count || 0} 个；美国导入 ${imported.us?.used || 0}/${imported.us?.count || 0} 个${imported.us?.filtered ? `（过滤 ${imported.us.filtered} 个）` : ""}`
    : "";
  list.replaceChildren(); data.exits.forEach(addExit);
  if (data.exits.length === 0) addExit({ id: "us-main" });
  groupList.replaceChildren(); (data.subscription.groups || []).forEach(addGroup);
}

async function load() {
  const response = await fetch("/api/config");
  if (!response.ok) throw new Error("无法读取配置");
  render(await response.json());
}

function parseJson(text, label) {
  try { return JSON.parse(text); } catch { throw new Error(`${label}的手动参数不是有效 JSON`); }
}

$("#addExit").onclick = () => addExit({ id: `us-${list.children.length + 1}` });
$("#toggleAdvanced").onclick = () => {
  const visible = document.body.classList.toggle("show-advanced");
  $("#toggleAdvanced").textContent = visible ? "收起高级设置" : "高级设置";
};
document.querySelectorAll(".add-preset").forEach((button) => {
  button.onclick = () => {
    const preset = button.dataset.preset;
    if (preset === "other" && [...groupList.children].some((item) => $(".group-preset", item).value === "other")) {
      showMessage("“其他”兜底组只能添加一个", "error");
      return;
    }
    addGroup({ preset, name: GROUP_NAMES[preset] });
  };
});
$("#clearHk").onclick = () => { $("#hkLink").value = ""; $("#hkJson").value = ""; $("#hkJson").dataset.remove = "true"; showMessage("香港节点将在保存时清除"); };
$("#hkLink").addEventListener("input", () => { if ($("#hkLink").value.trim()) delete $("#hkJson").dataset.remove; });
$("#hkJson").addEventListener("input", () => { if ($("#hkJson").value.trim()) delete $("#hkJson").dataset.remove; });

$("#configForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $(".primary"); button.disabled = true; showMessage("正在保存并生成…");
  try {
    const hkLink = $("#hkLink").value.trim();
    const hkJson = $("#hkJson").value.trim();
    const isSubscriptionUrl = (value) => /^https?:\/\//i.test(value);
    const implicitUsSubscriptions = [];
    const exits = [...list.children].map((item) => {
      const link = $(".exit-link", item).value.trim();
      const text = $(".exit-json", item).value.trim();
      if (isSubscriptionUrl(link)) {
        implicitUsSubscriptions.push(link);
        return null;
      }
      return { id: $(".exit-id", item).value.trim(), ...(link ? { link } : { node: parseJson(text, "美国节点") }) };
    }).filter(Boolean);
    const implicitHkSubscription = isSubscriptionUrl(hkLink) ? hkLink : "";
    const configuredUsSubscription = $("#usSubscription").value.trim();
    const usSubscriptions = implicitUsSubscriptions.length
      ? implicitUsSubscriptions
      : configuredUsSubscription
        ? (configuredUsSubscription === config.sources?.usSubscription
            ? config.sources?.usSubscriptions || [configuredUsSubscription]
            : [configuredUsSubscription])
        : [];
    const body = {
      subscriptionSources: {
        hkSubscription: implicitHkSubscription || $("#hkSubscription").value.trim(),
        usSubscription: usSubscriptions[0] || "",
        usSubscriptions
      },
      importSubscriptions: event.submitter?.id === "importSubscriptions" || Boolean(implicitHkSubscription || implicitUsSubscriptions.length),
      subscription: {
        includeDirectUs: $("#includeDirect").checked,
        mode: $("#mode").value,
        interval: Number($("#interval").value),
        selectionMode: $("#selectionMode").value,
        groups: [...groupList.children].map((item) => ({
          name: $(".group-name", item).value.trim(),
          preset: $(".group-preset", item).value,
          selectionMode: $(".group-mode", item).value,
          domains: $(".group-domains", item).value
        })),
        controller: {
          url: $("#controllerUrl").value.trim(),
          secret: $("#controllerSecret").value.trim()
        }
      },
      exits
    };
    if ($("#hkJson").dataset.remove === "true") body.removeHk = true;
    else if (hkLink && !implicitHkSubscription) body.hk = { link: hkLink };
    else if (hkJson) body.hk = { node: parseJson(hkJson, "香港节点") };
    const response = await fetch("/api/config", { method:"PUT", headers:{ "content-type":"application/json" }, body:JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "保存失败");
    $("#hkLink").value = ""; delete $("#hkJson").dataset.remove; render(result);
    showMessage(result.generated ? "已保存，订阅已重新生成" : "已保存，补全节点后即可生成订阅", "success");
    refreshRuntime();
  } catch (error) { showMessage(error.message, "error"); }
  finally { button.disabled = false; }
});

load().then(refreshRuntime).catch((error) => showMessage(error.message, "error"));
setInterval(refreshRuntime, 3000);
