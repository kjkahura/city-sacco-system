const { Anthropic } = require("@anthropic-ai/sdk");

async function main() {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    console.error("Error: CLAUDE_API_KEY is not set. Set it in your environment before running the build.");
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });

  const prompt = `You are a build assistant for the City SACCO System Node.js project. Provide a short summary of this project and recommend the next step for build or deployment.`;

  const response = await client.responses.create({
    model: "claude-3.5",
    input: prompt,
    max_tokens: 250,
  });

  const outputText = response.output_text || response.output?.[0]?.content?.[0]?.text || JSON.stringify(response, null, 2);
  console.log("=== Claude Build Output ===");
  console.log(outputText.trim());
}

main().catch((error) => {
  console.error("Claude build failed:", error);
  process.exit(1);
});
