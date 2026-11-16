import * as esbuild from "esbuild";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { renderIcon } from "./icons";

const root = join(import.meta.dir, "..");
const src = join(root, "src");
const dist = join(root, "dist");
const watch = process.argv.includes("--watch");

const ICON_SIZES = [16, 32, 48, 128] as const;
const icons = Object.fromEntries(ICON_SIZES.map((s) => [String(s), `icons/icon-${s}.png`]));

const manifest = {
  manifest_version: 3,
  name: "Multi WhatsApp",
  short_name: "Multi WA",
  version: pkg.version,
  description: pkg.description,
  minimum_chrome_version: "120",
  icons,
  action: { default_popup: "popup.html", default_icon: icons, default_title: "Multi WhatsApp" },
  background: { service_worker: "background.js", type: "module" },
  permissions: ["storage"],
  host_permissions: ["https://web.whatsapp.com/*"],
  content_scripts: [
    {
      matches: ["https://web.whatsapp.com/*"],
      js: ["content.js"],
      run_at: "document_start",
      all_frames: false,
    },
  ],
  commands: {
    _execute_action: {
      suggested_key: { default: "Alt+Shift+W", mac: "MacCtrl+Shift+W" },
      description: "Open the account switcher",
    },
    "next-account": {
      suggested_key: { default: "Alt+Shift+Period", mac: "MacCtrl+Shift+Period" },
      description: "Switch to the next WhatsApp account",
    },
    "prev-account": {
      suggested_key: { default: "Alt+Shift+Comma", mac: "MacCtrl+Shift+Comma" },
      description: "Switch to the previous WhatsApp account",
    },
  },
};

const options: esbuild.BuildOptions = {
  entryPoints: {
    background: join(src, "background/index.ts"),
    content: join(src, "content/index.ts"),
    popup: join(src, "popup/popup.ts"),
  },
  outdir: dist,
  bundle: true,
  format: "iife", // content scripts & classic popup script can't be ES modules
  target: "chrome120",
  platform: "browser",
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  legalComments: "none",
  logLevel: "info",
};

async function writeStatic(): Promise<void> {
  await mkdir(join(dist, "icons"), { recursive: true });
  await writeFile(join(dist, "manifest.json"), JSON.stringify(manifest, null, 2));
  await cp(join(src, "popup/popup.html"), join(dist, "popup.html"));
  await cp(join(src, "popup/popup.css"), join(dist, "popup.css"));
  await Promise.all(ICON_SIZES.map((s) => writeFile(join(dist, `icons/icon-${s}.png`), renderIcon(s))));
}

await rm(dist, { recursive: true, force: true });
await writeStatic();

if (watch) {
  const ctx = await esbuild.context({
    ...options,
    plugins: [{ name: "static", setup: (b) => b.onEnd(() => void writeStatic()) }],
  });
  await ctx.watch();
  console.log("👀 watching… reload the extension at chrome://extensions after changes");
} else {
  await esbuild.build(options);
  console.log(`✅ built Multi WhatsApp v${pkg.version} → dist/`);
}
