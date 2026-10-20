"""Konfigurasi semula kewibadaan on-behalf selepas bypass hardcoded
STAFF_BOOKING_ROLES dibuang (revoked 2026-10-19).

Latar belakang: sebelum ni (System Manager, Tour Manager, Tour Operator,
Accounts User) diberi akses PENUH ke SEMUA booking melalui senarai
hardcoded — baris On-Behalf Booking Roles di Travel Settings tidak
berkesan untuk role yang sama. Kini skop didayakan sepenuhnya oleh
Travel Settings melalui field baharu Travel On Behalf Role.access_scope:

  - "Own Bookings" (default) — HANYA booking yang user tempah sendiri
    bagi pihak customer (Booking.booked_by = user, channel != Direct).
  - "All Bookings" — SEMUA booking; tindakan tetap dikawal oleh
    access_level role.

Patch ni menetapkan keputusan operasi semasa pada baris sedia ada:

  - Tour Manager  -> scope "All Bookings", level kekal "Full"
    (mengurus semua booking).
  - Tour Operator -> scope "All Bookings", level "View" (lihat semua
    booking sahaja — tindakan dinegafikan oleh on_behalf_level_ok).
  - Baris lain (cth. Affiliate) -> scope "Own Bookings" (default —
    kekal terkurung pada booking yang ditempah sendiri).

Idempotent: hanya melengkapkan baris yang access_scope-nya kosong
(rekod lama sebelum field wujud) mengikut nama role; baris yang admin
dah set secara eksplisit tidak ditimpa.
"""

import frappe

ROLE_SCOPE = {
    "Tour Manager":  {"access_scope": "All Bookings"},
    "Tour Operator": {"access_scope": "All Bookings", "access_level": "View"},
}


def execute():
    ts = frappe.get_doc("Travel Settings")
    changed = False

    for row in (ts.get("on_behalf_roles") or []):
        # Backfill default — baris tanpa scope (rekod lama) dianggap
        # "Own Bookings" oleh get_on_behalf_role_rows(); tulis nilai
        # itu secara eksplisit supaya Desk papar pilihan sebenar.
        if not row.access_scope:
            row.access_scope = "Own Bookings"
            changed = True
        decision = ROLE_SCOPE.get(row.role)
        if decision and row.access_scope != decision["access_scope"]:
            row.access_scope = decision["access_scope"]
            changed = True
        if decision and decision.get("access_level") and \
                row.access_level != decision["access_level"]:
            row.access_level = decision["access_level"]
            changed = True

    if changed:
        ts.flags.ignore_permissions = True
        ts.save()
