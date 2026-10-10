/**
 * Zero-dependency build: generates dist/ from index.html, stamping the
 * build time so a fresh build is visibly different from source mode.
 */
const fs = require("fs");
const src = fs.readFileSync("index.html", "utf8");
const stamp = new Date().toISOString();
const built = src
  .replace("source mode", "built mode")
  .replace(
    "</body>",
    `  <p style="font-size:12px;color:#8b8b9e">built at ${stamp}</p>\n</body>`,
  );
fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/index.html", built);
console.log(`build: wrote dist/index.html (${stamp})`);
