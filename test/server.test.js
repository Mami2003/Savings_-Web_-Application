const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

let child;
let dataDir;
let baseUrl;

function viennaMonthKey(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Vienna",
      year: "numeric",
      month: "2-digit",
    }).formatToParts(date).map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}`;
}

async function unusedPort() {
  const server = http.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startServer() {
  const port = await unusedPort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_DIR: dataDir },
    stdio: "ignore",
  });

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/state`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("Server did not start in time.");
}

async function stopServer() {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  await exited;
}

async function readEvent(reader, pending) {
  const decoder = new TextDecoder();
  while (!pending.value.includes("\n\n")) {
    const { done, value } = await reader.read();
    assert.equal(done, false, "event stream should remain open");
    pending.value += decoder.decode(value, { stream: true });
  }
  const separator = pending.value.indexOf("\n\n");
  const frame = pending.value.slice(0, separator);
  pending.value = pending.value.slice(separator + 2);
  return JSON.parse(frame.split("\n").find((line) => line.startsWith("data: ")).slice(6));
}

test("shared savings API validates, broadcasts, and persists changes", async (t) => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ours-savings-test-"));
  t.after(async () => {
    await stopServer();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await startServer();

  const initialResponse = await fetch(`${baseUrl}/api/state`);
  const initial = await initialResponse.json();
  assert.equal(initial.summary.balanceCents, 0);
  assert.deepEqual(initial.transactions, []);

  const eventResponse = await fetch(`${baseUrl}/api/events`);
  assert.equal(eventResponse.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const reader = eventResponse.body.getReader();
  const pending = { value: "" };
  const streamedInitial = await readEvent(reader, pending);
  assert.equal(streamedInitial.summary.balanceCents, 0);

  const invalidExpense = await fetch(`${baseUrl}/api/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "expense", amountCents: 2000, category: "Invalid" }),
  });
  assert.equal(invalidExpense.status, 400);

  const deposit = await fetch(`${baseUrl}/api/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "deposit", amountCents: 50000, note: "Payday" }),
  });
  assert.equal(deposit.status, 201);

  const expense = await fetch(`${baseUrl}/api/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "expense",
      amountCents: 12500,
      category: "Groceries",
      note: "Weekly shop",
    }),
  });
  assert.equal(expense.status, 201);

  const settings = await fetch(`${baseUrl}/api/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      savingsTargetCents: 100000,
      targetDate: "2027-06-30",
      monthlyBudgetCents: 45000,
    }),
  });
  assert.equal(settings.status, 200);

  const todoResponse = await fetch(`${baseUrl}/api/todos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Plan our trip" }),
  });
  assert.equal(todoResponse.status, 201);
  let streamedUpdate;
  do {
    streamedUpdate = await readEvent(reader, pending);
  } while (!streamedUpdate.todos.length);
  assert.equal(streamedUpdate.todos[0].title, "Plan our trip");
  await reader.cancel();

  const todoId = (await todoResponse.json()).todos[0].id;
  const todoUpdate = await fetch(`${baseUrl}/api/todos/${todoId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ done: true }),
  });
  assert.equal(todoUpdate.status, 200);

  const finalResponse = await fetch(`${baseUrl}/api/state`);
  const finalState = await finalResponse.json();
  assert.equal(finalState.summary.balanceCents, 37500);
  assert.equal(finalState.summary.spentThisMonthCents, 12500);
  assert.equal(finalState.settings.savingsTargetCents, 100000);
  assert.equal(finalState.todos[0].done, true);
  assert.equal(finalState.transactions.length, 2);

  await stopServer();
  await startServer();
  const persisted = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.equal(persisted.summary.balanceCents, 37500);
  assert.equal(persisted.todos[0].title, "Plan our trip");

  await stopServer();
  const savedFile = path.join(dataDir, "savings.json");
  const savedState = JSON.parse(await fs.readFile(savedFile, "utf8"));
  savedState.monthKey = "2000-01";
  savedState.transactions.find((transaction) => transaction.kind === "expense").createdAt =
    "2000-01-15T12:00:00.000Z";
  savedState.todos = [{ id: "old-goal", title: "Old monthly goal", done: false }];
  await fs.writeFile(savedFile, JSON.stringify(savedState), "utf8");

  await startServer();
  const rolledOver = await (await fetch(`${baseUrl}/api/state`)).json();
  assert.deepEqual(rolledOver.todos, []);
  assert.equal(rolledOver.summary.balanceCents, 37500);
  assert.equal(rolledOver.summary.spentThisMonthCents, 0);
  assert.equal(rolledOver.transactions.length, 2);
  assert.equal(rolledOver.monthKey, viennaMonthKey());
});
