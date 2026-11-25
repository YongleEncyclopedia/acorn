// Assemble what goes into the desktop app (run by `npm run pack` / `npm run dist` in desktop/):
// the server and the web build from the repository, the shell from desktop/, and the server's runtime
// dependencies, laid out as in the repository so every relative import keeps working. electron-builder then
// packs build/app (electron-builder.yml).
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

const desktop = import.meta.dirname;
const repo = path.resolve(desktop, "..");
const out = path.join(desktop, "build", "app");

if (!existsSync(path.join(repo, "dist/web/index.html"))) {
  console.error("The web app has not been built: run `npm run build` in the project root first.");
  process.exit(1);
}

rmSync(path.join(desktop, "build"), { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const copy = (rel) => cpSync(path.join(repo, rel), path.join(out, rel), { recursive: true });

for (const rel of ["src", "dist/web", "plugins", "LICENSE", "package-lock.json", ".npmrc"]) copy(rel);
for (const rel of ["main.ts", "lib.ts", "server.ts", "menu.ts", "preload.cjs", "welcome", "icons/icon.png", "icons/tray.png"]) copy(`desktop/${rel}`);

const root = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8"));
const app = {
  name: "acorn",
  productName: "松果",
  version: root.version,
  description: root.description,
  license: root.license,
  homepage: "https://github.com/YongleEncyclopedia/acorn",
  author: { name: "YongleEncyclopedia", email: "YongleEncyclopedia@users.noreply.github.com" },
  type: "module",
  main: "desktop/main.ts",
  engines: root.engines,
  dependencies: root.dependencies,
  // listed only so the lock file still matches; `--omit=dev` leaves them out
  devDependencies: root.devDependencies,
};
writeFileSync(path.join(out, "package.json"), JSON.stringify(app, null, 2) + "\n");

execSync("npm ci --omit=dev --ignore-scripts --no-audit --no-fund", { cwd: out, stdio: "inherit" });

// electron-builder's dependency collector flattens the tree, and loses versions nested under the packages that
// need them (linkedom's own htmlparser2) and folders some packages bundle (feedsmith/dist/node_modules). The
// install above is exactly what the server runs on in the repository: it goes in as it is (extraResources),
// and the app's package.json declares nothing for the collector to redo.
renameSync(path.join(out, "node_modules"), path.join(desktop, "build", "node_modules"));
const { dependencies: _d, devDependencies: _dd, ...shipped } = app;
writeFileSync(path.join(out, "package.json"), JSON.stringify(shipped, null, 2) + "\n");
console.log(`staged ${path.relative(repo, out)} (松果 ${app.version})`);
