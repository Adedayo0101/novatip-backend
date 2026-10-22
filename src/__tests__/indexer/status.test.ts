import {
  getIndexerPollStatus,
  recordPollError,
  recordSuccessfulPoll,
} from "../../indexer/status.js";

describe("indexer poll status", () => {
  it("tracks successful poll timestamps and clears the previous error", () => {
    recordPollError(new Error("RPC unavailable"));
    expect(getIndexerPollStatus()).toEqual({
      lastSuccessfulPollAt: null,
      lastError: "RPC unavailable",
    });

    recordSuccessfulPoll();

    const status = getIndexerPollStatus();
    expect(status.lastSuccessfulPollAt).toEqual(expect.any(String));
    expect(
      status.lastSuccessfulPollAt === null
        ? Number.NaN
        : Date.parse(status.lastSuccessfulPollAt),
    ).not.toBeNaN();
    expect(status.lastError).toBeNull();
  });
});
