import { describe, expect, it } from "vitest";
import { usesRehearsalMarksByDefault } from "@/lib/script-types";

describe("usesRehearsalMarksByDefault", () => {
  it.each(["stage_play", "short_film", "film", "tv_drama"])(
    "disables rehearsal marks for %s projects",
    (productionType) => {
      expect(usesRehearsalMarksByDefault(productionType)).toBe(false);
    },
  );

  it("enables rehearsal marks for other and unspecified project types", () => {
    expect(usesRehearsalMarksByDefault("musical")).toBe(true);
    expect(usesRehearsalMarksByDefault("other")).toBe(true);
    expect(usesRehearsalMarksByDefault()).toBe(true);
  });
});
