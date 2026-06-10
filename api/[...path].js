// Vercel catch-all function: every /api/* request goes through the shared router.
import { handleApi } from "../lib/app.js";

export default {
  fetch(request) {
    return handleApi(request);
  },
};
