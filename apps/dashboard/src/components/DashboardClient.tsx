"use client";

import { Component, FormEvent, useMemo, useState, type ReactNode } from "react";
import { SignInButton, SignOutButton, UserButton } from "@clerk/nextjs";
import {
  AlertTriangle,
  CalendarClock,
  Check,
  ClipboardCheck,
  Home,
  ListChecks,
  Minus,
  PackageCheck,
  Plus,
  ReceiptText,
  RotateCcw,
  Settings,
  ShieldCheck,
  ShoppingCart,
} from "lucide-react";
import {
  Authenticated,
  AuthLoading,
  Unauthenticated,
  useMutation,
  useQuery,
} from "convex/react";
import { api } from "@household/backend/convex/_generated/api";
import type { Id } from "@household/backend/convex/_generated/dataModel";

type StockRow = {
  item: {
    _id: Id<"items">;
    name: string;
    category: string;
    unit: string;
    reorder_point: number;
    reorder_to: number;
    preferred_store_id?: Id<"stores">;
  };
  currentStock: number;
};

type Store = {
  _id: Id<"stores">;
  name: string;
  platform: string;
};

type Cart = {
  _id: Id<"carts">;
  store_id: Id<"stores">;
  status: string;
  lines: Array<{
    item_id: Id<"items">;
    store_item_id?: Id<"store_items">;
    qty: number;
    expected_unit_price?: number;
    note?: string;
  }>;
};

type Job = {
  _id: Id<"purchase_jobs">;
  store_id: Id<"stores">;
  status: string;
  executor: string;
  order_summary_total?: number;
  error?: string;
  order_summary_screenshot_url?: string | null;
  summary_line_items?: Array<{
    name: string;
    qty: number;
    unit_price?: number;
    line_total?: number;
    status: "expected" | "substituted" | "unavailable" | "extra";
  }>;
  summary_shipping_total?: number;
  summary_delivery_window?: string;
  summary_diff?: {
    withinPolicy: boolean;
    issues: Array<{
      type:
        | "missing"
        | "substituted"
        | "unavailable"
        | "extra"
        | "qty_mismatch"
        | "price_drift";
      name: string;
      expected_qty?: number;
      actual_qty?: number;
      expected_unit_price?: number;
      unit_price?: number;
    }>;
  };
  confirm_deadline?: number;
};

type LedgerEntry = {
  _id: Id<"ledger">;
  status: "placed" | "received" | "adjusted";
  total: number;
  currency: "ARS";
  order_ref?: string;
  receipt_ref?: string;
  line_items: Array<{ name: string; qty: number; price: number }>;
  placed_at: number;
  received_at?: number;
  store: { _id: Id<"stores">; name: string; platform: string } | null;
  job: {
    _id: Id<"purchase_jobs">;
    status: string;
    cart_id: Id<"carts">;
  } | null;
};

type AuditEvent = {
  type: "stock" | "cart" | "job";
  _id: string;
  created_at: number;
  actor: string;
  title: string;
  detail: string;
  note?: string;
};

type ExecutorConfig = {
  _id: Id<"executor_config">;
  default_executor: "stagehand" | "harness";
  explorer_executor: "stagehand" | "harness";
  harness_cli?: "claude-code" | "codex";
  stagehand_model?: string;
  vps_region: string;
  default_proxy_policy: "none" | "if_challenged";
  confirm_timeout_minutes: number;
};

type AiConfig = {
  _id: Id<"ai_config">;
  tier: "parser" | "executor" | "explorer";
  provider: string;
  model: string;
};

const platforms = ["tiendanube", "mercadolibre", "coto", "vtex"] as const;
const executors = ["stagehand", "harness"] as const;
const aiTiers = ["parser", "executor", "explorer"] as const;
const receiptRows = [0, 1, 2] as const;

function asList<T>(value: T[] | undefined): T[] {
  return value ?? [];
}

function formatMoney(value: number, currency = "ARS") {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDate(value?: number) {
  if (!value) return "Not set";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

// All Convex hooks live here; this component must only mount once Convex
// auth is established (the queries call requireUser server-side).
function DashboardApp() {
  const clerkEnabled = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
  const stock = asList(
    useQuery(api.stock.current, {}) as StockRow[] | undefined,
  );
  const stores = asList(
    useQuery(api.stores.list, { includeInactive: false }) as
      Store[] | undefined,
  );
  const carts = asList(useQuery(api.carts.list, {}) as Cart[] | undefined);
  const jobs = asList(useQuery(api.jobs.list, {}) as Job[] | undefined);
  const ledger = asList(
    useQuery(api.ledger.list, { limit: 8 }) as LedgerEntry[] | undefined,
  );
  const audit = asList(
    useQuery(api.audit.recent, { limit: 14 }) as AuditEvent[] | undefined,
  );
  const executorConfig = useQuery(api.config.getExecutorConfig, {}) as
    ExecutorConfig | null | undefined;
  const aiConfig = asList(
    useQuery(api.config.listAiConfig, {}) as AiConfig[] | undefined,
  );

  const logEvent = useMutation(api.stock.logEvent);
  const reconcile = useMutation(api.stock.reconcile);
  const upsertStore = useMutation(api.stores.upsert);
  const upsertItem = useMutation(api.items.upsert);
  const createCart = useMutation(api.carts.createProposed);
  const updateCartLines = useMutation(api.carts.updateLines);
  const approveCart = useMutation(api.carts.approve);
  const cancelCart = useMutation(api.carts.cancel);
  const queueCart = useMutation(api.carts.queueApproved);
  const confirmJob = useMutation(api.jobs.confirm);
  const resumeJob = useMutation(api.jobs.resume);
  const markLedgerReceived = useMutation(api.ledger.markReceived);
  const setExecutorConfig = useMutation(api.config.setExecutorConfig);
  const setAiConfig = useMutation(api.config.setAiConfig);

  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const itemOptions = useMemo(() => stock.map((row) => row.item), [stock]);
  const storeById = useMemo(
    () => new Map(stores.map((store) => [store._id, store])),
    [stores],
  );
  const itemById = useMemo(
    () => new Map(itemOptions.map((item) => [item._id, item])),
    [itemOptions],
  );
  const aiConfigByTier = useMemo(
    () => new Map(aiConfig.map((config) => [config.tier, config])),
    [aiConfig],
  );

  async function run(label: string, action: () => Promise<unknown>) {
    setPending(label);
    setMessage(null);
    try {
      await action();
      setMessage(`${label} complete`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(null);
    }
  }

  async function handleAddStore(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const domain = String(form.get("domain") ?? "").trim();
    const platform = String(
      form.get("platform") ?? "tiendanube",
    ) as (typeof platforms)[number];
    if (!name || !domain) return;
    await run("Store saved", async () => {
      await upsertStore({
        name,
        domain,
        platform,
        login_ref: name.toLowerCase().replace(/\s+/g, "-"),
        proxy_policy: platform === "tiendanube" ? "none" : "if_challenged",
        shipping_preference: "default",
        active: true,
      });
      event.currentTarget.reset();
    });
  }

  async function handleAddItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const unit = String(form.get("unit") ?? "").trim() || "unit";
    const category = String(form.get("category") ?? "").trim() || "general";
    const storeId = String(form.get("store") ?? "");
    const reorderPoint = Number(form.get("reorderPoint") ?? 1);
    const reorderTo = Number(form.get("reorderTo") ?? 2);
    if (!name) return;
    await run("Item saved", async () => {
      const payload = {
        name,
        aliases: name.toLowerCase().split(/\s+/).filter(Boolean),
        category,
        unit,
        reorder_point: reorderPoint,
        reorder_to: reorderTo,
        substitute_item_ids: [],
        active: true,
      };
      await upsertItem(
        storeId
          ? { ...payload, preferred_store_id: storeId as Id<"stores"> }
          : payload,
      );
      event.currentTarget.reset();
    });
  }

  async function handleCreateCart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const storeId = String(form.get("store") ?? "");
    const itemId = String(form.get("item") ?? "");
    const qty = Number(form.get("qty") ?? 1);
    if (!storeId || !itemId || qty <= 0) return;
    await run("Cart created", async () => {
      await createCart({
        store_id: storeId as Id<"stores">,
        lines: [{ item_id: itemId as Id<"items">, qty }],
        note: "Created from dashboard",
      });
      event.currentTarget.reset();
    });
  }

  async function handleUpdateCart(
    event: FormEvent<HTMLFormElement>,
    cart: Cart,
  ) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const lines = cart.lines
      .map((line, index) => {
        const itemId = String(form.get(`line-${index}-item`) ?? "");
        const qty = Number(form.get(`line-${index}-qty`) ?? 0);
        if (!itemId || qty <= 0) return null;
        return {
          item_id: itemId as Id<"items">,
          ...(line.store_item_id ? { store_item_id: line.store_item_id } : {}),
          qty,
          ...(line.expected_unit_price
            ? { expected_unit_price: line.expected_unit_price }
            : {}),
          ...(line.note ? { note: line.note } : {}),
        };
      })
      .filter((line): line is NonNullable<typeof line> => Boolean(line));

    const addItemId = String(form.get("addItem") ?? "");
    const addQty = Number(form.get("addQty") ?? 0);
    if (addItemId && addQty > 0) {
      lines.push({ item_id: addItemId as Id<"items">, qty: addQty });
    }
    if (lines.length === 0) {
      setMessage("A cart needs at least one line");
      return;
    }

    await run("Cart lines saved", async () => {
      await updateCartLines({ id: cart._id, lines });
    });
  }

  async function handleReceiveLedger(
    event: FormEvent<HTMLFormElement>,
    entry: LedgerEntry,
  ) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const received_items = receiptRows
      .map((index) => {
        const itemId = String(form.get(`receiveItem-${index}`) ?? "");
        const qty = Number(form.get(`receiveQty-${index}`) ?? 0);
        if (!itemId || qty <= 0) return null;
        return {
          item_id: itemId as Id<"items">,
          qty,
          note: `Received for ${entry.store?.name ?? "ledger entry"}`,
        };
      })
      .filter((line): line is NonNullable<typeof line> => Boolean(line));
    if (received_items.length === 0) {
      setMessage("Choose at least one received item and quantity");
      return;
    }

    const receiptRef = String(form.get("receiptRef") ?? "").trim();
    await run("Ledger received", async () => {
      await markLedgerReceived({
        id: entry._id,
        received_items,
        ...(receiptRef ? { receipt_ref: receiptRef } : {}),
      });
      event.currentTarget.reset();
    });
  }

  async function handleExecutorConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const id = String(form.get("id") ?? "").trim();
    const harnessCli = String(form.get("harnessCli") ?? "").trim();
    const stagehandModel = String(form.get("stagehandModel") ?? "").trim();
    const payload = {
      default_executor: String(
        form.get("defaultExecutor") ?? "stagehand",
      ) as (typeof executors)[number],
      explorer_executor: String(
        form.get("explorerExecutor") ?? "stagehand",
      ) as (typeof executors)[number],
      vps_region:
        String(form.get("vpsRegion") ?? "").trim() || "ar-buenos-aires",
      default_proxy_policy: String(
        form.get("proxyPolicy") ?? "if_challenged",
      ) as "none" | "if_challenged",
      confirm_timeout_minutes: Number(form.get("confirmTimeout") ?? 30),
      ...(harnessCli
        ? { harness_cli: harnessCli as "claude-code" | "codex" }
        : {}),
      ...(stagehandModel ? { stagehand_model: stagehandModel } : {}),
    };
    await run("Executor config saved", async () => {
      await setExecutorConfig(
        id ? { ...payload, id: id as Id<"executor_config"> } : payload,
      );
    });
  }

  async function handleAiConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const tier = String(form.get("tier") ?? "parser") as
      "parser" | "executor" | "explorer";
    const provider = String(form.get("provider") ?? "").trim();
    const model = String(form.get("model") ?? "").trim();
    if (!provider || !model) return;
    await run("AI config saved", async () => {
      await setAiConfig({ tier, provider, model });
    });
  }

  async function handleReconciliationSweep(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const corrections: Array<{
      item_id: Id<"items">;
      actual_count: number;
    }> = [];

    stock.forEach((row) => {
      const inputValue = String(form.get(`sweep-${row.item._id}`) ?? "").trim();
      if (!inputValue) return;
      const value = Number(inputValue);
      if (!isNaN(value) && value >= 0 && value !== row.currentStock) {
        corrections.push({ item_id: row.item._id, actual_count: value });
      }
    });

    if (corrections.length === 0) {
      setMessage("No corrections needed");
      return;
    }

    await run("Sweep applied", async () => {
      for (const correction of corrections) {
        await reconcile({
          item_id: correction.item_id,
          actual_count: correction.actual_count,
          note: "Reconciliation sweep",
        });
      }
    });
  }

  const app = (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <Home size={22} />
          <span>Household</span>
        </div>
        <nav className="nav" aria-label="Primary">
          <button type="button">
            <PackageCheck size={18} />
            Stock
          </button>
          <button type="button">
            <ShoppingCart size={18} />
            Carts
          </button>
          <button type="button">
            <ShieldCheck size={18} />
            Jobs
          </button>
          <button type="button">
            <ReceiptText size={18} />
            Ledger
          </button>
          <button type="button">
            <Settings size={18} />
            Config
          </button>
        </nav>
      </aside>

      <main className="main">
        <header className="page-head">
          <div>
            <h1>Operations</h1>
            <div className="row-note">
              Live Phase 1 dashboard backed by local Convex.
            </div>
          </div>
          <div className="status-row">
            <span className="badge">
              <ShieldCheck size={14} /> VPS gate pending
            </span>
            <span className="badge">
              <AlertTriangle size={14} />{" "}
              {jobs.filter((job) => job.status.includes("paused")).length}{" "}
              paused
            </span>
            <span className="badge">
              <ClipboardCheck size={14} /> {ledger.length} ledger
            </span>
            {clerkEnabled ? <UserButton /> : null}
          </div>
        </header>

        {message ? <div className="notice">{message}</div> : null}

        <section className="grid">
          <div className="panel span-7">
            <h2>Stock</h2>
            <div className="stock-list">
              {stock.length === 0 ? (
                <div className="empty">
                  No items yet. Seed defaults or add an item.
                </div>
              ) : null}
              {stock.map((row) => (
                <div className="stock-row" key={row.item._id}>
                  <div>
                    <div className="row-title">{row.item.name}</div>
                    <div className="row-note">
                      {row.currentStock} {row.item.unit} · reorder at{" "}
                      {row.item.reorder_point}, to {row.item.reorder_to}
                    </div>
                  </div>
                  <div className="actions">
                    <button
                      className="icon-btn danger"
                      type="button"
                      aria-label={`Mark ${row.item.name} out`}
                      disabled={pending !== null}
                      onClick={() =>
                        run("Reconciled to zero", () =>
                          reconcile({
                            item_id: row.item._id,
                            actual_count: 0,
                            note: "Marked out from dashboard",
                          }),
                        )
                      }
                    >
                      <RotateCcw size={17} />
                    </button>
                    <button
                      className="icon-btn"
                      type="button"
                      aria-label={`Consume one ${row.item.name}`}
                      disabled={pending !== null}
                      onClick={() =>
                        run("Stock logged", () =>
                          logEvent({
                            item_id: row.item._id,
                            delta: -1,
                            reason: "manual",
                          }),
                        )
                      }
                    >
                      <Minus size={18} />
                    </button>
                    <button
                      className="icon-btn"
                      type="button"
                      aria-label={`Add one ${row.item.name}`}
                      disabled={pending !== null}
                      onClick={() =>
                        run("Stock logged", () =>
                          logEvent({
                            item_id: row.item._id,
                            delta: 1,
                            reason: "manual",
                          }),
                        )
                      }
                    >
                      <Plus size={18} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="panel span-5">
            <h2>Catalog</h2>
            <form className="stack-form" onSubmit={handleAddStore}>
              <div className="form-grid">
                <input
                  name="name"
                  placeholder="Store name"
                  aria-label="Store name"
                />
                <input
                  name="domain"
                  placeholder="domain.com"
                  aria-label="Store domain"
                />
                <select
                  name="platform"
                  aria-label="Store platform"
                  defaultValue="tiendanube"
                >
                  {platforms.map((platform) => (
                    <option key={platform} value={platform}>
                      {platform}
                    </option>
                  ))}
                </select>
                <button
                  className="text-btn primary"
                  type="submit"
                  disabled={pending !== null}
                >
                  Add store
                </button>
              </div>
            </form>

            <form className="stack-form" onSubmit={handleAddItem}>
              <div className="form-grid">
                <input
                  name="name"
                  placeholder="Item name"
                  aria-label="Item name"
                />
                <input name="unit" placeholder="unit" aria-label="Item unit" />
                <input
                  name="category"
                  placeholder="category"
                  aria-label="Item category"
                />
                <select
                  name="store"
                  aria-label="Preferred store"
                  defaultValue=""
                >
                  <option value="">No preferred store</option>
                  {stores.map((store) => (
                    <option key={store._id} value={store._id}>
                      {store.name}
                    </option>
                  ))}
                </select>
                <input
                  name="reorderPoint"
                  type="number"
                  min="0"
                  defaultValue="1"
                  aria-label="Reorder point"
                />
                <input
                  name="reorderTo"
                  type="number"
                  min="1"
                  defaultValue="2"
                  aria-label="Reorder to"
                />
                <button
                  className="text-btn primary"
                  type="submit"
                  disabled={pending !== null}
                >
                  Add item
                </button>
              </div>
            </form>
          </div>

          <div className="panel span-7">
            <h2>Carts</h2>
            <form className="inline-form" onSubmit={handleCreateCart}>
              <select name="store" aria-label="Cart store" defaultValue="">
                <option value="">Store</option>
                {stores.map((store) => (
                  <option key={store._id} value={store._id}>
                    {store.name}
                  </option>
                ))}
              </select>
              <select name="item" aria-label="Cart item" defaultValue="">
                <option value="">Item</option>
                {itemOptions.map((item) => (
                  <option key={item._id} value={item._id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <input
                name="qty"
                type="number"
                min="1"
                defaultValue="1"
                aria-label="Quantity"
              />
              <button
                className="text-btn primary"
                type="submit"
                disabled={pending !== null}
              >
                Create cart
              </button>
            </form>
            <div className="job-list">
              {carts.length === 0 ? (
                <div className="empty">No carts yet.</div>
              ) : null}
              {carts.map((cart) => (
                <div className="job-row tall-row" key={cart._id}>
                  <div className="cart-body">
                    <div className="row-title">
                      {storeById.get(cart.store_id)?.name ?? "Unknown store"}
                    </div>
                    <div className="row-note">
                      {cart.status} ·{" "}
                      {cart.lines
                        .map(
                          (line) =>
                            `${itemById.get(line.item_id)?.name ?? "Item"} x${line.qty}`,
                        )
                        .join(", ")}
                    </div>
                    {["proposed", "approved"].includes(cart.status) ? (
                      <form
                        className="cart-edit-form"
                        onSubmit={(event) => handleUpdateCart(event, cart)}
                      >
                        {cart.lines.map((line, index) => (
                          <div
                            className="cart-edit-line"
                            key={`${cart._id}-${index}`}
                          >
                            <select
                              name={`line-${index}-item`}
                              aria-label={`Cart line ${index + 1} item`}
                              defaultValue={line.item_id}
                            >
                              {itemOptions.map((item) => (
                                <option key={item._id} value={item._id}>
                                  {item.name}
                                </option>
                              ))}
                            </select>
                            <input
                              name={`line-${index}-qty`}
                              aria-label={`Cart line ${index + 1} quantity`}
                              type="number"
                              min="0"
                              step="1"
                              defaultValue={line.qty}
                            />
                          </div>
                        ))}
                        <div className="cart-edit-line">
                          <select
                            name="addItem"
                            aria-label="Add cart line item"
                            defaultValue=""
                          >
                            <option value="">Add item</option>
                            {itemOptions.map((item) => (
                              <option key={item._id} value={item._id}>
                                {item.name}
                              </option>
                            ))}
                          </select>
                          <input
                            name="addQty"
                            aria-label="Add cart line quantity"
                            type="number"
                            min="0"
                            step="1"
                            defaultValue="1"
                          />
                        </div>
                        <button
                          className="text-btn"
                          type="submit"
                          disabled={pending !== null}
                        >
                          Save lines
                        </button>
                      </form>
                    ) : null}
                  </div>
                  <div className="actions">
                    {["proposed", "failed", "cancelled"].includes(
                      cart.status,
                    ) ? (
                      <button
                        className="icon-btn labeled primary"
                        type="button"
                        aria-label="Approve cart"
                        disabled={pending !== null}
                        onClick={() =>
                          run("Cart approved", () =>
                            approveCart({ id: cart._id }),
                          )
                        }
                      >
                        <Check size={18} />
                        {cart.status === "proposed" ? "Approve" : "Re-approve"}
                      </button>
                    ) : null}
                    {cart.status === "approved" ? (
                      <button
                        className="icon-btn labeled primary"
                        type="button"
                        aria-label="Queue cart"
                        disabled={pending !== null}
                        onClick={() =>
                          run("Cart queued", () =>
                            queueCart({ cart_id: cart._id }),
                          )
                        }
                      >
                        <ShoppingCart size={18} />
                        Queue purchase
                      </button>
                    ) : null}
                    {["proposed", "approved"].includes(cart.status) ? (
                      <button
                        className="icon-btn danger"
                        type="button"
                        aria-label="Cancel cart"
                        disabled={pending !== null}
                        onClick={() =>
                          run("Cart cancelled", () =>
                            cancelCart({
                              id: cart._id,
                              note: "Cancelled from dashboard",
                            }),
                          )
                        }
                      >
                        <RotateCcw size={17} />
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="panel span-5">
            <h2>Purchase Jobs</h2>
            <div className="job-list">
              {jobs.length === 0 ? (
                <div className="empty">No purchase jobs yet.</div>
              ) : null}
              {jobs.map((job) => (
                <div
                  className={
                    job.status === "awaiting_confirm"
                      ? "job-row tall-row"
                      : "job-row"
                  }
                  key={job._id}
                >
                  <div>
                    <div className="row-title">
                      {storeById.get(job.store_id)?.name ?? "Unknown store"}
                    </div>
                    <div className="row-note">
                      {job.status} · {job.executor}
                      {job.order_summary_total
                        ? ` · ${formatMoney(job.order_summary_total)}`
                        : ""}
                      {job.error ? ` · ${job.error}` : ""}
                    </div>
                    {job.status === "awaiting_confirm" ? (
                      <>
                        {job.order_summary_screenshot_url ? (
                          <img
                            src={job.order_summary_screenshot_url}
                            alt="Redacted checkout summary"
                            className="summary-shot"
                          />
                        ) : null}
                        {job.summary_line_items?.length ? (
                          <div className="summary-lines">
                            {job.summary_line_items.map((line, idx) => (
                              <div key={idx}>
                                {line.name} x{line.qty}
                                {line.unit_price
                                  ? ` · ${formatMoney(line.unit_price)}`
                                  : ""}
                                {line.status !== "expected" ? (
                                  <span className="badge">{line.status}</span>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        ) : null}
                        <div className="row-note">
                          {job.summary_shipping_total
                            ? `Shipping: ${formatMoney(job.summary_shipping_total)}`
                            : ""}
                          {job.summary_shipping_total &&
                          job.summary_delivery_window
                            ? " · "
                            : ""}
                          {job.summary_delivery_window
                            ? `Delivery: ${job.summary_delivery_window}`
                            : ""}
                          {(job.summary_shipping_total ||
                            job.summary_delivery_window) &&
                          job.confirm_deadline
                            ? " · "
                            : ""}
                          {job.confirm_deadline
                            ? `Confirm by ${formatDate(job.confirm_deadline)}`
                            : ""}
                        </div>
                        {job.summary_diff && !job.summary_diff.withinPolicy ? (
                          <div className="diff-warning">
                            {job.summary_diff.issues.map((issue, idx) => (
                              <div key={idx}>
                                {issue.type === "missing"
                                  ? `missing: ${issue.name}${issue.expected_qty ? ` (expected ${issue.expected_qty})` : ""}`
                                  : issue.type === "qty_mismatch"
                                    ? `qty_mismatch: ${issue.name} (expected ${issue.expected_qty}, got ${issue.actual_qty})`
                                    : issue.type === "price_drift"
                                      ? `price_drift: ${issue.name} (expected ${
                                          issue.expected_unit_price
                                            ? formatMoney(
                                                issue.expected_unit_price,
                                              )
                                            : "—"
                                        }, got ${issue.unit_price ? formatMoney(issue.unit_price) : "—"})`
                                      : issue.type === "extra"
                                        ? `extra: ${issue.name}${issue.actual_qty ? ` (x${issue.actual_qty})` : ""}`
                                        : issue.type === "substituted"
                                          ? `substituted: ${issue.name}`
                                          : issue.type === "unavailable"
                                            ? `unavailable: ${issue.name}`
                                            : null}
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                  <div className="actions">
                    <span className="badge">{job.status}</span>
                    {["paused_captcha", "paused_limit"].includes(job.status) ? (
                      <button
                        className="text-btn"
                        type="button"
                        aria-label="Resume paused job"
                        disabled={pending !== null}
                        onClick={() =>
                          run("Job resumed", () =>
                            resumeJob({ job_id: job._id }),
                          )
                        }
                      >
                        Resume
                      </button>
                    ) : null}
                    {job.status === "awaiting_confirm" ? (
                      <>
                        {job.summary_diff && !job.summary_diff.withinPolicy ? (
                          <button
                            className="text-btn danger"
                            type="button"
                            aria-label="Place order anyway"
                            disabled={pending !== null}
                            onClick={() =>
                              run("Order override confirmed", () =>
                                confirmJob({
                                  job_id: job._id,
                                  override_summary_diff: true,
                                }),
                              )
                            }
                          >
                            Place order anyway
                          </button>
                        ) : (
                          <button
                            className="icon-btn primary"
                            type="button"
                            aria-label="Confirm order placement"
                            disabled={pending !== null}
                            onClick={() =>
                              run("Job confirmed", () =>
                                confirmJob({ job_id: job._id }),
                              )
                            }
                          >
                            <Check size={18} />
                          </button>
                        )}
                      </>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="panel span-7">
            <h2>Ledger</h2>
            <div className="job-list">
              {ledger.length === 0 ? (
                <div className="empty">No placed orders yet.</div>
              ) : null}
              {ledger.map((entry) => (
                <div className="job-row tall-row" key={entry._id}>
                  <div>
                    <div className="row-title">
                      {entry.store?.name ?? "Unknown store"} ·{" "}
                      {formatMoney(entry.total, entry.currency)}
                    </div>
                    <div className="row-note">
                      {entry.status} · placed {formatDate(entry.placed_at)}
                      {entry.received_at
                        ? ` · received ${formatDate(entry.received_at)}`
                        : ""}
                      {entry.order_ref ? ` · ${entry.order_ref}` : ""}
                    </div>
                    <div className="line-note">
                      {entry.line_items
                        .map(
                          (line) =>
                            `${line.name} x${line.qty} (${formatMoney(line.price, entry.currency)})`,
                        )
                        .join(", ")}
                    </div>
                    {entry.status === "placed" ? (
                      <form
                        className="receive-form"
                        onSubmit={(event) => handleReceiveLedger(event, entry)}
                      >
                        <input
                          name="receiptRef"
                          placeholder="receipt ref"
                          aria-label="Receipt reference"
                        />
                        {receiptRows.map((index) => (
                          <div className="receipt-line" key={index}>
                            <select
                              name={`receiveItem-${index}`}
                              aria-label={`Received item ${index + 1}`}
                              defaultValue=""
                            >
                              <option value="">Received item</option>
                              {itemOptions.map((item) => (
                                <option key={item._id} value={item._id}>
                                  {item.name}
                                </option>
                              ))}
                            </select>
                            <input
                              name={`receiveQty-${index}`}
                              aria-label={`Received quantity ${index + 1}`}
                              type="number"
                              min="0"
                              step="1"
                              defaultValue={
                                entry.line_items[index]?.qty ?? undefined
                              }
                            />
                          </div>
                        ))}
                        <button
                          className="text-btn primary"
                          type="submit"
                          disabled={pending !== null}
                        >
                          Mark received
                        </button>
                      </form>
                    ) : null}
                  </div>
                  <span className="badge">{entry.status}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="panel span-5">
            <h2>Audit</h2>
            <div className="timeline">
              {audit.length === 0 ? (
                <div className="empty">No audit events yet.</div>
              ) : null}
              {audit.map((event) => (
                <div className="timeline-item" key={event._id}>
                  <div className="timeline-meta">
                    <span className="badge">{event.type}</span>
                    <span>
                      <CalendarClock size={13} /> {formatDate(event.created_at)}
                    </span>
                  </div>
                  <div className="row-title">{event.title}</div>
                  <div className="row-note">
                    {event.detail} · {event.actor}
                    {event.note ? ` · ${event.note}` : ""}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="panel span-12">
            <h2>Config</h2>
            <div className="config-grid">
              <div>
                <div className="section-head">
                  <Settings size={17} />
                  Executor
                </div>
                {executorConfig === undefined ? (
                  <div className="empty">Loading configuration.</div>
                ) : (
                  <form
                    className="config-form"
                    key={executorConfig?._id ?? "new-executor-config"}
                    onSubmit={handleExecutorConfig}
                  >
                    <input
                      type="hidden"
                      name="id"
                      value={executorConfig?._id ?? ""}
                    />
                    <label>
                      Default executor
                      <select
                        name="defaultExecutor"
                        defaultValue={
                          executorConfig?.default_executor ?? "stagehand"
                        }
                      >
                        {executors.map((executor) => (
                          <option key={executor} value={executor}>
                            {executor}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Explorer executor
                      <select
                        name="explorerExecutor"
                        defaultValue={
                          executorConfig?.explorer_executor ?? "stagehand"
                        }
                      >
                        {executors.map((executor) => (
                          <option key={executor} value={executor}>
                            {executor}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Harness CLI
                      <select
                        name="harnessCli"
                        defaultValue={executorConfig?.harness_cli ?? ""}
                      >
                        <option value="">None</option>
                        <option value="claude-code">claude-code</option>
                        <option value="codex">codex</option>
                      </select>
                    </label>
                    <label>
                      Proxy policy
                      <select
                        name="proxyPolicy"
                        defaultValue={
                          executorConfig?.default_proxy_policy ??
                          "if_challenged"
                        }
                      >
                        <option value="none">none</option>
                        <option value="if_challenged">if_challenged</option>
                      </select>
                    </label>
                    <label>
                      VPS region
                      <input
                        name="vpsRegion"
                        defaultValue={
                          executorConfig?.vps_region ?? "ar-buenos-aires"
                        }
                      />
                    </label>
                    <label>
                      Confirm timeout
                      <input
                        name="confirmTimeout"
                        type="number"
                        min="1"
                        defaultValue={
                          executorConfig?.confirm_timeout_minutes ?? 30
                        }
                      />
                    </label>
                    <label className="wide-field">
                      Stagehand model
                      <input
                        name="stagehandModel"
                        defaultValue={executorConfig?.stagehand_model ?? ""}
                      />
                    </label>
                    <button
                      className="text-btn primary wide-field"
                      type="submit"
                      disabled={pending !== null}
                    >
                      Save executor config
                    </button>
                  </form>
                )}
              </div>

              <div>
                <div className="section-head">
                  <ListChecks size={17} />
                  AI tiers
                </div>
                <div className="ai-config-list">
                  {aiTiers.map((tier) => {
                    const config = aiConfigByTier.get(tier);
                    return (
                      <form
                        className="ai-config-row"
                        key={tier}
                        onSubmit={handleAiConfig}
                      >
                        <input type="hidden" name="tier" value={tier} />
                        <div className="row-title">{tier}</div>
                        <input
                          name="provider"
                          aria-label={`${tier} provider`}
                          defaultValue={config?.provider ?? "anthropic"}
                        />
                        <input
                          name="model"
                          aria-label={`${tier} model`}
                          defaultValue={config?.model ?? ""}
                        />
                        <button
                          className="text-btn"
                          type="submit"
                          disabled={pending !== null}
                        >
                          Save
                        </button>
                      </form>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          <div className="panel span-12">
            <h2>Reconciliation sweep</h2>
            <form
              className="sweep-form"
              key={stock
                .map((r) => `${r.item._id}:${r.currentStock}`)
                .join("|")}
              onSubmit={handleReconciliationSweep}
            >
              {stock.length === 0 ? (
                <div className="empty">No items to reconcile.</div>
              ) : (
                <>
                  <div className="sweep-list">
                    {stock.map((row) => (
                      <div className="sweep-row" key={row.item._id}>
                        <div>
                          <div className="row-title">{row.item.name}</div>
                          <div className="row-note">
                            {row.currentStock} {row.item.unit}
                          </div>
                        </div>
                        <input
                          name={`sweep-${row.item._id}`}
                          type="number"
                          min="0"
                          step="1"
                          defaultValue={row.currentStock}
                          aria-label={`Actual count for ${row.item.name}`}
                        />
                      </div>
                    ))}
                  </div>
                  <button
                    className="text-btn primary"
                    type="submit"
                    disabled={pending !== null}
                  >
                    Apply corrections
                  </button>
                </>
              )}
            </form>
          </div>
        </section>
      </main>
    </div>
  );

  return app;
}

export function DashboardClient() {
  const clerkEnabled = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
  if (!clerkEnabled) return <DashboardApp />;

  // Gate on Convex's auth state, not Clerk's: Clerk reports signed-in
  // before the Convex token handshake completes, and queries fired in that
  // window (or while signed out) hit requireUser and throw.
  return (
    <>
      <AuthLoading>
        <div className="auth-shell">
          <div className="auth-panel">
            <ShieldCheck size={28} />
            <h1>Household Manager</h1>
            <p>Checking your session…</p>
          </div>
        </div>
      </AuthLoading>
      <Unauthenticated>
        <div className="auth-shell">
          <div className="auth-panel">
            <ShieldCheck size={28} />
            <h1>Household Manager</h1>
            <p>Sign in with an allowed household account to continue.</p>
            <SignInButton mode="modal">
              <button className="text-btn primary" type="button">
                Sign in
              </button>
            </SignInButton>
          </div>
        </div>
      </Unauthenticated>
      <Authenticated>
        <NotAllowedBoundary>
          <DashboardApp />
        </NotAllowedBoundary>
      </Authenticated>
    </>
  );
}

/**
 * A signed-in Clerk user who is not in CLERK_ALLOWED_SUBJECTS gets a
 * ConvexError("User is not allowed") from every query. Without this
 * boundary that surfaces as a dev-overlay crash instead of an answer.
 */
class NotAllowedBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const notAllowed = error.message.includes("User is not allowed");
    return (
      <div className="auth-shell">
        <div className="auth-panel">
          <ShieldCheck size={28} />
          <h1>Household Manager</h1>
          <p>
            {notAllowed
              ? "This account isn't on the household allowlist. Ask the owner to add your user id to CLERK_ALLOWED_SUBJECTS, then sign in again."
              : `Something went wrong: ${error.message}`}
          </p>
          <SignOutButton>
            <button className="text-btn primary" type="button">
              Sign out
            </button>
          </SignOutButton>
        </div>
      </div>
    );
  }
}
