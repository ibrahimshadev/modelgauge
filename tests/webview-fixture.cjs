// Replace the report method as soon as the application publishes its bridge.
module.exports = function installFixture(desktop) {
  const existing = window.gauge;
  let claims = 0;
  Object.defineProperty(window, "fixtureClaims", { get: () => claims });
  Object.defineProperty(window, "gauge", {
    configurable: true,
    set(bridge) {
      const request = async (id, method, input) => {
        if (desktop && (method === "prices" || method === "summary"))
          return bridge.request(id, method, input);
        if (desktop && method === "reset" && id === "local" &&
            input.instanceId === "codex" && (input.creditId ?? "fixture") === "fixture" && claims === 0) {
          claims++;
          return { outcome: "reset" };
        }
        if (method === "prices")
          return {
            usagePriceOverrides: {
              "example-model": {
                inputCostPerMillionTokens: 1,
                outputCostPerMillionTokens: 2,
              },
            },
            usageModelAliases: {},
          };
        if (method === "limits") {
          await window.fixtureLimitsGate;
          if (window.fixtureEmptyLimits) return { sources: [], providers: [] };
          return {
            sources: [],
            providers:
              id === "local"
                ? [
                    {
                      instanceId: "codex",
                      driver: "codex",
                      displayName: desktop ? "Fixture account" : "Example account",
                      auth: {
                        status: "authenticated",
                        email: "demo@example.invalid",
                      },
                      enabled: true,
                      installed: true,
                      usageLimits: {
                        checkedAt: new Date().toISOString(),
                        windows: [
                          {
                            id: "primary",
                            kind: "session",
                            label: "5-hour",
                            usedPercent: desktop ? 95 : 90,
                            windowDurationMins: 300,
                            resetsAt: new Date(
                              Date.now() + 3600000,
                            ).toISOString(),
                          },
                        ],
                        resetCredits: {
                          availableCount: claims === 0 ? 1 : 0,
                          nextCreditId: "fixture",
                        },
                      },
                    },
                  ]
                : [],
          };
        }
        if (method !== "summary") throw Error("Fixture only permits reading.");
        window.fixtureSummaryWindow = input;
        const fingerprint = {
          provider: "codex",
          hostId: id,
          volumeId: id,
          resolvedHomePath: id,
        };
        return {
          contractVersion: 6,
          readAt: new Date().toISOString(),
          timeZone: input.timeZone,
          sinceDay: input.sinceDay,
          untilDay: input.untilDay,
          sources: [
            {
              fingerprint,
              status: "ok",
              scannedFiles: 1,
              skippedFiles: 0,
              malformedRecords: 0,
              distinctSessions: 1,
              message: null,
            },
          ],
          buckets: [
            {
              provider: "codex",
              day: input.untilDay,
              ...(input.resolution === "hour" ? { hourStart: input.sinceTime } : {}),
              model: "example-model",
              sourcePath: id,
              totals: {
                uncachedInputTokens: 100,
                cachedInputTokens: 30,
                cacheCreationTokens: 0,
                outputTokens: 10,
                reasoningTokens: 0,
              },
              costUsd: 1,
              cacheSavingsUsd: 1,
              categoryCostUsd: {
                input: 0.5,
                cacheRead: 0.2,
                cacheWrite: 0,
                output: 0.3,
              },
              costSource: "modelPriced",
              records: 2,
              unpricedRecords: 1,
              unpricedTokens: 10,
              sessions: 1,
            },
          ],
          pricing: {
            status: "fresh",
            knownModels: 1,
            source: "Fixture",
            fetchedAt: null,
          },
          scanDurationMs: 1,
        };
      };
      Object.defineProperty(window, "gauge", {
        configurable: false,
        writable: false,
        value: Object.freeze({
          ...bridge,
          request,
          environments: desktop ? bridge.environments : async () => [
            { id: "local", label: "Fixture desktop" },
            { id: "second", label: "Fixture WSL" },
          ],
        }),
      });
    },
  });
  if (existing) window.gauge = existing;
};
