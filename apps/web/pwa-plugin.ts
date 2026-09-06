import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";

/** Build-owned cache inventory. Native/API data never enters the service worker. */
export function personalPwa(): Plugin {
  let output = "";
  return {
    name: "leo-pwa",
    apply: "build",
    configResolved(config) { output = resolve(config.root, config.build.outDir); },
    async closeBundle() {
      const names = (await readdir(resolve(output, "assets"))).filter(name => /\.(?:js|css|woff2|png|svg)$/.test(name)).sort();
      const assets = [...names.map(name => `/assets/${name}`), "/icons/leo-192.png", "/icons/leo-512.png", "/icons/leo-maskable-512.png", "/offline-shell.html"];
      const html = (await readFile(resolve(output, "index.html"), "utf8")).replace("</head>", '<meta name="leo-offline" content="true"></head>');
      await writeFile(resolve(output, "offline-shell.html"), html);
      const source = await readFile(new URL("./src/service-worker.js", import.meta.url), "utf8");
      const hash = createHash("sha256").update(source).update(html).update(JSON.stringify(assets));
      for (const path of assets) hash.update(await readFile(resolve(output, "." + path)));
      const version = hash.digest("hex").slice(0, 20);
      await writeFile(resolve(output, "sw.js"), source.replace("__LEO_BUILD_CONFIG__", JSON.stringify({ version, assets })));
    },
  };
}
