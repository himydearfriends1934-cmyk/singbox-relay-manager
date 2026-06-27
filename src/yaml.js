function needsQuoting(value) {
  return value === "" ||
    /[:#{}\[\],&*?|<>=!%@`]/.test(value) ||
    /^\s|\s$/.test(value) ||
    /^(true|false|null|yes|no|on|off|[-+]?\d+(\.\d+)?)$/i.test(value);
}

function renderScalar(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  const text = String(value);
  if (!needsQuoting(text) && !text.includes("\n")) return text;
  return JSON.stringify(text);
}

function renderNode(value, indent = 0) {
  const pad = " ".repeat(indent);

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value.map((item) => {
      if (item && typeof item === "object") {
        const rendered = renderNode(item, indent + 2);
        const lines = rendered.split("\n");
        const first = lines[0].replace(new RegExp(`^ {${indent + 2}}`), "");
        const rest = lines.slice(1).join("\n");
        return `${pad}- ${first}${rest ? `\n${rest}` : ""}`;
      }
      return `${pad}- ${renderScalar(item)}`;
    }).join("\n");
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (entries.length === 0) return "{}";

    return entries.map(([key, item]) => {
      if (Array.isArray(item)) {
        if (item.length === 0) return `${pad}${key}: []`;
        return `${pad}${key}:\n${renderNode(item, indent + 2)}`;
      }
      if (item && typeof item === "object") {
        return `${pad}${key}:\n${renderNode(item, indent + 2)}`;
      }
      return `${pad}${key}: ${renderScalar(item)}`;
    }).join("\n");
  }

  return renderScalar(value);
}

export function toYaml(value) {
  return `${renderNode(value, 0)}\n`;
}
