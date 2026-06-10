// Password gate for the deployed app (Vercel Edge Middleware).
// Set APP_PASSWORD in Vercel env vars; the browser will prompt once and remember it.
// When APP_PASSWORD is unset (e.g. local dev), everything passes through.
export const config = { matcher: "/:path*" };

export default function middleware(request) {
  const password = process.env.APP_PASSWORD;
  if (!password) return;

  const auth = request.headers.get("authorization") || "";
  if (auth.startsWith("Basic ")) {
    const decoded = atob(auth.slice(6));
    const supplied = decoded.slice(decoded.indexOf(":") + 1); // username is ignored
    if (supplied === password) return;
  }

  return new Response("Sales Compass — password required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Sales Compass"' },
  });
}
