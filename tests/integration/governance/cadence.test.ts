import { expect, test } from "vitest";
import { dueOccurrences } from "../../../src/governance/scheduling.js";

test("incremental governance follows a fixed three-day calendar and recovers missed slots", () => {
  expect(dueOccurrences("weekly", "2026-09-11T10:59:59.000Z", "2026-09-20T11:00:00.000Z", "Asia/Shanghai"))
    .toEqual(["2026-09-11T11:00:00.000Z", "2026-09-14T11:00:00.000Z", "2026-09-17T11:00:00.000Z", "2026-09-20T11:00:00.000Z"]);
  expect(dueOccurrences("weekly", "2026-09-14T11:00:00.000Z", "2026-09-17T10:59:59.000Z", "Asia/Shanghai")).toEqual([]);
});

test("full governance runs each Monday and retains historical monthly occurrences", () => {
  expect(dueOccurrences("monthly", "2026-09-01T00:00:00.000Z", "2026-09-28T11:00:00.000Z", "Asia/Shanghai"))
    .toEqual(["2026-09-07T11:00:00.000Z", "2026-09-14T11:00:00.000Z", "2026-09-21T11:00:00.000Z", "2026-09-28T11:00:00.000Z"]);
});
