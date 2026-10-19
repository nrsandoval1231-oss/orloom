// Trusted check target for the node-validate-syntax policy.
import { readFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (pkg.name !== "orloom-sandbox") throw new Error("unexpected package name");
console.log("sandbox ok");
