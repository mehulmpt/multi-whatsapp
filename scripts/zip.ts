import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };

const root = join(import.meta.dir, "..");
const out = join(root, "release", `multi-whatsapp-${pkg.version}.zip`);
await mkdir(join(root, "release"), { recursive: true });
const proc = Bun.spawnSync(["zip", "-r", "-X", "-q", out, "."], { cwd: join(root, "dist"), stdout: "inherit", stderr: "inherit" });
if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1);
console.log(`📦 ${out}`);
