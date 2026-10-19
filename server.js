const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "savings.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY_BYTES = 16 * 1024;
const RESET_TIME_ZONE = "Europe/Vienna";
const MONTH_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: RESET_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
});
const CATEGORY_NAMES = [
  "Rent",
  "Groceries",
  "Restaurant",
  "Hobbies",
  "School",
  "Transport",
  "Bills",
  "Other",
];

let state = {
  settings: { savingsTargetCents: 0, targetDate: "", monthlyBudgetCents: 0 },
  transactions: [],
  todos: [],
  monthKey: "",
};
let mutationQueue = Promise.resolve();
const clients = new Set();

async function loadState() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const saved = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
    if (
      saved &&
      saved.settings &&
      Array.isArray(saved.transactions) &&
      Array.isArray(saved.todos)
    ) {
      state = {
        ...saved,
        monthKey:
          typeof saved.monthKey === "string" && /^\d{4}-\d{2}$/.test(saved.monthKey)
            ? saved.monthKey
            : currentMonthKey(),
      };
      if (!saved.monthKey) await persist(state);
    } else {
      throw new Error("Saved savings data has an invalid format.");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await persist(state);
  }
}

async function persist(nextState) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tempFile = `${DATA_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tempFile, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  await fs.rename(tempFile, DATA_FILE);
}

function currentMonthKey(date = new Date()) {
  const parts = Object.fromEntries(
    MONTH_FORMATTER.formatToParts(date).map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}`;
}

function transactionMonthKey(createdAt) {
  return currentMonthKey(new Date(createdAt));
}

function serializeState() {
  const month = currentMonthKey();
  const balanceCents = state.transactions.reduce(
    (sum, transaction) =>
      sum + (transaction.kind === "deposit" ? transaction.amountCents : -transaction.amountCents),
    0,
  );
  const spentThisMonthCents = state.transactions
    .filter(
      (transaction) =>
        transaction.kind === "expense" && transactionMonthKey(transaction.createdAt) === month,
    )
    .reduce((sum, transaction) => sum + transaction.amountCents, 0);
  return {
    ...state,
    summary: { balanceCents, spentThisMonthCents },
  };
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large.");
      error.status = 413;
      throw error;
    }
  }
  try {
    return JSON.parse(body);
  } catch {
    const error = new Error("Please send valid JSON.");
    error.status = 400;
    throw error;
  }
}

function validAmount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000_00;
}

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function broadcast() {
  const message = `event: state\ndata: ${JSON.stringify(serializeState())}\n\n`;
  for (const client of clients) {
    if (!client.write(message)) clients.delete(client);
  }
}

function updateState(change) {
  const operation = mutationQueue.then(async () => {
    const next = structuredClone(state);
    change(next);
    await persist(next);
    state = next;
    broadcast();
    return serializeState();
  });
  mutationQueue = operation.catch(() => {});
  return operation;
}

async function applyMonthlyRollover() {
  const month = currentMonthKey();
  if (state.monthKey === month) return;
  await updateState((next) => {
    if (next.monthKey !== month) {
      next.monthKey = month;
      next.todos = [];
    }
  });
}

function isValidDate(value) {
  if (value === "") return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

async function handleApi(request, response, pathname) {
  if (request.method === "GET" && pathname === "/api/state") {
    return sendJson(response, 200, serializeState());
  }

  if (request.method === "GET" && pathname === "/api/events") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.write(`event: state\ndata: ${JSON.stringify(serializeState())}\n\n`);
    clients.add(response);
    const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 25_000);
    request.on("close", () => {
      clearInterval(heartbeat);
      clients.delete(response);
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/transactions") {
    const body = await readJson(request);
    const kind = body.kind;
    const amountCents = body.amountCents;
    const category = cleanText(body.category, 40);
    const note = cleanText(body.note, 120);
    if (!["deposit", "expense"].includes(kind)) {
      return sendError(response, 400, "Choose a deposit or an expense.");
    }
    if (!validAmount(amountCents) || amountCents === 0) {
      return sendError(response, 400, "Enter an amount greater than €0.");
    }
    if (kind === "expense" && !CATEGORY_NAMES.includes(category)) {
      return sendError(response, 400, "Choose a valid expense category.");
    }
    const transaction = {
      id: randomUUID(),
      kind,
      amountCents,
      category: kind === "expense" ? category : "Deposit",
      note,
      createdAt: new Date().toISOString(),
    };
    const result = await updateState((next) => next.transactions.unshift(transaction));
    return sendJson(response, 201, result);
  }

  if (request.method === "PUT" && pathname === "/api/settings") {
    const body = await readJson(request);
    if (
      !validAmount(body.savingsTargetCents) ||
      !validAmount(body.monthlyBudgetCents) ||
      !isValidDate(body.targetDate)
    ) {
      return sendError(response, 400, "Enter valid amounts and a valid goal date.");
    }
    const settings = {
      savingsTargetCents: body.savingsTargetCents,
      targetDate: body.targetDate,
      monthlyBudgetCents: body.monthlyBudgetCents,
    };
    const result = await updateState((next) => {
      next.settings = settings;
    });
    return sendJson(response, 200, result);
  }

  if (request.method === "POST" && pathname === "/api/todos") {
    const body = await readJson(request);
    const title = cleanText(body.title, 100);
    if (!title) return sendError(response, 400, "Enter a goal before adding it.");
    const todo = { id: randomUUID(), title, done: false, createdAt: new Date().toISOString() };
    const result = await updateState((next) => next.todos.unshift(todo));
    return sendJson(response, 201, result);
  }

  const todoMatch = pathname.match(/^\/api\/todos\/([0-9a-f-]+)$/i);
  if (request.method === "PATCH" && todoMatch) {
    const body = await readJson(request);
    if (typeof body.done !== "boolean") {
      return sendError(response, 400, "Choose whether the goal is complete.");
    }
    let found = false;
    const result = await updateState((next) => {
      const todo = next.todos.find((item) => item.id === todoMatch[1]);
      if (todo) {
        todo.done = body.done;
        found = true;
      }
    });
    if (!found) return sendError(response, 404, "That goal could not be found.");
    return sendJson(response, 200, result);
  }

  return sendError(response, 404, "That API endpoint does not exist.");
}

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function serveStatic(response, pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(PUBLIC_DIR, `.${decodeURIComponent(requestedPath)}`);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    return sendError(response, 403, "Access denied.");
  }
  try {
    const contents = await fs.readFile(filePath);
    response.writeHead(200, {
      "Content-Type": CONTENT_TYPES[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(contents);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") {
      return sendError(response, 404, "Page not found.");
    }
    throw error;
  }
}

const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, `http://${request.headers.host || "localhost"}`).pathname;
    if (pathname.startsWith("/api/")) {
      await applyMonthlyRollover();
      return await handleApi(request, response, pathname);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return sendError(response, 405, "This method is not allowed.");
    }
    return await serveStatic(response, pathname);
  } catch (error) {
    if (response.headersSent) {
      response.end();
      return;
    }
    sendError(response, error.status || 500, error.status ? error.message : "Something went wrong.");
    if (!error.status) console.error(error);
  }
});

loadState()
  .then(async () => {
    await applyMonthlyRollover();
    server.listen(PORT, HOST, () => {
      console.log(`Savings app running at http://localhost:${PORT}`);
    });
    const rolloverTimer = setInterval(() => {
      applyMonthlyRollover().catch((error) => {
        console.error("Could not reset the monthly checklist:", error);
      });
    }, 60_000);
    rolloverTimer.unref();
    server.on("close", () => clearInterval(rolloverTimer));
  })
  .catch((error) => {
    console.error("Could not load savings data:", error);
    process.exitCode = 1;
  });

process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
