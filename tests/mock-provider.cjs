// Only loaded by the isolated worker test. No request leaves the test process.
const assert = require("node:assert/strict");
let redeemed = false;
global.fetch = async (request, options) => {
  const url = new URL(request.url || request);
  let body;
  if (url.hostname === "chatgpt.com") {
    assert.equal(options.headers.Authorization, "Bearer fixture");
    if (url.pathname.endsWith("/consume")) {
      const claim = JSON.parse(options.body);
      assert.equal(claim.credit_id, "sample");
      assert.ok(claim.redeem_request_id);
      assert.equal(redeemed, false);
      redeemed = true;
      body = { code: "reset" };
    } else if (url.pathname.endsWith("/usage")) {
      // The test throttles the provider by creating this file, and counts the requests made.
      const fs = require("node:fs");
      const marker = require("node:path").join(process.env.MODELGAUGE_HOME, "throttle");
      if (fs.existsSync(marker)) {
        fs.appendFileSync(marker, "x");
        return new Response("", { status: 429, headers: { "retry-after": "120" } });
      }
      body = {
        plan_type: "plus",
        rate_limit: {
          primary_window: { used_percent: 95, limit_window_seconds: 18000 },
        },
      };
    } else if (url.pathname.endsWith("/rate-limit-reset-credits")) {
      body = {
        credits: redeemed
          ? []
          : [
              {
                id: "sample",
                status: "available",
                reset_type: "codex_rate_limits",
                expires_at: "2099-01-01T00:00:00Z",
              },
            ],
      };
    }
  }
  return Response.json(body || {}, { status: body ? 200 : 404 });
};
