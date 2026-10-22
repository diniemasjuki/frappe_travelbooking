# Copyright (c) 2026, WargaPrihatin and Contributors
# See license.txt

"""Integration test untuk save_booking_traveller mod GABUNGAN
(sections="passport,contact,health" + confirm=1).

Regression test isu "emel 3–4 kali untuk 1 submission": borang satu
page dahulu memanggil endpoint 3 kali berturutan (satu per section
wizard lama) + confirm berasingan — setiap tvl.save() memicu
notification event "Save" → traveller terima emel berulang untuk SATU
submission. Mod gabungan mesti menulis dokumen Traveller SEKALI sahaja
per submission — diukur dengan mengintip BaseDocument.db_insert /
db_update (primitif tulis terendah), bukan kiraan Version yang tak
dijana dalam mod ujian.

Turut diselamatkan: mod legasi satu-section (parameter `section`)
kekal berfungsi dan tidak memadam medan section lain; confirm=1 dengan
maklumat tak lengkap gagal bersih TANPA sebarang tulisan.

NOTA infrastruktur: save_booking_traveller mengandungi
frappe.db.commit() dalaman yang memecahkan isolasi transaksi ujian
(data yang ter-commit kekal walaupun class teardown rollback). Maka:
- notification Traveller dilumpuhkan sepanjang setiap test dan
  dipulihkan semula dalam cleanup — tiada emel/Communication ujian;
- SEMUA dokumen ujian dipadam secara eksplisit dalam cleanup.
"""

import re
from contextlib import contextmanager
from unittest.mock import patch

import frappe
from frappe.model.base_document import BaseDocument
from frappe.tests import IntegrationTestCase
from frappe.utils import add_days, now_datetime

from travel_booking.api.portal_traveller import save_booking_traveller

PNG_1PX = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhf"
    "DwAChwGA60e6kgAAAABJRU5ErkJggg=="
)

FULL_SUBMIT = dict(
    sections="passport,contact,health",
    confirm=1,
    first_name="Testfirst",
    last_name="Testlast",
    gender="Male",
    date_of_birth="1999-01-01",
    nationality="Malaysia",
    passport_no="TT1234567",
    passport_expiry="2030-06-30",
    email="rc.unittest@example.com",
    phone="+60123456789",
    emergency_contact_name="Ec Contact",
    emergency_contact_phone="+60129876543",
    emergency_contact_relationship="Spouse",
    address_line1="1 Jalan Ujian",
    city="Kuala Lumpur",
    postcode="50000",
    state="Wilayah Persekutuan",
    country="Malaysia",
    dietary_requirements="Vegetarian",
    wheelchair_assistant="Not Required",
    pdpa_consent=True,
)


class TestSaveBookingTravellerUnified(IntegrationTestCase):
    def setUp(self):
        ts = now_datetime().strftime("%H%M%S%f")
        self.bk_num = "RCUNIT-" + ts
        self.ic = "99010101" + ts[:4]
        self.token = "rcunit-token-" + ts
        self._ics = [self.ic]
        self._travellers = []

        bk = frappe.get_doc(
            {"doctype": "Booking", "naming_series": "BK.26.10", "booking_number": self.bk_num}
        ).insert(ignore_permissions=True)
        self.booking = bk.name
        self.slot = frappe.get_doc(
            {
                "doctype": "Booking Reservation",
                "naming_series": "." + bk.name + ".-.#",
                "booking": bk.name,
                "passport_link_token": self.token,
                "passport_link_email": "rc.unittest@example.com",
                "passport_link_expires_on": add_days(now_datetime(), 1),
            }
        ).insert(ignore_permissions=True).name

        # Lumpuhkan notification Traveller sepanjang test (commit dalaman
        # API akan flush nilai ini; dipulihkan dalam cleanup).
        self._notif_states = {
            n.name: n.enabled
            for n in frappe.get_all(
                "Notification", filters={"document_type": "Traveller"}, fields=["name", "enabled"]
            )
        }
        for name, enabled in self._notif_states.items():
            if enabled:
                frappe.db.set_value("Notification", name, "enabled", 0)

        self.addCleanup(self._cleanup_test_data)

    def _cleanup_test_data(self):
        for tvl in list(self._travellers) + frappe.get_all(
            "Traveller", filters={"ic_number": ["in", self._ics]}, pluck="name"
        ):
            if not frappe.db.exists("Traveller", tvl):
                continue
            for f in frappe.get_all(
                "File",
                filters={"attached_to_doctype": "Traveller", "attached_to_name": tvl},
                pluck="name",
            ):
                if frappe.db.exists("File", f):
                    frappe.delete_doc("File", f, ignore_permissions=True, force=True)
            frappe.db.delete("Comment", {"reference_doctype": "Traveller", "reference_name": tvl})
            frappe.db.delete("Version", {"ref_doctype": "Traveller", "docname": tvl})
            frappe.delete_doc("Traveller", tvl, ignore_permissions=True, force=True)
        if frappe.db.exists("Booking Reservation", self.slot):
            frappe.delete_doc("Booking Reservation", self.slot, ignore_permissions=True, force=True)
        if frappe.db.exists("Booking", self.booking):
            frappe.delete_doc("Booking", self.booking, ignore_permissions=True, force=True)
        for name, enabled in self._notif_states.items():
            frappe.db.set_value("Notification", name, "enabled", enabled)
        frappe.db.commit()

    def _submit(self, **override):
        payload = dict(
            FULL_SUBMIT,
            booking_number=self.bk_num,
            slot_name=self.slot,
            ic_number=self.ic,
            guest_token=self.token,
        )
        payload.update(override)
        r = save_booking_traveller(**payload)
        if r.get("traveller_id") and r["traveller_id"] not in self._travellers:
            self._travellers.append(r["traveller_id"])
        return r

    @contextmanager
    def _spy_traveller_writes(self):
        """Kira tulisan DB sebenar ke dokumen Traveller (db_insert /
        db_update ialah primitif terendah — tak tertipu dengan laluan
        save/insert yang berbeza, dan tak bergantung pada Version)."""
        counts = {"db_insert": 0, "db_update": 0}
        orig = {name: getattr(BaseDocument, name) for name in counts}

        def _make(name):
            original = orig[name]

            def spy(self, *args, **kwargs):
                if self.doctype == "Traveller":
                    counts[name] += 1
                return original(self, *args, **kwargs)

            return spy

        with patch.object(BaseDocument, "db_insert", _make("db_insert")), patch.object(
            BaseDocument, "db_update", _make("db_update")
        ):
            yield counts

    def test_unified_submit_writes_once_and_data_complete(self):
        with self._spy_traveller_writes() as counts:
            r = self._submit(filedata=PNG_1PX, filename="passport.png")

        # SATU tulisan sahaja untuk SATU submission gabungan.
        self.assertEqual(counts, {"db_insert": 1, "db_update": 0})

        self.assertEqual(r["status"], "ok")
        self.assertTrue(r["confirmed"])
        self.assertEqual(r["sections"], ["passport", "contact", "health"])
        tvl = r["traveller_id"]

        # KETIGA-TIGA section tersimpan pada SATU dokumen.
        t = frappe.db.get_value(
            "Traveller",
            tvl,
            [
                "full_name", "ic_number", "passport_no", "email", "phone",
                "emergency_contact_name", "address_line1", "city",
                "dietary_requirements", "wheelchair_assistant", "status",
                "passport_image",
            ],
            as_dict=True,
        )
        self.assertEqual(t.full_name, "TESTFIRST TESTLAST")
        self.assertEqual(t.ic_number, self.ic)
        self.assertEqual(t.passport_no, "TT1234567")
        self.assertEqual(t.email, "rc.unittest@example.com")
        self.assertEqual(re.sub(r"\D", "", t.phone or ""), "60123456789")
        self.assertEqual(t.emergency_contact_name, "EC CONTACT")
        self.assertEqual(t.address_line1, "1 Jalan Ujian")
        self.assertEqual(t.dietary_requirements, "Vegetarian")
        self.assertEqual(t.wheelchair_assistant, "Not Required")
        self.assertEqual(t.status, "Incomplete")
        self.assertTrue(t.passport_image)

        # Email di-set semasa INSERT — notification event "New" (Passport
        # Registration) mempunyai recipient pada saat insert (fix lama:
        # email hanya diisi pada save contact kedua selepas insert).
        self.assertEqual(t.email, "rc.unittest@example.com")

        # Slot ter-link + comment audit PDPA & confirm direkodkan.
        slot = frappe.db.get_value(
            "Booking Reservation", self.slot, ["traveller", "document_status"], as_dict=True
        )
        self.assertEqual(slot.traveller, tvl)
        self.assertEqual(slot.document_status, "Incomplete")
        comments = frappe.get_all(
            "Comment",
            filters={"reference_doctype": "Traveller", "reference_name": tvl},
            pluck="content",
        )
        self.assertTrue(any("PDPA consent granted" in c for c in comments))
        self.assertTrue(any("confirmed complete" in c for c in comments))

    def test_unified_update_writes_once(self):
        tvl = self._submit(filedata=PNG_1PX, filename="passport.png")["traveller_id"]

        with self._spy_traveller_writes() as counts:
            r2 = self._submit(passport_no="TT7654321", passport_expiry="2031-06-30")

        # Submission kedua (update) — masih SATU tulisan, traveller sama.
        self.assertEqual(r2["traveller_id"], tvl)
        self.assertEqual(counts, {"db_insert": 0, "db_update": 1})
        self.assertEqual(frappe.db.get_value("Traveller", tvl, "passport_no"), "TT7654321")

    def test_legacy_single_section_keeps_other_sections_intact(self):
        tvl = self._submit(filedata=PNG_1PX, filename="passport.png")["traveller_id"]

        with self._spy_traveller_writes() as counts:
            r = self._submit(
                sections="",
                section="contact",
                email="rc.unittest2@example.com",
                phone="+60198887766",
                emergency_contact_name="Ec Baru",
                emergency_contact_phone="+60123456789",
                emergency_contact_relationship="Friend",
                address_line1="2 Jalan Baru",
                city="Shah Alam",
                postcode="40000",
                state="Selangor",
                country="Malaysia",
            )
        self.assertEqual(r["status"], "ok")
        self.assertEqual(counts, {"db_insert": 0, "db_update": 1})

        t = frappe.db.get_value(
            "Traveller", tvl, ["passport_no", "email", "wheelchair_assistant"], as_dict=True
        )
        self.assertEqual(t.passport_no, "TT1234567")  # passport tak disentuh
        self.assertEqual(t.email, "rc.unittest2@example.com")
        self.assertEqual(t.wheelchair_assistant, "Not Required")  # health tak disentuh

    def test_confirm_incomplete_fails_without_any_write(self):
        ic_orphan = "88020202" + self.ic[-4:]
        self._ics.append(ic_orphan)

        with self._spy_traveller_writes() as counts:
            with self.assertRaises(frappe.ValidationError):
                self._submit(
                    ic_number=ic_orphan,
                    sections="passport",
                    confirm=1,
                    first_name="Kosong",
                    last_name="Setengah",
                    email="",
                    phone="",
                    emergency_contact_name="",
                    emergency_contact_phone="",
                    emergency_contact_relationship="",
                    address_line1="",
                    city="",
                    postcode="",
                    state="",
                    country="",
                    dietary_requirements="",
                    filedata=PNG_1PX,
                    filename="passport.png",
                )

        # Gagal bersih — tiada tulisan Traveller langsung.
        self.assertEqual(counts, {"db_insert": 0, "db_update": 0})
        self.assertFalse(frappe.db.exists("Traveller", {"ic_number": ic_orphan}))
