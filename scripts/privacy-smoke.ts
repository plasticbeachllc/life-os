const child = Bun.spawn(["uv", "run", "python", "python/redact_sensitive.py"], {
  cwd: process.cwd(),
  stdin: "pipe",
  stdout: "pipe",
  stderr: "inherit",
});

child.stdin.write(JSON.stringify({ texts: ["Card: 4111 1111 1111 1111"] }));
child.stdin.end();

const output = await new Response(child.stdout).text();
const exitCode = await child.exited;
if (exitCode !== 0) throw new Error(`privacy harness exited with ${exitCode}`);

const result = JSON.parse(output) as {
  results?: Array<{ text?: string; findings?: Array<{ entityType?: string }> }>;
};
const first = result.results?.[0];
if (!first?.text?.includes("<CREDIT_CARD>")
  || !first.findings?.some((finding) => finding.entityType === "CREDIT_CARD")) {
  throw new Error("privacy harness did not redact the credit-card fixture");
}

console.log("privacy smoke passed");
