import { CreatorSplitsSchema } from "../../modules/creator/creator-splits.schema.js";

const RECIPIENT = `G${"A".repeat(55)}`;
const SECOND_RECIPIENT = `G${"B".repeat(55)}`;

describe("CreatorSplitsSchema", () => {
  test.each([
    ["an invalid Stellar address", [{ to: "not-an-address", bps: 5_000 }]],
    ["fractional basis points", [{ to: RECIPIENT, bps: 1.5 }]],
    ["string basis points", [{ to: RECIPIENT, bps: "5000" }]],
    ["zero basis points", [{ to: RECIPIENT, bps: 0 }]],
    ["negative basis points", [{ to: RECIPIENT, bps: -1 }]],
    ["basis points above 10000", [{ to: RECIPIENT, bps: 10_001 }]],
    [
      "a total above 10000 basis points",
      [
        { to: RECIPIENT, bps: 6_000 },
        { to: SECOND_RECIPIENT, bps: 4_001 },
      ],
    ],
    [
      "a duplicate recipient",
      [
        { to: RECIPIENT, bps: 5_000 },
        { to: RECIPIENT, bps: 2_500 },
      ],
    ],
  ])("rejects %s", (_label, splits) => {
    expect(CreatorSplitsSchema.safeParse(splits).success).toBe(false);
  });

  it("accepts one recipient at 10000 basis points", () => {
    expect(
      CreatorSplitsSchema.safeParse([{ to: RECIPIENT, bps: 10_000 }]).success,
    ).toBe(true);
  });

  it("accepts unique recipients whose total is exactly 10000 basis points", () => {
    expect(
      CreatorSplitsSchema.safeParse([
        { to: RECIPIENT, bps: 6_000 },
        { to: SECOND_RECIPIENT, bps: 4_000 },
      ]).success,
    ).toBe(true);
  });

  it("accepts an empty list for the optional claim split field", () => {
    expect(CreatorSplitsSchema.safeParse([]).success).toBe(true);
  });
});
