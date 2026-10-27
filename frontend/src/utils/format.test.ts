import { formatAmount, formatDate, formatQty, groupDigits, setNumberLocale } from "./format";

describe("formatting", () => {
  it("groups in lakhs like the backend PDFs", () => {
    expect(groupDigits("12345678", "lakh")).toBe("1,23,45,678");
    expect(groupDigits("1234567", "thousand")).toBe("1,234,567");
    setNumberLocale("en-NP");
    expect(formatAmount("12345678.5")).toBe("1,23,45,678.50");
    expect(formatAmount("-1200")).toBe("−1,200.00");
    expect(formatAmount("0.00")).toBe("0.00");
    expect(formatAmount("123456.78", 0)).toBe("1,23,457");
  });
  it("formats quantities without trailing zeros", () => {
    expect(formatQty("10.000")).toBe("10");
    expect(formatQty("2.500")).toBe("2.5");
  });
  it("formats dates by display mode", () => {
    expect(formatDate("2026-04-14", "AD")).toBe("2026-04-14");
    expect(formatDate("2026-04-14", "BS")).toBe("2083-01-01");
    expect(formatDate("2026-04-14", "AD_BS")).toBe("2083-01-01 · 2026-04-14");
  });
});
