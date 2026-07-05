"use client";

import { FormEvent, useMemo, useState } from "react";
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
import { useMutation, useQuery } from "convex/react";
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
  lines: Array<{ item_id: Id<"items">; qty: number; note?: string }>;
};

type Job = {
  _id: Id<"purchase_jobs">;
  store_id: Id<"stores">;
  status: string;
  executor: string;
  order_summary_total?: number;
  error?: string;
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

export function DashboardClient() {
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
  const approveCart = useMutation(api.carts.approve);
  const queueCart = useMutation(api.carts.queueApproved);
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

  return (
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
                <div className="job-row" key={cart._id}>
                  <div>
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
                  </div>
                  <div className="actions">
                    {cart.status === "proposed" ? (
                      <button
                        className="icon-btn primary"
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
                      </button>
                    ) : null}
                    {cart.status === "approved" ? (
                      <button
                        className="icon-btn primary"
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
                <div className="job-row" key={job._id}>
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
                  </div>
                  <span className="badge">{job.status}</span>
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
        </section>
      </main>
    </div>
  );
}
