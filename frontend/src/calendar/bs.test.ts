import fixtures from "./bs-fixtures.json";
import { adToBs, adToBsString, bsToAd, BSDateError, daysInBsMonth, formatBs, parseBs, supportedRange } from "./bs";

describe("BS calendar", () => {
  it("matches every backend-generated fixture (same data, same rules)", () => {
    expect(fixtures.length).toBeGreaterThan(500);
    for (const { ad, bs } of fixtures as { ad: string; bs: string }[]) {
      expect(formatBs(adToBs(ad))).toBe(bs);
      expect(bsToAd(parseBs(bs))).toBe(ad);
    }
  });

  it("converts known dates", () => {
    expect(adToBsString("2026-04-14")).toBe("2083-01-01");
    expect(bsToAd(parseBs("2083-04-01"))).toBe("2026-07-17");
  });

  it("round-trips every day of the supported range", () => {
    let t = Date.parse(supportedRange.min + "T00:00:00Z");
    const end = Date.parse(supportedRange.max + "T00:00:00Z");
    let count = 0;
    while (t <= end) {
      const iso = new Date(t).toISOString().slice(0, 10);
      expect(bsToAd(adToBs(iso))).toBe(iso);
      t += 86_400_000;
      count++;
    }
    expect(count).toBeGreaterThan(45_000);
  });

  it("rejects invalid BS dates", () => {
    expect(() => parseBs(`2083-09-${daysInBsMonth(2083, 9) + 1}`)).toThrow(BSDateError);
    expect(() => parseBs("2083-13-01")).toThrow(BSDateError);
    expect(() => parseBs("nonsense")).toThrow(BSDateError);
    expect(() => adToBs("2026-02-30")).toThrow(BSDateError);
  });
});
