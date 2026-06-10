// Vercel function: every /api/* request is rewritten here (see vercel.json) with
// its original URL intact, then handed to the shared router.
import { handleApi } from "../lib/app.js";

export default {
  fetch(request) {
    return handleApi(request);
  },
};
