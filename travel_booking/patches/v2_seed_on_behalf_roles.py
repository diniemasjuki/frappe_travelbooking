"""Seed senarai role on-behalf (Travel Settings > On-Behalf Booking Roles)
dengan default semasa fasa 1 modul booking-channel:

  - Affiliate (role dicipta oleh app 'affiliate')  -> channel "Affiliate"
  - Sales User (role standard ERPNext staf jualan) -> channel "Staff"

Behavior fasa 1 asal hardcoded role ini dalam resolve_booking_actor(); kini
senarai di Travel Settings jadi sumber kebenaran dan SENARAI KOSONG bermakna
ciri on-behalf dimatikan sepenuhnya. Patch ni menjamin baris default wujud
sebaik selepas migrate supaya kelakuan sedia ada (checkbox on-behalf di
wizard untuk Affiliate/Sales User) tidak berubah selepas upgrade.

Idempotent: hanya seed bila senarai kosong; admin boleh sunting lepas tu
(tambah/buang role) tanpa patch menimpa semula.
"""

import frappe

DEFAULT_ROLES = [
    {"role": "Affiliate", "booking_channel": "Affiliate"},
    {"role": "Sales User", "booking_channel": "Staff"},
]


def execute():
    # Role "Affiliate" wujud hanya bila app 'affiliate' dipasang — jangan
    # seed baris yang merujuk role tak wujud (Link validation akan gagal).
    existing_roles = set(frappe.get_all("Role", pluck="name"))

    ts = frappe.get_doc("Travel Settings")
    if ts.on_behalf_roles:
        return  # admin dah konfigurasi — jangan sentuh

    for row in DEFAULT_ROLES:
        if row["role"] not in existing_roles:
            continue
        ts.append("on_behalf_roles", row)

    ts.flags.ignore_permissions = True
    ts.save()
