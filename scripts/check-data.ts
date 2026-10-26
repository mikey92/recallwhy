// Checks a folder of CSV exports against the data contract (src/data-contract.ts, docs/DATA-CONTRACT.md).
//   npm run check:data                      # the committed synthetic data
//   npm run check:data -- --dir ~/exports   # a retailer's own exports
import { checkFolder } from "../src/data-contract.ts";
const i = process.argv.indexOf("--dir");
const dir = i > 0 ? process.argv[i + 1] : "data/synthetic";
const { violations, rows } = checkFolder(dir);
console.log(Object.entries(rows).map(([f, n]) => `${f}: ${n} rows`).join(" · "));
for (const v of violations) console.log(`FAIL ${v.file}: ${v.rule} (${v.count}) e.g. ${v.examples.join("; ")}`);
console.log(violations.length ? `${violations.length} rule(s) broken; not loadable` : "meets the data contract");
process.exit(violations.length ? 1 : 0);
