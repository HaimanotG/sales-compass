// Password gate for the deployed app (Vercel Edge Middleware).
// Set APP_PASSWORD in Vercel env vars. The browser prompts once via Basic Auth,
// then we set a long lived HttpOnly cookie so it stops asking every session.
// When APP_PASSWORD is unset (e.g. local dev), everything passes through.
export const config = { matcher: "/:path*" };

const COOKIE = "sc_auth";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

// Stable, non-reversible token derived from the password (so the cookie never
// carries the raw password). Recomputed per request; cheap.
async function tokenFor(password) {
  const data = new TextEncoder().encode("sc-gate-v1:" + password);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function cookieValue(header, name) {
  const m = (header || "").match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return m ? m[1] : "";
}

export default async function middleware(request) {
  const password = process.env.APP_PASSWORD;
  if (!password) return;

  const token = await tokenFor(password);

  // Already holds a valid session cookie: let it through, no prompt.
  if (cookieValue(request.headers.get("cookie"), COOKIE) === token) return;

  // Correct Basic Auth: set the cookie and redirect back, so future visits and
  // future sessions skip the prompt until the cookie expires.
  const auth = request.headers.get("authorization") || "";
  if (auth.startsWith("Basic ")) {
    const decoded = atob(auth.slice(6));
    const supplied = decoded.slice(decoded.indexOf(":") + 1); // username is ignored
    if (supplied === password) {
      const url = new URL(request.url);
      return new Response(null, {
        status: 303,
        headers: {
          Location: url.pathname + url.search,
          "Set-Cookie": `${COOKIE}=${token}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
        },
      });
    }
  }

  // Otherwise challenge for the password.
  return new Response("Sales Compass password required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Sales Compass"' },
  });
}
