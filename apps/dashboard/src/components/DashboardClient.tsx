"use client";

import { FormEvent, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  ClipboardCheck,
  Home,
  Minus,
  PackageCheck,
  Plus,
  RotateCcw,
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
  _id: string;
  store_id: Id<"stores">;
  status: string;
  executor: string;
  order_summary_total?: number;
  error?: string;
};

const platforms = ["tiendanube", "mercadolibre", "coto", "vtex"] as const;

function asList<T>(value: T[] | undefined): T[] {
  return value ?? [];
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

  const logEvent = useMutation(api.stock.logEvent);
  const reconcile = useMutation(api.stock.reconcile);
  const upsertStore = useMutation(api.stores.upsert);
  const upsertItem = useMutation(api.items.upsert);
  const createCart = useMutation(api.carts.createProposed);
  const approveCart = useMutation(api.carts.approve);
  const queueCart = useMutation(api.carts.queueApproved);

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
            <ClipboardCheck size={18} />
            Ledger
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
              checkpoint
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
                        ? ` · $${job.order_summary_total}`
                        : ""}
                      {job.error ? ` · ${job.error}` : ""}
                    </div>
                  </div>
                  <span className="badge">{job.status}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="panel span-12">
            <h2>Reconciliation Sweep</h2>
            <div className="timeline">
              <div className="timeline-item">
                <div className="row-title">
                  Delivery receipt is separate from checkout
                </div>
                <div className="row-note">
                  Placed orders enter ledger first; stock changes only on
                  received/reconciled events.
                </div>
              </div>
              <div className="timeline-item">
                <div className="row-title">
                  Unknown final-click outcomes stop here
                </div>
                <div className="row-note">
                  Jobs in confirming timeout move to needs_reconciliation and
                  never auto-click again.
                </div>
              </div>
              <div className="timeline-item">
                <div className="row-title">Screenshots are short-lived</div>
                <div className="row-note">
                  Worker uploads redacted checkout summaries and schedules
                  cleanup through Convex.
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
