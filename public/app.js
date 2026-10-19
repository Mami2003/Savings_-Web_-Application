const formatMoney = (cents) =>
  new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency: "EUR",
  }).format(cents / 100);

const byId = (id) => document.getElementById(id);
const transactionModal = byId("transaction-modal");
const planModal = byId("plan-modal");
const transactionForm = byId("transaction-form");
const planForm = byId("plan-form");
const activityList = byId("activity-list");
const todoList = byId("todo-list");
let currentState = null;
let toastTimer;

function setSyncStatus(connected) {
  byId("sync-status").textContent = connected ? "Connected together" : "Reconnecting…";
}

function percent(part, whole) {
  if (!whole) return 0;
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)));
}

function formatDate(value) {
  const date = new Date(value);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay) return `Today, ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function showToast(message) {
  const toast = byId("toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2600);
}

function renderActivity(transactions) {
  activityList.replaceChildren();
  byId("activity-count").textContent = `${transactions.length} ${transactions.length === 1 ? "entry" : "entries"}`;
  byId("activity-empty").classList.toggle("hidden", transactions.length > 0);
  activityList.classList.toggle("hidden", transactions.length === 0);

  for (const transaction of transactions.slice(0, 8)) {
    const isDeposit = transaction.kind === "deposit";
    const row = document.createElement("div");
    row.className = "transaction-row";

    const icon = document.createElement("span");
    icon.className = `transaction-mark ${isDeposit ? "deposit" : "expense"}`;
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = isDeposit ? "↙" : "↗";

    const main = document.createElement("div");
    main.className = "transaction-main";
    const title = document.createElement("strong");
    title.textContent = transaction.note || transaction.category;
    const subtitle = document.createElement("span");
    subtitle.textContent = `${transaction.category} · ${formatDate(transaction.createdAt)}`;
    main.append(title, subtitle);

    const amount = document.createElement("span");
    amount.className = `transaction-amount ${isDeposit ? "deposit" : "expense"}`;
    amount.textContent = `${isDeposit ? "+" : "−"}${formatMoney(transaction.amountCents)}`;
    row.append(icon, main, amount);
    activityList.append(row);
  }
}

function renderTodos(todos) {
  todoList.replaceChildren();
  const completed = todos.filter((todo) => todo.done).length;
  byId("todo-count").textContent = `${completed}/${todos.length} done`;
  for (const todo of todos) {
    const item = document.createElement("li");
    item.className = `todo-item${todo.done ? " done" : ""}`;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = todo.done;
    checkbox.id = `todo-${todo.id}`;
    checkbox.dataset.todoId = todo.id;
    checkbox.setAttribute("aria-label", `Mark ${todo.title} ${todo.done ? "not done" : "done"}`);
    const label = document.createElement("label");
    label.htmlFor = checkbox.id;
    label.textContent = todo.title;
    item.append(checkbox, label);
    todoList.append(item);
  }
}

function render(state) {
  currentState = state;
  const { settings, summary, transactions, todos } = state;
  const target = settings.savingsTargetCents;
  const savingsProgress = percent(Math.max(0, summary.balanceCents), target);
  const spendingProgress = percent(summary.spentThisMonthCents, settings.monthlyBudgetCents);

  byId("balance-amount").textContent = formatMoney(summary.balanceCents);
  byId("balance-caption").textContent = transactions.length
    ? `${transactions.length} little ${transactions.length === 1 ? "step" : "steps"} so far`
    : "Your story starts here";

  byId("goal-amount").textContent = target ? formatMoney(target) : "Set your goal";
  byId("goal-date").textContent = settings.targetDate
    ? `A little dream for ${new Date(`${settings.targetDate}T00:00:00`).toLocaleDateString([], { month: "long", year: "numeric" })}.`
    : "A little dream, with a date.";
  byId("goal-progress").style.width = `${savingsProgress}%`;
  byId("goal-progress-label").textContent = target
    ? `${formatMoney(Math.max(0, summary.balanceCents))} saved`
    : "Your goal begins here";
  byId("goal-progress-percent").textContent = target ? `${savingsProgress}%` : "—";
  byId("featured-goal-title").textContent = target ? "Our end goal" : "Our end goal";
  byId("featured-goal-caption").textContent = settings.targetDate
    ? `A little dream for ${new Date(`${settings.targetDate}T00:00:00`).toLocaleDateString([], { month: "short", year: "numeric" })}.`
    : "Every little bit brings it closer.";
  byId("featured-progress").style.width = `${savingsProgress}%`;
  byId("featured-saved").textContent = `${formatMoney(Math.max(0, summary.balanceCents))} saved`;
  byId("featured-target").textContent = target ? `of ${formatMoney(target)}` : "Set a target";

  byId("spent-amount").textContent = formatMoney(summary.spentThisMonthCents);
  byId("budget-description").textContent = settings.monthlyBudgetCents
    ? `of ${formatMoney(settings.monthlyBudgetCents)} planned this month`
    : "Spent this month";
  byId("budget-progress").style.width = `${spendingProgress}%`;
  byId("budget-progress-label").textContent = settings.monthlyBudgetCents
    ? `${spendingProgress}% of monthly plan`
    : "Set a monthly plan";

  renderActivity(transactions);
  renderTodos(todos);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Something went wrong.");
  return result;
}

async function loadInitialState() {
  try {
    render(await api("/api/state"));
    setSyncStatus(true);
  } catch (error) {
    setSyncStatus(false);
    showToast(error.message);
  }
}

function connectLiveUpdates() {
  const events = new EventSource("/api/events");
  events.addEventListener("state", (event) => {
    render(JSON.parse(event.data));
    setSyncStatus(true);
  });
  events.onopen = () => setSyncStatus(true);
  events.onerror = () => setSyncStatus(false);
}

function openTransactionModal() {
  byId("transaction-error").textContent = "";
  transactionForm.reset();
  setTransactionKind("deposit");
  transactionModal.showModal();
  byId("transaction-amount").focus();
}

function setTransactionKind(kind) {
  byId("transaction-kind").value = kind;
  document.querySelectorAll(".segment").forEach((button) => {
    button.classList.toggle("active", button.dataset.kind === kind);
  });
  byId("expense-fields").classList.toggle("hidden", kind !== "expense");
  byId("transaction-note-label").textContent = kind === "expense" ? "A little more detail" : "What was it for?";
  byId("transaction-note").placeholder = kind === "expense" ? "e.g. Weekly shop (optional)" : "e.g. Monthly savings (optional)";
}

function openPlanModal() {
  byId("plan-error").textContent = "";
  const settings = currentState?.settings || {
    savingsTargetCents: 0,
    targetDate: "",
    monthlyBudgetCents: 0,
  };
  byId("savings-target").value = settings.savingsTargetCents ? (settings.savingsTargetCents / 100).toFixed(2) : "";
  byId("goal-date-input").value = settings.targetDate;
  byId("monthly-budget").value = settings.monthlyBudgetCents ? (settings.monthlyBudgetCents / 100).toFixed(2) : "";
  planModal.showModal();
}

function toCents(value) {
  return Math.round(Number(value || 0) * 100);
}

document.querySelectorAll("#add-transaction-button, #empty-add-button").forEach((button) =>
  button.addEventListener("click", openTransactionModal),
);
document.querySelectorAll("#edit-plan-button, #edit-budget-button").forEach((button) =>
  button.addEventListener("click", openPlanModal),
);
document.querySelectorAll(".segment").forEach((button) =>
  button.addEventListener("click", () => setTransactionKind(button.dataset.kind)),
);
document.querySelectorAll("[data-close]").forEach((button) =>
  button.addEventListener("click", () => button.closest("dialog").close()),
);
document.querySelectorAll("dialog").forEach((dialog) => {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
});

transactionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const errorElement = byId("transaction-error");
  errorElement.textContent = "";
  const kind = byId("transaction-kind").value;
  const amountCents = toCents(byId("transaction-amount").value);
  if (!amountCents || amountCents > 10_000_000_000) {
    errorElement.textContent = "Enter an amount greater than €0.";
    return;
  }
  try {
    await api("/api/transactions", {
      method: "POST",
      body: JSON.stringify({
        kind,
        amountCents,
        category: kind === "expense" ? byId("transaction-category").value : "Deposit",
        note: byId("transaction-note").value,
      }),
    });
    transactionModal.close();
    showToast(kind === "deposit" ? "A little more in the reservoir." : "Expense added to your story.");
  } catch (error) {
    errorElement.textContent = error.message;
  }
});

planForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const errorElement = byId("plan-error");
  errorElement.textContent = "";
  const savingsTargetCents = toCents(byId("savings-target").value);
  const monthlyBudgetCents = toCents(byId("monthly-budget").value);
  if (savingsTargetCents > 10_000_000_000 || monthlyBudgetCents > 10_000_000_000) {
    errorElement.textContent = "Please enter an amount below €100,000,000.";
    return;
  }
  try {
    await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        savingsTargetCents,
        targetDate: byId("goal-date-input").value,
        monthlyBudgetCents,
      }),
    });
    planModal.close();
    showToast("Your plan has been saved.");
  } catch (error) {
    errorElement.textContent = error.message;
  }
});

byId("todo-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = byId("todo-input");
  const title = input.value.trim();
  if (!title) {
    input.focus();
    return;
  }
  try {
    await api("/api/todos", { method: "POST", body: JSON.stringify({ title }) });
    input.value = "";
    showToast("A new little goal, just for you two.");
  } catch (error) {
    showToast(error.message);
  }
});

todoList.addEventListener("change", async (event) => {
  const checkbox = event.target.closest("[data-todo-id]");
  if (!checkbox) return;
  try {
    await api(`/api/todos/${encodeURIComponent(checkbox.dataset.todoId)}`, {
      method: "PATCH",
      body: JSON.stringify({ done: checkbox.checked }),
    });
  } catch (error) {
    checkbox.checked = !checkbox.checked;
    showToast(error.message);
  }
});

async function shareSpace() {
  const shareData = { title: "Our savings space", url: window.location.href };
  try {
    if (navigator.share) {
      await navigator.share(shareData);
    } else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(window.location.href);
      showToast("Link copied. Anyone with it can view and update your finances.");
    } else {
      window.prompt("Copy this link to share your savings space:", window.location.href);
    }
  } catch (error) {
    if (error.name !== "AbortError") showToast("Couldn't share the link. Please try again.");
  }
}

byId("share-button").addEventListener("click", shareSpace);
byId("mobile-share-button").addEventListener("click", shareSpace);

byId("today-label").textContent = new Intl.DateTimeFormat([], {
  weekday: "long",
  month: "long",
  day: "numeric",
}).format(new Date()).toUpperCase();

loadInitialState();
connectLiveUpdates();
