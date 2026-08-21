export function makeLongTermCandidateDurability(): {
  disposition: "long_term";
  futureReuseScenario: string;
  horizon: "indefinite";
  invalidationTriggers: string[];
  abstractionLevel: "reusable_rule";
  observableFromWorkspace: false;
} {
  return {
    disposition: "long_term",
    futureReuseScenario: "Apply this durable knowledge in a future session.",
    horizon: "indefinite",
    invalidationTriggers: [],
    abstractionLevel: "reusable_rule",
    observableFromWorkspace: false
  };
}
