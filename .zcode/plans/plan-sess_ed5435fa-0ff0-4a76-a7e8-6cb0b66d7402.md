# 🎯 Pelan Pelaksanaan: Booking Operations Hub

## Ringkasan Objektif
Membina **Frappe Page baharu** (`/app/booking-hub`) yang menggabungkan workflow booking operasi dalam satu interface yang mudah dan simple untuk tour operator.

---

## 📋 Spesifikasi Teknikal

### 1. Struktur Fail Baharu
```
travel_booking/travel_booking_management/page/booking_hub/
├── booking_hub.js          # Main page SPA (~800-1000 lines)
├── booking_hub.css         # Scoped styles (.bh-* namespace)
└── API Backend:
    travel_booking/api/booking_hub.py  # Dedicated API module
```

### 2. UI Layout (5 Tabs)

#### **Tab 1: Booking Queue** (Kanban Board View)
```
Columns: [Pending Payment] → [Accepted] → [Processing] → [Confirmed] → [Completed]
         ↓                 ↓           ↓            ↓            ↓
      Cards showing:       Cards:      Cards:       Cards:       Cards:
      - Booking #          - BK...     - BK...      - BK...       - BK...
      - Customer name      - Customer  - Customer   - Customer    - Trip name
      - Trip name          - Trip      - Trip        - Dates       - Dates
      - Amount due         - Amount    - Cabin count - Staterooms  - Pax count
      - Days pending       - % Paid    - Actions     - Actions     
```

**Features:**
- Drag-and-drop antara status columns
- Filter: Date range, Trip, Customer, Package Type
- Quick actions card: "Send Reminder", "View Details", "Call Customer"
- Color-coded urgency (red = >3 days pending payment)

#### **Tab 2: Active Bookings** (List + Detail Split View)
```
┌─────────────────────┬─────────────────────────────────┐
│ LIST PANEL          │ DETAIL PANEL                    │
│                     │                                 │
│ Search + Filters    │ ┌─────────────────────────────┐ │
│ [Search box]        │ │ Booking: BK.26.08.001       │ │
│ [Status dropdown]   │ │ Customer: Ahmad bin Abu      │ │
│ [Trip filter]       │ │ Trip: Caribbean Cruise 2026  │ │
│ [Date range]        │ │ Dates: 15 Sep - 22 Sep      │ │
│                     │ │ Status: ● Accepted           │ │
│ ┌─────────────────┐ │ │ Payment: RM4,500 / RM9,000  │ │
│ │BK.26.08.001  Ahm│→│ ├─────────────────────────────┤ │
│ │BK.26.08.002  Sit│ │ │ TABS:                        │ │
│ │BK.26.07.005  Fat│ │ │ [Summary] [Cabins] [Payment] │ │
│ └─────────────────┘ │ │ [Travellers] [Addons] [Logs] │ │
│                     │ └─────────────────────────────┘ │
└─────────────────────┴─────────────────────────────────┘
```

**Sub-tabs dalam Detail Panel:**
1. **Summary**: Overview stats, status timeline, quick actions
2. **Cabins & Travellers**: Inline editable table (replace need to open each Reservation)
3. **Payment Timeline**: Visual bars showing payment history + refund + balance
4. **Traveller List**: Document status indicators per traveller
5. **Addon Orders**: View/manage addon purchases
6. **Activity Log**: Audit trail of all changes

#### **Tab 3: Cabin Arrangement** (Visual Grid)
```
Booking: BK.26.08.001 | Trip: Caribbean Cruise | Ship: Aroya

┌─────────────────────────────────────────────────────────────┐
│  CABIN GRID VIEW                                           │
│                                                             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐     │
│  │ Cabin 101│ │ Cabin 102│ │ Cabin 103│ │ Cabin 104│     │
│  │ Balcony  │ │ Suite    │ │ Interior │ │ Balcony  │     │
│  │ ████████ │ │ ████░░░░ │ │ ██████░░ │ │ ████████ │     │
│  │ Ahmad    │ │ Siti     │ │ Ali+Child│ │ Fatimah  │     │
│  │ ✅ Docs  │ │ ⚠️ Visa  │ │ ✅ Docs  │ │ ❌ Pass  │     │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘     │
│                                                             │
│  Legend: ✅ Complete | ⚠️ Pending | ❌ Missing              │
│                                                             │
│  [Assign Stateroom] [Bulk Assign from Manifest]             │
│  [Swap Cabins] [Print Cabin List]                           │
└─────────────────────────────────────────────────────────────┘
```

**Features:**
- Visual cabin cards with drag-and-drop traveller reassignment
- Color-coded document completion status
- Click cabin → expand to see all traveller details inline
- Batch operations: Upload Aroya manifest CSV → auto-assign stateroom_no + aroya_guest_no
- Deck plan visualization (optional future enhancement)

#### **Tab 4: Payment Center** (Financial Overview)
```
┌─────────────────────────────────────────────────────────────┐
│  PAYMENT DASHBOARD                                         │
│                                                             │
│  Summary Cards:                                             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐     │
│  │This Month│ │Pending   │ │Overdue   │ │Refund    │     │
│  │RM45,200  │ │RM12,400  │ │RM8,900   │ │RM2,100   │     │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘     │
│                                                             │
│  Payment Queue Table:                                       │
│  ┌────┬──────────┬────────┬──────────┬────────┬────────┐  │
│  │#   │Booking   │Customer│Due Date  │Amount  │Action  │  │
│  ├───┼──────────┼────────┼──────────┼────────┼────────┤  │
│  │1   │BK.08.001 │Ahmad   │25 Aug    │RM4,500 │Reminder│  │
│  │2   │BK.08.002 │Siti    │28 Aug    │RM9,000 │PayLink │  │
│  └────┴──────────┴────────┴──────────┴────────┴────────┘  │
│                                                             │
│  Recent Transactions:                                       │
│  [Stripe payment received BK.08.003 - RM4,500 - 10:30 AM]  │
│  [Manual transfer verified BK.08.001 - RM2,000 - Yesterday] │
└─────────────────────────────────────────────────────────────┘
```

**Actions:**
- "Send Payment Reminder" (email/SMS)
- "Generate Pay Link" (Stripe checkout URL)
- "Verify Manual Transfer" (quick approve receipt upload)
- "Process Refund"

#### **Tab 5: Addon Marketplace** (Upsell Management)
```
┌─────────────────────────────────────────────────────────────┐
│  ADDON MANAGEMENT                                          │
│                                                             │
│  [Create Addon Order]                                      │
│                                                             │
│  Active Addon Orders:                                      │
│  ┌──────────┬──────────┬────────┬──────────┬────────┐     │
│  │Order #   │Booking   │Addon   │Qty       │Amount  │     │
│  ├──────────┼──────────┼────────┼──────────┼────────┤     │
│  │BA.08.001 │BK.08.001 │Spa Pkg │2         │RM500   │     │
│  │BA.08.002 │BK.08.003 │Dinner  │4         │RM200   │     │
│  └──────────┴──────────┴────────┴──────────┴────────┘     │
│                                                             │
│  Available Addons Catalog:                                  │
│  [Excursions] [Insurance] [Transfers] [Other]               │
│  ┌──────────────────────────────────────────────────┐     │
│  │ 🏝️ Island Tour - RM150/pax - [Add to Booking]   │     │
│  │ 💆 Spa Package - RM250/pax - [Add to Booking]    │     │
│  │ 🛡️ Travel Insurance - RM80/pax - [Add to Booking]│     │
│  └──────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────┘
```

---

## 🔧 Backend API Endpoints (booking_hub.py)

```python
@frappe.whitelist()
def get_booking_kanban(filters):
    """Return kanban data grouped by status"""
    
@frappe.whitelist()
def get_booking_detail(booking_name):
    """Full booking data with reservations, payments, addons"""
    
@frappe.whitelist()
def get_cabin_grid(booking_name):
    """Cabin arrangement with traveller assignment"""
    
@frappe.whitelist()
def update_cabin_assignment(reservation_name, stateroom_no, aroya_guest_no):
    """Update stateroom assignment"""
    
@frappe.whitelist()
def bulk_assign_staterooms(booking_name, assignments_list):
    """Batch update from CSV/upload"""
    
@frappe.whitelist()
def get_payment_summary(date_range):
    """Dashboard financial metrics"""
    
@frappe.whitelist()
def send_payment_reminder(booking_name):
    """Trigger reminder email/SMS"""

@frappe.whitelist()
def update_booking_status(booking_name, new_status, reason=None):
    """Status transition with audit log"""
    
@frappe.whitelist()
def get_addon_catalog(trip_name):
    """Available addons for a trip"""
    
@frappe.whitelist()
def create_addon_order(booking_name, addon_items):
    """Create addon order from hub"""
```

---

## 🎨 Design Principles

### 1. **Progressive Disclosure**
- Default view: Simple list/table
- Power user features: Hidden behind "Advanced" toggle or right-click context menu

### 2. **Contextual Actions**
- Actions appear based on booking status (can't "Confirm" a Pending Payment booking)
- Bulk actions available when multiple rows selected

### 3. **Inline Editing**
- Edit traveller name, cabin number, phone without opening modal
- Save on blur or Enter key
- Undo with Ctrl+Z

### 4. **Responsive Sidebar**
- Collapsible detail panel (for wide screens)
- Slide-over panel on mobile/narrow viewports

### 5. **Consistent Iconography**
- Use Tabler Icons (already loaded in base template)
- Status colors: 
  - 🟢 Green = Completed/Paid/Verified
  - 🟡 Yellow = Processing/Partially Paid/Pending  
  - 🔴 Red = Overdue/Rejected/Missing Documents
  - 🔵 Blue = Information/New

---

## 📊 Data Sources (Read-only Aggregation)

| Tab | Primary Doctype | Related Doctypes (fetched via link) |
|-----|----------------|-----------------------------------|
| Queue | Booking | Sales Order, Customer |
| Active | Booking | Booking Reservation, Trip, Trip Group Date, Trip Package |
| Cabins | Booking Reservation | Traveller, Trip Price Category, Rooming Aroya |
| Payment | Sales Order, Payment Entry | Booking, Sales Invoice |
| Addons | Booking Addon Order, Booking Addon | Addon, Addon Package |

**Important**: No modification to existing doctype structures. All writes go through existing API patterns (`booking_engine.py`, `so_helpers.py`).

---

## 🚀 Implementation Phases

### **Phase 1A: Core Structure (Hari 1-2)**
1. Create `booking_hub.js` page skeleton with tab navigation
2. Build shared component library (status badges, action buttons, date formatting)
3. Implement API stub functions in `booking_hub.py`
4. Basic routing with `frappe.router`

### **Phase 1B: Kanban Board (Hari 3-4)**
5. Build Kanban board UI with drag-and-drop (use SortableJS or similar lightweight library)
6. Connect to `get_booking_kanban()` API
7. Implement filters and search
8. Quick action menus on cards

### **Phase 1C: Booking Detail View (Hari 5-7)**
9. Build split-view layout (list + detail panel)
10. Implement 6 sub-tabs in detail panel
11. Inline editing for reservations table
12. Payment timeline visualization

### **Phase 1D: Cabin Grid (Hari 8-9)**
13. Visual cabin card layout
14. Drag-and-drop traveller reassignment between cabins
15. Batch manifest upload feature
16. Document status indicators

### **Phase 1E: Payment & Addons (Hari 10-11)**
17. Payment dashboard with summary cards
18. Payment queue with action buttons
19. Addon catalog browser
20. Quick addon order creation

### **Phase 1F: Polish & Testing (Hari 12-14)**
21. Keyboard shortcuts (Ctrl+F search, Ctrl+N new booking, etc.)
22. Notification integration (show alerts for overdue items)
23. Permission checks (Tour Manager vs Tour Operator role visibility)
24. Cross-browser testing + mobile responsive adjustments
25. Documentation (user guide + developer docs)

---

## ✅ Success Criteria

1. **Reduced Clicks**: Common tasks (check booking status, assign cabin, send reminder) reduced from 5-8 clicks to 1-2 clicks
2. **Single Source of Truth**: Operator doesn't need to open multiple tabs/doctypes for one booking
3. **No Data Migration**: Works with existing 44 doctypes without schema changes
4. **Performance**: Page loads < 2 seconds, tab switches < 500ms
5. **Mobile Accessible**: Core views usable on tablet (1024px+)

---

## 📌 Scope Boundaries (What's NOT Included)

- ❌ Doctype merging/schema changes (UI consolidation only)
- ❌ Portal migration (/traveller vs /traveller_portal)
- ❌ Mobile app API (future consideration)
- ❌ Analytics dashboard (separate Phase 2 page)
- ❌ Website Studio changes (separate Phase 2 page)
- ❌ Flight Request workflow enhancement (separate Phase 2 page)

---

## 🔄 Rollback Plan

If issues arise:
1. Rename `booking_hub.js` → `booking_hub.js.disabled`
2. Remove page entry from `hooks.py` (if added)
3. All existing workflows remain functional via original doctype forms
4. Zero data risk - new page is read-write through existing APIs

---

## 📝 Deliverables

1. **booking_hub.js** - Main page application (~1000 lines)
2. **booking_hub.css** - Scoped styles (~300 lines)
3. **booking_hub.py** - Backend API module (~400 lines)
4. **User Guide** - PDF/video tutorial for tour operators
5. **Changelog** - Documented API endpoints and permissions