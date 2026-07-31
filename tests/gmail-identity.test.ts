import { describe, expect, test } from "bun:test";

import { gmailDisplayLabel, gmailParticipantLabels } from "../src/gmail/identity";

describe("Gmail identity labels", () => {
  test("keeps display names while excluding addresses", () => {
    expect(gmailDisplayLabel("Taylor Example <taylor@example.com>")).toBe("Taylor Example");
    expect(gmailDisplayLabel('"Thompson Tee Support" <help@example.com>'))
      .toBe("Thompson Tee Support");
    expect(gmailDisplayLabel("person@example.com")).toBeUndefined();
  });

  test("deduplicates bounded participant labels", () => {
    expect(gmailParticipantLabels([
      "Taylor <taylor@example.com>",
      "Taylor <other@example.com>",
      "Updox <notifications@example.com>",
      "bare@example.com",
    ])).toEqual(["Taylor", "Updox"]);
  });
});
