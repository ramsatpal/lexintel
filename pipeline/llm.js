// Real LLM client. Tests inject a mock instead.
module.exports = function makeLLM() {
  const Anthropic = require("@anthropic-ai/sdk");
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
  const client = new Anthropic();
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
  return async (system, user) => {
    const r = await client.messages.create({ model, max_tokens: 4000, system, messages: [{ role: "user", content: user }] });
    return r.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  };
};
