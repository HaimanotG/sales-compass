// Sales Compass — local dev server. Run: bun server.js  (http://localhost:4848)
// On Vercel, static files come from public/ and the API runs via api/index.js.
import { handleApi } from "./lib/app.js";

const PUBLIC = new URL("./public/", import.meta.url).pathname;
const asset = (name) => new Response(Bun.file(PUBLIC + name), { headers: { "Cache-Control": "no-store" } });

const server = Bun.serve({
  port: process.env.PORT || 4848,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/" || path === "/index.html") return asset("index.html");
    if (path === "/style.css") return asset("style.css");
    if (path === "/app.js") return asset("app.js");
    return handleApi(req);
  },
});

console.log(`Sales Compass running → http://localhost:${server.port}`);
