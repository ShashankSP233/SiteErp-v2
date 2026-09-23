# Site ERP (v6.4.1) — Inventory Audit vs Ledger

**Fixed & improved:**

- **Separated the two audits.** "Audit Trail" (system action log) stays at /audit;
  "Inventory Audit" (barcode scan count) now lives at /inventory-audit — they no
  longer collide, so the Inventory Audit is reachable.
- **Reconciliation now compares scans against the ledger (inventory report):**
  per item it shows Ledger (book) qty vs Scanned (physical) qty, the discrepancy,
  the item cost, and the **value of missing inventory** — with a total at the foot.
- Audit sessions carry a **period** (Monthly / Quarterly / Annual / Ad-hoc).
- Unknown scanned codes are listed separately for investigation.

**New in v6.4 — Inventory Audit:**

- Start a named audit session, optionally scoped to a location.
- **Scan barcodes** with a USB scanner (it types the code); each scan is looked up,
  classified live (matched / unexpected / unknown / duplicate) and recorded with time
  and user.
- **Close & reconcile:** a report of expected vs found, with **missing** (in ERP, not
  scanned), **unexpected** (scanned, not expected) and a per-item **variance** table.
  Export to CSV or Print/PDF. Closing an audit locks it; every scan is preserved.
- Stock is never auto-adjusted — the audit produces the variance, you post any
  corrections through the normal adjustment flow.

**New in v6.3 — barcodes:**

- On every receipt, labels are generated automatically: **per-unit** items get one
  label per unit, **per-batch** items get one label showing the quantity. Codes are
  `ITEMCODE-YY-####` with a per-item, per-year serial that continues across receipts
  and resets each year.
- A **Barcodes** tab: generate labels for existing stock, filter, select, and
  **Print → PDF** (real, scannable Code 128 labels rendered offline) or **Export to
  Excel/CSV** (the label register).
- Barcodes are standard Code 128 — a normal USB scanner reads the exact code back
  (used by the Inventory Audit tab in Stage 3).

**New in v6.2 — structured item coding (from the Item Coding Master):**

- 12 categories + 51 sub-categories seeded (marine-dredging stores taxonomy).
- Item codes are now **CAT-SUB-NNNN** (e.g. MEC-BRG-0042), assigned automatically
  with an atomic per-sub-category serial that is never reused.
- Item master enriched: UOM, criticality (A/B/C), detailed specification,
  preferred make, OEM part no., min/reorder — plus a **label mode** per item
  (per-unit / per-batch) that drives barcode printing in the next stage.
- Add-item screen now uses Category -> Sub-category pickers; the code is generated on save.

_Coming next:_ Stage 2 barcode printing (PDF/Excel) and Stage 3 scan + Inventory Audit.

**New in v6.1 (from testing feedback):**

- **Transfer / Distribute** movement: move stock Site→Vessel/Equipment, back
  Vessel/Equipment→Site, and Site→Site. Transfers keep total stock unchanged and
  move it between locations. A transfer note is required; attachments supported.
- **Issue** now shows its From-location and live stock-by-location, captures an
  optional destination (vessel/equipment), and the form no longer blocks submit.
- **Item picker** supports type-to-search manual entry.
- **Adjustments** now capture their location correctly (no more "unspecified").
- **Attachments** on Purchase Orders and Bills (image/PDF).
- **Reports**: Inventory Valuation and Stock-by-Location, each as CSV and as a
  printable page (Print / Save as PDF), with values.
- **Audit** now shows the actual change (fields), not just record ID/IP.

**New in v6 (procurement + master data):**

- **Purchase Orders**: create a PO with item lines -> manager approves -> receive
  goods against it (auto-generates a GRN and adds to stock, partial receipts
  supported). Over-receipt and receive-before-approval are blocked.
- **Item master** now carries HSN code, GST %, min/max stock levels, and item group.
- **Vendor master** now carries contact person, mobile/phone, email, address,
  GSTIN, notes, and shows outstanding payable per vendor.
- The procurement chain links end-to-end: **PO -> GRN (stock) -> Bill -> Payment**,
  all under the approval + audit trail.

Multi-site inventory + bills/payments/approvals, built as a standard Node.js web
app on PostgreSQL. Designed to run on a server with users logging in from
different sites, using Supabase as the managed database.

## What's inside

- **Inventory** — item master, ledger-based stock (receive / issue / return /
  discard / adjust), per-location stock validation, weighted-average costing,
  reorder / low-stock alerts, per-item ledger, GRN & issue numbering.
- **Bills / Payments / Approvals** — record supplier bills (optionally linked to
  a GRN), a manager/admin approval step, payments against approved bills,
  outstanding tracking, and a vendor-payables view.
- **Platform** — roles (admin/manager/operator/viewer), forced first-login
  password change, Postgres-backed sessions, CSRF, rate-limited login, audit
  trail, self-hosted Bootstrap (no CDN), CSV exports.

## Tech

Node.js · Express · EJS · **PostgreSQL via `pg`** · `connect-pg-simple` sessions ·
scrypt password hashing (built-in `crypto`, no native `bcrypt`) · Helmet · Multer.
All SQL lives in `src/repositories/*`, so changing the database later is contained.

---

## Quick local test (no database setup)

Want to see it run on your machine first? You don't need Supabase or any install.
If `DATABASE_URL` is **not** set, the app uses Node's built-in SQLite engine
(stored in `./data/local.db`), auto-creates the tables, and seeds the admin:

```bash
npm install
npm start        # http://localhost:3000
```

Log in with `admin` / `admin123` (you'll set a new password on first login).
To reset the local database, delete the `data` folder.

You can also self-test the whole engine without starting the server:

```bash
npm run verify   # runs inventory + bills/payments/approvals end-to-end
```

> The local engine is SQLite **only for local testing**. The repositories are
> written in SQL that runs on both engines, so switching to Supabase/PostgreSQL
> (below) needs no code changes — just set `DATABASE_URL`.

## Setup with Supabase (recommended)

1. **Create a Supabase project** at <https://supabase.com>.
2. **Get the connection string:** Project Settings → Database → _Connection string_ →
   **URI**. For a long-running server use the **Session pooler** string, e.g.
   `postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`.
3. **Configure the app:**

   ```bash
   cp .env.example .env
   # edit .env: paste DATABASE_URL, set a long SESSION_SECRET, keep PGSSL="true"
   npm install
   ```

4. **Create the schema, then verify the connection:**

   ```bash
   npm run migrate     # creates all tables
   npm run smoke       # confirms connection + schema + a safe round-trip
   npm run seed        # creates the admin user
   ```

   > `npm run smoke` is the fastest way to confirm your Supabase setup is correct
   > before going further. It leaves no test data behind.

5. **Run it:**

   ```bash
   npm start           # http://localhost:3000
   ```

   Log in as `admin` / `admin123` (from `.env`); you'll set a new password immediately.

You can also create the schema by pasting `src/db/migrations/001_init.sql` into the
Supabase SQL editor instead of running `npm run migrate`.

## Running it for different sites (production)

This is a hosted web app: deploy the Node server once (Render, Railway, Fly.io, or a
VPS) with the same `.env`, and each site logs in through the browser. Set
`NODE_ENV=production`, a strong `SESSION_SECRET`, and serve over HTTPS. Concurrency
is handled by PostgreSQL transactions; sessions are stored in the database, so the
app can run behind a load balancer.

## Changing the database later

Only `src/config/db.js` and the SQL in `src/repositories/*` know about PostgreSQL.
To move to another engine, adapt those; the routes, views, and business logic are
unaffected. (A query builder such as Knex could be dropped into `db.js` later if you
want multi-dialect support.)

## Roadmap (next upgrades)

- WhatsApp notifications (e.g. low-stock and approval alerts) after the trial.
- Reports: date-range spend, per-site expense, GRN-to-bill reconciliation.
- SiteXpense as a separate small petty-expense app on the same foundation.

## Note on testing

The database-independent logic (financial-year numbering, weighted-average
costing, CSV, password hashing) is unit-tested: `npm test`. The PostgreSQL data
access is validated on your first connection via `npm run smoke` and normal use.

## Scripts

| Command           | Purpose                              |
| ----------------- | ------------------------------------ |
| `npm run migrate` | Apply SQL migrations                 |
| `npm run smoke`   | Verify DB connection + schema (safe) |
| `npm run seed`    | Create the admin user                |
| `npm start`       | Start the server                     |
| `npm test`        | Run unit tests (no DB needed)        |
