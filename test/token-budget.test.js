const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const identity = require("../identity");
const {
  MIN_ANSWER_TOKENS,
  THINKING_BUDGET,
  MAX_OUTPUT_TOKENS,
  MIN_PLAIN_TOKENS,
  isReasoningModel,
  isReasoningRequest,
  effectiveMaxTokens,
} = require("../token-budget");

describe("token-budget", () => {
  beforeEach(() => {
    identity.__reset();
    identity.applyRecipe({
      modelFacts: {
        "muse-spark-1.3-contributor-free": { reasoning: true, maxOutput: 131072 },
        "muse-spark-1.2-contributor-free": { reasoning: true, maxOutput: 131072 },
        "mimo-v2.6-flash-free": { reasoning: true, maxOutput: 32000 },
        "nemotron-3.5-lightning-free": { reasoning: true, maxOutput: 262144 },
        "longcat-2.5-preview-free": { reasoning: true, maxOutput: 131072 },
        "cat-jam-free": { reasoning: true, maxOutput: 131072 },
        "big-pickle": { reasoning: true, maxOutput: 32000 },
        "step-5-preview-free": { reasoning: true, maxOutput: 65536 },
        "deepseek-v4.1-flash-free": { reasoning: true, maxOutput: 32000 },
        "space-bunny-free": { reasoning: false, maxOutput: 131072 },
      },
    });
  });
  afterEach(() => {
    identity.__reset();
  });

  it("recognizes reasoning and non-reasoning models from catalog facts", () => {
    const reasoningModels = [
      "muse-spark-1.3-contributor-free",
      "muse-spark-1.2-contributor-free",
      "mimo-v2.6-flash-free",
      "nemotron-3.5-lightning-free",
      "longcat-2.5-preview-free",
      "cat-jam-free",
      "big-pickle",
      "step-5-preview-free",
      "deepseek-v4.1-flash-free",
    ];
    for (const model of reasoningModels) {
      assert.equal(isReasoningModel(model), true, `Expected ${model} to be a reasoning model`);
    }
    assert.equal(isReasoningModel("space-bunny-free"), false);
    assert.equal(isReasoningModel("unlisted-model"), false);
  });

  it("applies additive formula max(requested, 1024) + 4096 for reasoning models", () => {
    // Below answer floor (50 -> 1024 + 4096 = 5120)
    assert.equal(effectiveMaxTokens(50, "muse-spark-1.3-contributor-free", {}), 5120);
    assert.equal(effectiveMaxTokens(50, "longcat-2.5-preview-free", {}), 5120);
    assert.equal(effectiveMaxTokens(100, "cat-jam-free", {}), 5120);

    // Above answer floor (2048 -> 2048 + 4096 = 6144)
    assert.equal(
      effectiveMaxTokens(2048, "mimo-v2.6-flash-free", {}),
      2048 + THINKING_BUDGET
    );
  });

  it("applies plain floor max(requested, 512) for non-reasoning models unless reasoning_effort is set", () => {
    assert.equal(effectiveMaxTokens(50, "space-bunny-free", {}), MIN_PLAIN_TOKENS);
    assert.equal(effectiveMaxTokens(1500, "space-bunny-free", {}), 1500);
    assert.equal(
      effectiveMaxTokens(50, "space-bunny-free", { reasoning_effort: "none" }),
      MIN_PLAIN_TOKENS
    );
    assert.equal(
      effectiveMaxTokens(50, "space-bunny-free", { reasoning_effort: "high" }),
      MIN_ANSWER_TOKENS + THINKING_BUDGET
    );
    assert.equal(
      isReasoningRequest({ reasoning_effort: "medium" }, "space-bunny-free"),
      true
    );
  });

  it("handles max_tokens: 0 and numeric strings without jumping to 131072 or returning strings", () => {
    const zeroReasoning = effectiveMaxTokens(0, "muse-spark-1.3-contributor-free", {});
    assert.equal(typeof zeroReasoning, "number");
    assert.equal(zeroReasoning, MIN_ANSWER_TOKENS + THINKING_BUDGET);

    const zeroPlain = effectiveMaxTokens(0, "space-bunny-free", {});
    assert.equal(typeof zeroPlain, "number");
    assert.equal(zeroPlain, MIN_PLAIN_TOKENS);

    const strReasoning = effectiveMaxTokens("2000", "nemotron-3.5-lightning-free", {});
    assert.equal(typeof strReasoning, "number");
    assert.equal(strReasoning, 2000 + THINKING_BUDGET);

    const strPlain = effectiveMaxTokens("800", "space-bunny-free", {});
    assert.equal(typeof strPlain, "number");
    assert.equal(strPlain, 800);
  });

  it("defaults missing/invalid budgets to MAX_OUTPUT_TOKENS and clamps oversized budgets", () => {
    assert.equal(effectiveMaxTokens(undefined, "space-bunny-free", {}), MAX_OUTPUT_TOKENS);
    assert.equal(effectiveMaxTokens(null, "muse-spark-1.3-contributor-free", {}), MAX_OUTPUT_TOKENS);
    assert.equal(effectiveMaxTokens("", "space-bunny-free", {}), MAX_OUTPUT_TOKENS);
    assert.equal(effectiveMaxTokens(-10, "space-bunny-free", {}), MAX_OUTPUT_TOKENS);
    assert.equal(effectiveMaxTokens("not-a-number", "space-bunny-free", {}), MAX_OUTPUT_TOKENS);
    assert.equal(effectiveMaxTokens(999999, "muse-spark-1.3-contributor-free", {}), MAX_OUTPUT_TOKENS);
  });
});
