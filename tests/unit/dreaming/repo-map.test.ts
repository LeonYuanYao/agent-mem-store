import { expect, test } from "vitest";

import { temporaryRootPattern } from "../../../src/dreaming/repo-map.js";

test("system temporary directories and roots under them are temporary", () => {
  for (const root of ["/tmp", "/private/tmp", "/tmp/scratch", "/private/tmp/e2e_run_1", "/var/folders",
    "/private/var/folders/ab/T/clone"]) {
    expect(temporaryRootPattern.test(root), root).toBe(true);
  }
});

test("ordinary roots are not temporary, even when their name starts like one", () => {
  for (const root of ["/private/tmpfiles", "/tmpdata/repo", "/Users/owner/tmp", "/Users/owner/project/tmp/x",
    "/private/var/foldersx"]) {
    expect(temporaryRootPattern.test(root), root).toBe(false);
  }
});
