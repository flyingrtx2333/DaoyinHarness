import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const uiDist = fileURLToPath(new URL("../../ui/dist", import.meta.url));
const target = fileURLToPath(new URL("../dist/public", import.meta.url));

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(uiDist, target, { recursive: true });
