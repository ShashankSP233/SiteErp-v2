# Site-ERP v2 — Master Workflow & Production Blueprint

**Version:** 2.0  
**Status:** Production Reference / Pre-Implementation Specification

## 1. Purpose

Site-ERP is a multi-site inventory and material-management system whose central goal is to know:

> **What physical inventory exists, where it is, how much remains, who handled it, and what happened to it.**

It supports sites, users, physical item instances, permanent barcodes, consumables, partial consumption, returns, purchase-order registration, partial receiving, GRNs, site transfers, stock inward, MIA/lost tracking, physical audits, adjustments, reports, and audit trails.

---

## 2. Design Principles

### Confirmed requirements

- Keep the existing **Node.js + Express + PostgreSQL** architecture.
- Do not rewrite the backend in Python.
- EJS/HTML/JavaScript can remain the initial frontend.
- Every tracked physical item is an **Item Instance** with a permanent identity/barcode.
- Item Master defines an item type; Item Instance represents the physical object.
- Barcodes identify instances, not merely item types.
- Reprinting a barcode must preserve the same identity.
- Consumables can support partial consumption.
- A consumed quantity reduces the instance's current quantity without creating a new instance.
- Site transfers use a two-sided **STN -> IN_TRANSIT -> Stock Inward** process.
- Only physically scanned items at the destination enter destination inventory.
- Normal Sites require monthly full audits.
- Super-Stores require daily audits of inventory that changed that day and full audits every 15 days.
- Audit discrepancies do not automatically modify inventory.
- Site access is enforced server-side.
- Future ReqFlow/Site-ERP/SiteExpense integration is a far-future concern and must use APIs/events rather than shared databases.

### Recommended principles

- Use PostgreSQL transactions and row locking for inventory changes.
- Treat the inventory movement ledger as the authoritative history.
- Replace the current generic Record screen with explicit business operations.
- Keep applications independently deployable.
- Use immutable internal IDs/UUIDs for important entities.

---

# 3. Architecture

```text
Users
  |
  v
HTTPS / Reverse Proxy
  |
  v
Node.js / Express
  |
  +-- Authentication / Authorization
  +-- Site Access Control
  +-- Inventory Engine
  +-- Barcode Engine
  +-- Procurement Engine
  +-- Audit Engine
  +-- Reporting
  +-- Future Integration Layer
  |
  v
PostgreSQL
```

Initial frontend:

```text
EJS + HTML + CSS + JavaScript
```

React may be introduced later for highly interactive screens, but is not required for v2.

---

# 4. Site Model

## Normal Site

- Operator belongs to exactly one site.
- Manager can be assigned to multiple normal sites.
- Full inventory audit once per month.
- Supports receiving, issuing, consumption, returns, transfers and receiving transfers.

## Super-Store

- Same basic inventory operations.
- Daily audit of instances whose inventory-affecting state/quantity changed that day.
- Full inventory audit every 15 days.
- Stronger physical inventory control.

---

# 5. Users, Roles and Access

## Operator

One active assigned site.

Can perform permitted operational work only for that site.

## Manager

Can be assigned multiple sites.

Can review discrepancies and approve adjustments according to permissions.

## Admin

Global access.

Can:

- see every site
- manage users
- edit user site assignments
- manage system configuration
- view global reports

## Site assignment

Users must not need to be deleted/recreated when moved.

Recommended table:

```text
site_assignments
----------------
id
user_id
site_id
is_primary
assigned_from
assigned_until
created_at
```

Server-side authorization must derive permitted sites from the authenticated user.

---

# 6. Item Master vs Item Instance

This is the central data-model decision.

## Item Master

Answers:

> What kind of item is this?

Example:

```text
Item Code: CEM-001
Name: OPC Cement
Category: Construction Material
Type: Consumable
Unit: Bag
```

## Item Instance

Answers:

> Which exact physical item is this?

Example:

```text
Instance: CEM-001-0042
Barcode: CEM-001-0042
Original Quantity: 1 Bag
Current Quantity: 1 Bag
Site: Site A
Status: AVAILABLE
```

The Item Master can have many instances.

```text
Cement Master
 |
 +-- Cement #0001
 +-- Cement #0002
 +-- Cement #0003
 +-- Cement #0004
```

Aggregate quantities can be calculated for reports, but physical traceability is instance-based.

---

# 7. Barcode System

Every physical instance gets a permanent unique barcode.

Example:

```text
OIL-001-0005
```

always identifies Oil Barrel #5.

Database constraints should enforce:

```text
UNIQUE(barcode)
UNIQUE(instance_code)
```

Reprinting a damaged label:

- does not create a new instance
- does not change the instance ID
- does not change the barcode
- does not create a new inventory movement

---

# 8. Consumables and Partial Consumption

Item Master should contain:

```text
is_consumable
allows_partial_consumption
```

## Example

A 20 L oil barrel:

```text
Instance: OIL-001-0005
Original: 20 L
Current: 20 L
```

Consume 5 L:

```text
Consumed: 5 L
Current: 15 L
```

The physical instance remains:

```text
OIL-001-0005
```

with the same barcode.

Then:

```text
20 L
  |
  +-- consume 5 L
  v
15 L
  |
  +-- consume 10 L
  v
5 L
  |
  +-- consume 5 L
  v
0 L -> CONSUMED
```

For a non-consumable motor:

```text
Original: 1
Current: 1
```

It cannot normally become 0.5 motor.

## Important rule

**An instance is not split merely because its quantity changes.**

---

# 9. Inventory State Model

Prefer separate dimensions rather than one giant status.

### Lifecycle

```text
ACTIVE
CONSUMED
MIA
LOST
DISPOSED
```

### Physical condition

```text
GOOD
DAMAGED
```

### Logistics/location

```text
AT_SITE
IN_TRANSIT
```

Example:

```text
Instance: OIL-001-0005
Lifecycle: ACTIVE
Condition: GOOD
Location: Site A
Quantity: 8 L
```

During transfer:

```text
Lifecycle: ACTIVE
Condition: GOOD
Location: IN_TRANSIT
Quantity: 8 L
```

After complete consumption:

```text
Lifecycle: CONSUMED
Quantity: 0 L
```

---

# 10. Inventory Movement Engine

Every inventory-affecting action creates an immutable movement record.

Movement types:

```text
RECEIVED
ISSUED
CONSUMED
RETURNED
TRANSFER_OUT
TRANSFER_IN
ADJUSTMENT_IN
ADJUSTMENT_OUT
DISCARDED
MARKED_MIA
MARKED_LOST
MARKED_DAMAGED
```

Recommended movement fields:

```text
id
instance_id
movement_type
quantity
unit
from_site_id
to_site_id
reference_type
reference_id
performed_by
reason
created_at
```

There must be no silent inventory quantity changes.

Example:

```text
20 L -> 15 L
```

must be represented by:

```text
CONSUMED -5 L
```

---

# 11. Procurement and PO Registration

Site-ERP does **not** generate the actual external Purchase Department PO.

Workflow:

```text
Material needed
    |
    v
Purchase Department
    |
    v
Seller quotation/invoice/details
    |
    v
External PO
    |
    v
PO registered in Site-ERP
    |
    v
Seller fulfills
    |
    v
Delivery
    |
    v
GRN
```

PO fields:

```text
PO Number
Vendor
PO Date
Site
Items
Ordered Quantity
Unit
References
Documents
Expected Delivery
Status
Notes
```

Recommended statuses:

```text
DRAFT
SENT
PARTIALLY_RECEIVED
COMPLETED
CANCELLED
```

`SENT` means the external PO has been issued; Site-ERP does not necessarily send it.

---

# 12. GRN / Goods Receiving

A PO may have multiple GRNs.

Example:

```text
PO:
10 Screws
8 Nuts
```

Delivery 1:

```text
8 Screws
```

GRN 1 receives those 8 immediately.

PO:

```text
PARTIALLY_RECEIVED
```

Delivery 2:

```text
2 Screws
8 Nuts
```

GRN 2 completes the PO.

## GRN fields

```text
GRN Number
PO
Vendor
Site
Delivery Reference
Delivery Date
Received By
Items
Quantities
Documents
Notes
Status
```

## GRN posting

```text
GRN
 |
 +-- validate against PO
 +-- create Item Instances
 +-- generate unique barcodes
 +-- create RECEIVED movements
 +-- add inventory
 +-- print labels
```

Inventory is added immediately; it does not wait for the entire PO.

---

# 13. Issue Workflow

Issue means assigning/handing an item or quantity to a person, department, project, work location, etc.

```text
Scan/select instance
       |
       v
Validate availability
       |
       v
Enter issued quantity/reference
       |
       v
Create ISSUE movement
       |
       v
Update state/location
```

Issue and consumption should remain separate concepts.

---

# 14. Consumption Workflow

Consumption means material was actually used.

Example:

```text
Oil Barrel #5
Current = 20 L
     |
     v
Consume 5 L
     |
     v
Current = 15 L
```

Record:

```text
Instance
Quantity
Unit
User
Site
Date/time
Reason
Project/reference if applicable
```

Validation:

```text
quantity > 0
quantity <= current_quantity
item is consumable
```

When quantity reaches zero, the instance may become `CONSUMED`.

---

# 15. Return Workflow

Returns preserve the original physical identity.

Example:

```text
Issued: 20 L
Consumed: 12 L
Remaining: 8 L
Returned: 8 L
```

Same:

```text
Instance: OIL-001-0005
Barcode: OIL-001-0005
```

Movement history:

```text
ISSUED
CONSUMED -5 L
CONSUMED -7 L
RETURNED 8 L
```

Never delete the old instance and create a new one for a return.

---

# 16. Site-to-Site Stock Transfer

Two-sided workflow:

```text
SITE A
  |
  | Stock Transfer Note
  v
IN_TRANSIT
  |
  | physical shipment
  v
SITE B
  |
  | Stock Inward
  v
AVAILABLE
```

## Sending

Operator selects destination and scans every item.

Validation:

- instance exists
- belongs to source site
- available
- not already in transit
- not consumed/lost/unavailable

## STN

```text
STN Number
Source Site
Destination Site
Created By
Dispatch Date
Items
Barcodes
Quantities
Notes
Status
```

## Dispatch

```text
AT_SITE / AVAILABLE
        |
        v
IN_TRANSIT
```

## Receiving

Destination operator scans every item actually received.

Example:

```text
Sent: 10
Received: 8
Missing: 2
```

Only the 8 scanned instances become destination inventory.

---

# 17. MIA / Lost Workflow

Recommended:

```text
IN_TRANSIT
    |
    v
NOT_RECEIVED
    |
    v
MIA
    |
    v
INVESTIGATION
   / FOUND LOST
```

MIA does not immediately mean permanently lost.

**Open decision:** exact trigger for IN_TRANSIT -> MIA.

Recommended:

```text
Stock Inward closed
        |
        v
Unscanned items -> MIA
```

The exact investigation deadline and LOST rule should be decided before implementation.

---

# 18. Inventory Audits

Inventory Audit is physical reconciliation.

Audit Trail is system-history logging.

## Normal Site

Full inventory audit:

```text
Once per month
```

## Super-Store

### Daily changed-item audit

Audit every inventory instance whose inventory-affecting state/quantity changed that day.

Examples:

```text
RECEIVED
ISSUED
CONSUMED
RETURNED
TRANSFERRED
DISCARDED
ADJUSTED
```

Item Master edits alone do not trigger the audit.

### Full audit

Every 15 days:

```text
Scan all active inventory instances
```

---

# 19. Audit Recheck Logic

Example:

```text
10:00
Screws audited
```

Later:

```text
14:00
3 screws issued
```

The earlier audit is no longer sufficient.

The item becomes:

```text
RECHECK_REQUIRED
```

Recommended audit states:

```text
NOT_REQUIRED
REQUIRED
IN_PROGRESS
COMPLETED
RECHECK_REQUIRED
FAILED
```

---

# 20. Audit Scan Results

Possible results:

```text
MATCHED
DUPLICATE
UNKNOWN
UNEXPECTED
MISSING
```

Example:

```text
Expected: 10
Scanned: 9 known + 1 unknown

Matched: 9
Missing: 1
Unknown: 1
```

---

# 21. Audit Discrepancy Workflow

Audits do not automatically modify inventory.

Example:

```text
ERP: 10
Physical: 9
```

Workflow:

```text
Discrepancy
    |
    v
Manager Review
    |
 +--+--+
 |     |
Reject Approve
       |
       v
Inventory Adjustment
```

Approved adjustments create:

```text
ADJUSTMENT_IN
```

or:

```text
ADJUSTMENT_OUT
```

with reason and audit reference.

---

# 22. Barcode Scanning Architecture

Three inputs, one resolver.

## Scanner gun

```text
Scanner -> keyboard input -> Enter
```

## Camera

```text
Browser Camera
      |
      v
Barcode Detection
      |
      v
Resolver
```

## Manual

```text
Enter Barcode -> Resolver
```

All use the same logical:

```text
resolveBarcode(barcode)
```

The scanner does not itself perform an inventory transaction.

The current workflow decides what the scan means.

---

# 23. Scan Contexts

### Audit

Scan -> verify physical presence.

### Transfer

Scan -> add instance to STN.

### Stock Inward

Scan -> mark transfer item received.

### Issue

Scan -> identify item.

### Return

Scan -> identify issued item.

### Inventory lookup

Scan -> display instance.

Scanner feedback should clearly distinguish:

```text
MATCHED
ALREADY_SCANNED
UNKNOWN_BARCODE
WRONG_SITE
WRONG_TRANSFER
ITEM_NOT_AVAILABLE
ALREADY_RECEIVED
```

Continuous camera scanning should be supported for high-volume audits.

---

# 24. Inventory UI

Example:

| Barcode        | Item  | Original | Current | Site   | Status    |
| -------------- | ----- | -------: | ------: | ------ | --------- |
| OIL-001-0001   | Oil   |     20 L |    15 L | Site A | Available |
| OIL-001-0002   | Oil   |     20 L |    20 L | Site A | Available |
| OIL-001-0003   | Oil   |     20 L |     0 L | Site A | Consumed  |
| MOTOR-002-0004 | Motor |        1 |       1 | Site B | Available |

Instance detail page:

```text
Instance
Barcode
Item Master
Original Quantity
Current Quantity
Consumed Quantity
Site
Lifecycle
Condition
Location
```

Also show complete movement history.

---

# 25. Navigation

## Operator

```text
Dashboard

Inventory
  - Inventory
  - Scan Item
  - Item History

Receiving
  - Purchase Orders
  - GRNs
  - Pending Receipts

Operations
  - Issue
  - Consumption
  - Return
  - Stock Transfer

Audits
  - Inventory Audit

Vendors

Reports
```

## Manager

Add:

```text
Approvals
Audit Review
Adjustments
Audit Trail
```

## Admin

Add:

```text
Users
Sites
Item Master
System Configuration
Global Reports
```

---

# 26. Vendors, Bills and Payments

## Vendors

```text
Name
Code
Contact
Email
Phone
Address
GST details
Documents
Status
```

## Financial chain

Potentially:

```text
Vendor
  |
  v
PO
  |
  v
GRN
  |
  v
Bill
  |
  v
Payment
```

Potential reconciliation:

```text
PO Quantity
    |
    v
GRN Quantity
    |
    v
Bill Quantity
```

Example:

```text
PO: 100
GRN: 80
Bill: 100
```

can trigger:

```text
BILL / GRN QUANTITY MISMATCH
```

**Open decision:** whether Site-ERP is the actual payment system of record or primarily records Accounts activity.

---

# 27. Reports

## Inventory

- current inventory
- inventory by site
- inventory by item
- inventory by category
- instance-level inventory
- consumable balances
- consumed items
- MIA items
- lost items
- damaged items
- in-transit items

## Procurement

- PO register
- outstanding POs
- partially received POs
- completed POs
- GRN register
- vendor-wise purchases

## Transfers

- STN register
- pending transfers
- partial receipts
- MIA transfers
- transfer history

## Audits

- monthly audits
- daily Super-Store audits
- 15-day audits
- missing items
- unexpected items
- recheck-required items
- discrepancies
- adjustment history

## Consumption

- consumption by site
- consumption by item
- consumption by period
- consumption by user
- consumption by project/reason where supported

---

# 28. Audit Trail

Audit Trail records system actions.

Example:

```text
User: Rahul
Action: CONSUME_ITEM
Instance: OIL-001-0005
Old Quantity: 20 L
New Quantity: 15 L
Timestamp: ...
```

Actions should include:

- login
- user changes
- site assignment changes
- item creation/modification
- PO creation/modification
- GRN
- inventory movement
- consumption
- transfer
- stock inward
- audit
- adjustment
- approval
- bill/payment changes

Inventory movement history and Audit Trail are separate concepts.

---

# 29. Database Blueprint

Core tables:

```text
users
sites
site_assignments

item_masters
item_instances
barcodes

vendors

purchase_orders
purchase_order_items

grns
grn_items

stock_transfers
stock_transfer_items
stock_inwards
stock_inward_items

inventory_movements

inventory_audits
inventory_audit_scans
inventory_adjustments

bills
bill_items
payments

audit_logs
attachments
```

## Sites

```text
sites
-----
id
code
name
type
address
status
created_at
updated_at
```

Types:

```text
NORMAL
SUPER_STORE
```

## Users

```text
users
-----
id
name
email
password_hash
role
status
created_at
updated_at
```

## Item Masters

```text
item_masters
------------
id
item_code
name
description
category_id
item_type
unit
is_consumable
allows_partial_consumption
requires_instance_tracking
container_type
reorder_level
status
created_at
updated_at
```

## Item Instances

```text
item_instances
--------------
id
item_master_id
instance_code
barcode
original_quantity
current_quantity
unit
site_id
status
received_grn_id
created_at
updated_at
```

Potential optional fields:

```text
batch_number
serial_number
manufacture_date
expiry_date
condition
```

## Inventory Movements

```text
inventory_movements
-------------------
id
instance_id
movement_type
quantity
unit
from_site_id
to_site_id
reference_type
reference_id
performed_by
reason
created_at
```

## Purchase Orders

```text
purchase_orders
---------------
id
po_number
vendor_id
site_id
po_date
status
external_reference
notes
created_by
created_at
```

## Purchase Order Items

```text
purchase_order_items
--------------------
id
po_id
item_master_id
ordered_quantity
unit
received_quantity
remaining_quantity
```

## GRNs

```text
grns
----
id
grn_number
po_id
vendor_id
site_id
delivery_reference
received_at
received_by
status
notes
```

## GRN Items

```text
grn_items
---------
id
grn_id
po_item_id
quantity_received
unit
```

## Stock Transfers

```text
stock_transfers
---------------
id
stn_number
source_site_id
destination_site_id
status
created_by
dispatched_by
dispatched_at
received_at
created_at
```

## Stock Transfer Items

```text
stock_transfer_items
--------------------
id
transfer_id
instance_id
sent_quantity
received_quantity
status
```

## Stock Inwards

```text
stock_inwards
-------------
id
inward_number
transfer_id
received_by
received_at
status
notes
```

## Stock Inward Items

```text
stock_inward_items
------------------
id
inward_id
transfer_item_id
instance_id
received_quantity
condition
```

## Audits

```text
inventory_audits
----------------
id
site_id
audit_type
scheduled_date
started_at
completed_at
status
created_by
```

Audit types:

```text
MONTHLY
DAILY_CHANGED
FULL_15_DAY
AD_HOC
```

## Audit Scans

```text
inventory_audit_scans
---------------------
id
audit_id
barcode
instance_id
result
scanned_by
scanned_at
```

---

# 30. API / Backend Modules

Recommended logical modules:

```text
/api/auth
/api/users
/api/sites

/api/items
/api/item-instances
/api/barcodes

/api/vendors

/api/purchase-orders
/api/grns

/api/inventory
/api/inventory/movements
/api/inventory/consume
/api/inventory/issue
/api/inventory/return
/api/inventory/adjust

/api/transfers
/api/transfers/:id/inward

/api/audits
/api/audits/:id/scans

/api/bills
/api/payments

/api/reports
/api/audit-log
```

The exact route naming can change; module boundaries should remain clear.

---

# 31. Business Rules

## Consumption

```text
quantity > 0
quantity <= current_quantity
item is consumable
partial consumption is allowed for the item
```

## Transfer

```text
instance belongs to source site
instance is available
instance is not already in transit
destination != source
```

## Return

```text
instance was previously issued
instance is returnable
quantity is valid
```

## Stock Inward

```text
instance belongs to transfer
instance is in transit
instance has not already been received
```

## PO / GRN

```text
received quantity <= ordered quantity
```

unless an explicit over-receipt policy is approved.

## Audit

- valid barcode required
- duplicate scans detected
- wrong-site item flagged
- unexpected item recorded
- missing item determined by expected-vs-scanned comparison

---

# 32. Database Transactions and Concurrency

Inventory operations must use PostgreSQL transactions.

Example:

```text
BEGIN
  Lock instance
  Read current quantity
  Validate requested quantity
  Update instance
  Insert movement
COMMIT
```

Example race condition:

```text
Current = 10 L

User A consumes 7 L
User B consumes 6 L
```

The system must never result in:

```text
Current = -3 L
```

The same transaction discipline applies to:

- consumption
- issue
- return
- transfer dispatch
- stock inward
- adjustments
- receiving

---

# 33. Security

Maintain/enforce:

- password hashing
- sessions
- secure cookies
- CSRF protection
- rate limiting
- input validation
- SQL parameterization
- role authorization
- server-side site authorization
- audit logging
- file upload validation
- file-size limits
- HTTPS in production

Never trust client-provided site IDs or permissions.

---

# 34. Future ReqFlow / Site-ERP / SiteExpense Ecosystem

This is **far-future scope** and must not complicate the current implementation unnecessarily.

Long-term architecture:

```text
                 +----------------+
                 |    ReqFlow     |
                 | Requisitions / |
                 | Procurement    |
                 +-------+--------+
                         |
                      API/Event
                         |
                         v
                 +---------------+
                 |   Site-ERP    |
                 | Inventory /   |
                 | Site Material |
                 +-------+-------+
                         |
                      API/Event
                         |
                         v
                 +---------------+
                 |  SiteExpense  |
                 | Expenses /    |
                 | Finance       |
                 +---------------+
```

Possible future chain:

```text
Site needs material
        |
        v
ReqFlow requisition
        |
        v
Purchase process
        |
        v
PO
        |
        v
Site-ERP
        |
        v
GRN
        |
        v
Physical inventory
        |
        v
Issue / Consumption
        |
        v
SiteExpense
```

## Integration rules

Do not directly query another application's database.

Do not make applications share tables.

Each application owns its own database.

Future communication should use:

- REST APIs
- webhooks
- events
- integration logs
- authentication
- stable external references

Example:

```text
source_system: REQFLOW
external_id: RF-REQ-000452
```

or:

```text
source_system: SITE_ERP
external_id: CON-2026-0081
```

This integration is deliberately deferred until each application is independently stable.

---

# 35. Migration Strategy

Do not discard the current application.

Preserve/refactor:

- authentication
- users
- vendors
- PO functionality
- GRNs
- bills
- payments
- reports
- attachments
- sessions
- security
- audit trail

The major redesign is the inventory domain.

## Current model

```text
Item
 +
Quantity
 +
Ledger
```

## New model

```text
Item Master
    |
    v
Physical Item Instance
    |
    v
Barcode
    |
    v
Current Quantity
    |
    v
Location / Site
    |
    v
State
    |
    v
Movement History
```

The generic Record screen should eventually become explicit operations:

```text
Receive Goods
Issue Item
Consume Item
Return Item
Transfer Stock
Stock Inward
Discard Item
Inventory Adjustment
```

---

# 36. Implementation Roadmap

## Phase 1 — Foundation

- Sites
- Users
- Site assignments
- Roles
- Item Masters
- Item Instances
- Barcodes

## Phase 2 — Inventory Engine

- receiving
- issue
- consumption
- return
- adjustments
- movement ledger
- validation
- concurrency

## Phase 3 — Procurement

- PO register
- PO items
- partial GRNs
- received quantities
- remaining quantities
- instance creation
- barcode generation
- label printing

## Phase 4 — Transfers

- STN
- dispatch
- IN_TRANSIT
- Stock Inward
- partial receipt
- MIA
- investigation
- lost

## Phase 5 — Scanning

- scanner gun
- manual entry
- camera
- common resolver
- continuous scanning
- scan feedback

## Phase 6 — Audits

- monthly Normal Site audit
- daily Super-Store changed-item audit
- 15-day Super-Store full audit
- recheck-required
- discrepancy review
- approval
- adjustments

## Phase 7 — Finance

- bills
- GRN reconciliation
- payments
- payables

Only after the actual Accounts workflow is confirmed.

## Phase 8 — Reporting

Complete operational and management reports.

## Phase 9 — Future integrations

Only after Site-ERP is stable:

- ReqFlow integration
- SiteExpense integration
- notifications
- event architecture

---

# 37. Testing Strategy

## Unit tests

Test:

- consumption calculations
- return calculations
- quantity validation
- status transitions
- PO remaining quantities
- partial GRNs
- transfer quantities
- audit scheduling
- recheck logic
- adjustments

## Integration test

The following must work end-to-end:

```text
PO
 -> GRN
 -> Item Instances
 -> Barcodes
 -> Inventory
 -> Transfer
 -> Stock Inward
 -> Audit
```

## Permission tests

```text
Operator Site A -> Site A       PASS
Operator Site A -> Site B       DENY

Manager A+B -> Site A           PASS
Manager A+B -> Site B           PASS
Manager A+B -> Site C           DENY

Admin -> all                    PASS
```

## Critical acceptance scenario

```text
External Purchase
      |
      v
PO registered
      |
      v
Seller delivers
      |
      v
GRN
      |
      v
10 oil barrels received
      |
      v
10 unique instances
      |
      v
10 unique barcodes
      |
      v
Labels printed
      |
      v
5 L consumed from Barrel #4
      |
      v
Barrel #4 = 15 L
      |
      v
Transfer to Site B
      |
      v
IN_TRANSIT
      |
      v
Site B scans barrel
      |
      v
AVAILABLE at Site B
      |
      v
10 L consumed
      |
      v
5 L remaining
      |
      v
Returned
      |
      v
Site A receives 5 L
      |
      v
Audit scans barcode
      |
      v
Physical = 5 L
ERP = 5 L
      |
      v
MATCHED
```

---

# 38. Deployment Architecture

```text
Users
  |
  v
HTTPS / Reverse Proxy
  |
  v
Node.js / Express
  |
  +-- Application
  +-- PostgreSQL
  +-- File Storage
```

Recommended production practices:

- Linux/VPS or managed Node host
- managed PostgreSQL where practical
- HTTPS
- reverse proxy
- environment variables/secrets
- database backups
- application logs
- error monitoring
- migration process
- restore testing

---

# 39. Open Decisions Before Production

These must be explicitly resolved before implementing the affected module.

## Inventory

- [ ] Partial consumption configurable per Item Master? **Recommended: yes**
- [ ] What happens to an empty barrel/container?
- [ ] Can a consumable be whole-instance-only?
- [ ] Are fractional quantities allowed for every unit?
- [ ] Can consumption happen directly, or must it always follow Issue?

## Transfers

- [ ] Exact trigger for IN_TRANSIT -> MIA
- [ ] How long before MIA becomes LOST?
- [ ] Who can resolve MIA?
- [ ] Can a found MIA item return directly to AVAILABLE?

## Users

- [ ] Exact Manager permissions
- [ ] Can Managers be assigned Super-Stores?
- [ ] Does Viewer remain?
- [ ] Exact approval permissions

## Procurement

- [ ] Over-receipt policy
- [ ] PO amendment policy
- [ ] PO cancellation rules
- [ ] Can PO quantities be changed after partial receipt?

## Finance

- [ ] Is Site-ERP payment system of record?
- [ ] Exact bill approval workflow
- [ ] Exact GRN-to-bill reconciliation
- [ ] Accounts role matrix

## Audits

- [ ] Exact audit cut-off time
- [ ] Monthly audit scheduling
- [ ] 15-day audit scheduling
- [ ] Which adjustments require Manager approval
- [ ] Whether any low-value discrepancy can be auto-approved

## Physical inventory

- [ ] Damaged label handling
- [ ] Damaged item handling
- [ ] Empty container handling
- [ ] Expired item handling
- [ ] Batch/expiry/serial tracking requirements

---

# 40. Production Rules — Quick Reference

1. **Item Master is not a physical item.**
2. **Item Instance is the physical object.**
3. **Every tracked instance has a permanent identity and barcode.**
4. **Reprinting a barcode never creates a new instance.**
5. **Instances are not split during transfer.**
6. **Consumable quantity may decrease while the physical instance remains the same.**
7. **Every inventory change creates a movement.**
8. **A PO may be received through multiple GRNs.**
9. **GRN receipt immediately creates inventory.**
10. **Transfers use STN -> IN_TRANSIT -> Stock Inward.**
11. **Only scanned transfer items enter destination inventory.**
12. **Missing does not automatically mean permanently lost.**
13. **Audits verify physical reality; they do not silently alter inventory.**
14. **Audit discrepancies require controlled adjustment.**
15. **A later inventory movement can make an earlier audit `RECHECK_REQUIRED`.**
16. **Normal Sites receive a full monthly audit.**
17. **Super-Stores receive daily changed-item audits and full 15-day audits.**
18. **Site access is enforced server-side.**
19. **Applications remain independently owned; future integrations use APIs/events.**
20. **Build the inventory foundation before higher-level features.**

---

# 41. Final System Model

```text
                         SITE-ERP
                            |
        +-------------------+-------------------+
        |                   |                   |
      SITES               USERS             PROCUREMENT
        |                   |                   |
        |              Assignments              PO
        |                                       |
        |                                      GRN
        |                                       |
        +-------------------+-------------------+
                            |
                            v
                       ITEM MASTER
                            |
                            v
                      ITEM INSTANCE
                            |
                  +---------+---------+
                  |                   |
               BARCODE             QUANTITY
                  |                   |
                  +---------+---------+
                            |
                            v
                  INVENTORY MOVEMENTS
                            |
       +---------+----------+----------+---------+
       |         |                     |         |
      ISSUE   CONSUME                RETURN   TRANSFER
       |         |                     |         |
       |         |                     |     IN TRANSIT
       |         |                     |         |
       |         |                     |    STOCK INWARD
       +---------+---------------------+---------+
                            |
                            v
                          AUDITS
                            |
                     +------+------+
                     |             |
                  MATCHED     DISCREPANCY
                                  |
                                  v
                               REVIEW
                                  |
                                  v
                              ADJUSTMENT
                                  |
                                  v
                             AUDIT TRAIL
```

Long-term:

```text
ReqFlow
   |
 API / Events
   v
Site-ERP
   |
 API / Events
   v
SiteExpense
```

The integration is **future scope** and should not delay or complicate the independent Site-ERP implementation.

---

## Final Implementation Principle

> **Do not code around an unclear business rule. Resolve an OPEN DECISION before implementing the affected module.**

The most important dependency chain is:

```text
Sites / Users
      |
      v
Item Masters
      |
      v
Item Instances
      |
      v
Barcodes
      |
      v
Inventory Movements
      |
      +-- Receiving
      +-- Issue
      +-- Consumption
      +-- Return
      +-- Transfer
      |
      v
Audits
      |
      v
Reports / Future Integrations
```

This document is the master reference for production planning and implementation.
