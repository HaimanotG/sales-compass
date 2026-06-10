// Vercel function: every /api/* request is rewritten here (see vercel.json) with
// its original URL intact, then handed to the shared router.
// Vercel's Node runtime requires web handlers as named HTTP-method exports.
import { handleApi } from "../lib/app.js";

const handler = (request) => handleApi(request);

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const PUT = handler;
export const DELETE = handler;
