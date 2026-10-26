// Registers scripts/yaml-hooks.mjs (see there). Loaded with --import by scripts/check-scout.ts.
import { register } from "node:module";
register("./yaml-hooks.mjs", import.meta.url);
