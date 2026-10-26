import { computeLine, computeTotals } from "./pricing";

describe("pricing preview", () => {
  it("matches the server example (sales order test)", () => {
    const totals = computeTotals([
      { quantity: "10", unit_price: "150", discount_percent: "10", tax_percent: 13 },
      { quantity: "5", unit_price: "60", tax_percent: 13 },
    ], 200);
    expect(totals.taxable).toBe(1650);
    expect(totals.tax).toBe(214.5);
    expect(totals.grand).toBe(2064.5);
  });
  it("rounds each line half-up to cents", () => {
    expect(computeLine({ quantity: 3, unit_price: "33.335", tax_percent: 13 }).taxable).toBe(100.01);
  });
});
