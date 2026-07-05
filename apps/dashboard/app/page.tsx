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

const stockRows = [
  { name: "Yerba mate", count: 1, unit: "pack", note: "Reorder to 3" },
  {
    name: "Laundry detergent",
    count: 0,
    unit: "bottle",
    note: "In proposed cart",
  },
  { name: "Coffee", count: 2, unit: "bag", note: "Healthy" },
];

const jobs = [
  {
    title: "Tienda Kay weekly cart",
    state: "awaiting_confirm",
    note: "Summary diff within policy",
  },
  {
    title: "Mercado Libre test order",
    state: "paused_captcha",
    note: "Needs noVNC recovery",
  },
];

export default function DashboardHome() {
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
              Phase 1 scaffold: stock, carts, approvals, reconciliation.
            </div>
          </div>
          <div className="status-row">
            <span className="badge">
              <ShieldCheck size={14} /> VPS gate pending
            </span>
            <span className="badge">
              <AlertTriangle size={14} /> 1 checkpoint
            </span>
          </div>
        </header>

        <section className="grid">
          <div className="panel span-7">
            <h2>Stock</h2>
            <div className="stock-list">
              {stockRows.map((row) => (
                <div className="stock-row" key={row.name}>
                  <div>
                    <div className="row-title">{row.name}</div>
                    <div className="row-note">
                      {row.count} {row.unit} · {row.note}
                    </div>
                  </div>
                  <div className="actions">
                    <button
                      className="icon-btn danger"
                      type="button"
                      aria-label={`Mark ${row.name} out`}
                    >
                      <Minus size={18} />
                    </button>
                    <button
                      className="icon-btn"
                      type="button"
                      aria-label={`Add one ${row.name}`}
                    >
                      <Plus size={18} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="panel span-5">
            <h2>Purchase Jobs</h2>
            <div className="job-list">
              {jobs.map((job) => (
                <div className="job-row" key={job.title}>
                  <div>
                    <div className="row-title">{job.title}</div>
                    <div className="row-note">
                      {job.state} · {job.note}
                    </div>
                  </div>
                  <button
                    className="icon-btn primary"
                    type="button"
                    aria-label={`Review ${job.title}`}
                  >
                    <Check size={18} />
                  </button>
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
