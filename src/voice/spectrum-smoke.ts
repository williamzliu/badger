import { SpectrumMessagingClient } from "./spectrum.js";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required in .env`);
  return value;
}

const to = process.argv.slice(2).find((argument) => argument !== "--");
if (!to) {
  throw new Error("Usage: npm run spectrum:smoke -- +14155550100");
}

const client = new SpectrumMessagingClient({
  projectId: requiredEnv("SPECTRUM_PROJECT_ID"),
  projectSecret: requiredEnv("SPECTRUM_PROJECT_SECRET"),
});

try {
  const sent = await client.send({
    to,
    body: "Badger Spectrum test. Reply YES if you received this.",
    sessionId: "spectrum_smoke_test",
    participantId: "spectrum_smoke_test",
    idempotencyKey: `spectrum-smoke:${Date.now()}`,
  });
  console.log(JSON.stringify(sent, null, 2));
} finally {
  await client.stop();
}
