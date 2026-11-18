import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { MOONSHOT_K3_CONTEXT, MOONSHOT_K3_EFFORTS, STUDIO_KIMI_MODELS } from "../open-sse/config/moonshot.js";
import { LITHOS_KIMI_CAPABILITIES, LITHOS_KIMI_EFFORTS, LITHOS_KIMI_MODEL, LITHOS_KIMI_ROUTE } from "../open-sse/config/lithosai.js";

const routerUrl = "http://127.0.0.1:20128/v1";
const authVariable = "ANTHROPIC_AUTH_TOKEN";
const lithos = { id: LITHOS_KIMI_ROUTE, name: LITHOS_KIMI_MODEL.name, context: LITHOS_KIMI_CAPABILITIES.contextWindow,
  efforts: LITHOS_KIMI_EFFORTS, video: LITHOS_KIMI_CAPABILITIES.videoInput === true };

function section(model) {
  const caps = ["thinking", "always_thinking", "image_in", "tool_use"];
  if (model.video) caps.push("video_in");
  return [
    `[models.${JSON.stringify(model.id)}]`, 'provider = "studio-router"',
    `model = ${JSON.stringify(model.id)}`, `display_name = ${JSON.stringify(model.name)}`,
    `max_context_size = ${model.context}`, `capabilities = ${JSON.stringify(caps)}`,
    `support_efforts = ${JSON.stringify(model.efforts)}`, 'default_effort = "high"',
  ].join("\n");
}

export function buildKimiProfile() {
  const models = STUDIO_KIMI_MODELS.map(m => ({...m, context: MOONSHOT_K3_CONTEXT, efforts: MOONSHOT_K3_EFFORTS}));
  return [
    "# Kimi coding sessions through the Studio 9Router gateway.",
    `default_model = ${JSON.stringify(lithos.id)}`, "telemetry = false", "",
    "[providers.studio-router]", 'type = "kimi"', `base_url = ${JSON.stringify(routerUrl)}`,
    `api_key_env = ${JSON.stringify(authVariable)}`, "", "[thinking]", "enabled = true", 'effort = "high"', "",
    [...models, lithos].map(section).join("\n\n"), "",
  ].join("\n");
}

function sectionBody(text, header) {
  const lines = text.split(/\r?\n/);
  const indexes = lines.flatMap((line, i) => line.trim() === header ? [i] : []);
  if (indexes.length > 1) throw Error("Repeated configuration section " + header);
  if (!indexes.length) return null;
  const start = indexes[0] + 1;
  const next = lines.slice(start).findIndex(line => line.trimStart().startsWith("["));
  return lines.slice(start, next < 0 ? lines.length : start + next).join("\n").trim();
}

export function extendKimiProfile(text) {
  const provider = sectionBody(text, "[providers.studio-router]") ?? "";
  if (!/^base_url\s*=\s*"http:\/\/127\.0\.0\.1:20128\/v1"\s*$/m.test(provider)
      || !/^api_key_env\s*=\s*"ANTHROPIC_AUTH_TOKEN"\s*$/m.test(provider)) {
    throw Error("Existing studio-router provider must resolve to its local gateway");
  }
  const block = section(lithos);
  const [header, ...body] = block.split("\n");
  const existing = sectionBody(text, header);
  if (existing !== null) {
    if (existing !== body.join("\n")) throw Error("Existing Lithos model block differs from the shipped profile");
    return text;
  }
  return text + (text.endsWith("\n") ? "\n" : "\n\n") + block + "\n";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const extend = args.length === 2 && args[0] === "--add-lithos";
  const destination = extend ? args[1] : args[0];
  if ((!extend && args.length !== 1) || !destination || !isAbsolute(destination)) {
    throw Error("Usage: studio-kimi-config.py [--add-lithos] /absolute/path/config.toml");
  }
  const old = extend ? readFileSync(destination, "utf8") : null;
  const content = extend ? extendKimiProfile(old) : buildKimiProfile();
  if (content !== old) {
    mkdirSync(dirname(destination), { recursive:true, mode:0o700 });
    const tmp = destination + "." + randomUUID() + ".next";
    try {
      writeFileSync(tmp, content, { flag:"wx", mode:0o600 });
      if (extend && readFileSync(destination, "utf8") !== old) throw Error("Profile changed while extending it");
      renameSync(tmp, destination);
    } finally {
      try { unlinkSync(tmp); } catch (e) { if (e.code !== "ENOENT") throw e; }
    }
  }
  console.log(JSON.stringify({ path:destination, agent:"kimi", credentialSource:"9Router profile environment", changed:content !== old }));
}
