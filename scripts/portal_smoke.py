#!/usr/bin/env python3
# travel_booking/scripts/portal_smoke.py
#
# SMOKE SUITE PASCA-MIGRATE (Lapisan 4) — verifikasi perimeter portal
# selepas SETIAP migrate/update ERPNext/app, SEBELUM customer menyentuh
# sistem. Rangka kerja "Kestabilan & Keselamatan Portal" (Varian B:
# endpoint-sahaja — tiada has_permission hook; stabiliti dijaga oleh
# suite ini + audit perimeter scripts/portal_perimeter_check.py).
#
# APA DIAUJI (semua GET — tiada CSRF, tiada penulisan, idempoten):
#   A. Login portal (customer ujian)
#   B. Halaman portal: /traveller, booking/travellers/billing per ref
#   C. Endpoint perimeter utama (get_booking_data dsb.) — 200 + shape
#   D. NEGATIF — IDOR: booking MILIK ORANG LAIN mesti DITOLAK (403)
#   E. NEGATIF — Varian B: /api/resource/Sales Order/<SO sendiri> mesti
#      403 (permukaan REST doctype kekal tertutup untuk customer)
#   F. Halaman awam: /booknow, /trips (guest)
#
# GUNA (rujuk DEPLOY_RUNBOOK.md untuk penyediaan data ujian):
#   python3 scripts/portal_smoke.py \
#     --base-url https://dev.rpwp.my \
#     --portal-user customer@test.test --portal-pw 'xxx' \
#     --booking-ref RC123456 [--other-booking-ref RC999999]
#
# Keluar: senarai PASS/FAIL + exit code bukan sifar bila ada kegagalan.
# Keperluan: python3 + requests (pip install requests).

import argparse
import json
import sys

import requests

PASS, FAIL = 0, 0
FAILURES = []


def check(label, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  PASS  {label}")
    else:
        FAIL += 1
        FAILURES.append(f"{label} — {detail}")
        print(f"  FAIL  {label}  {detail}")


def api_get(sess, base, method, **params):
    """GET /api/method/<method>?params — pulangkan (status, json_or_none)."""
    url = base.rstrip("/") + "/api/method/" + method
    r = sess.get(url, params=params, timeout=30)
    try:
        return r.status_code, r.json()
    except Exception:
        return r.status_code, None


def main():
    ap = argparse.ArgumentParser(description="Portal smoke suite pasca-migrate (Lapisan 4)")
    ap.add_argument("--base-url", required=True, help="cth https://dev.rpwp.my")
    ap.add_argument("--portal-user", required=True, help="emel user portal customer UJIAN")
    ap.add_argument("--portal-pw", required=True)
    ap.add_argument("--booking-ref", required=True,
                    help="booking_number (RC...) MILIK user portal ujian")
    ap.add_argument("--other-booking-ref", default="RC000000",
                    help="booking_number MILIK ORANG LAIN (ujian negatif IDOR)")
    args = ap.parse_args()
    base = args.base_url.rstrip("/")

    s = requests.Session()
    s.headers.update({"Accept": "application/json"})

    print(f"═ Portal Smoke Suite — {base} ═")

    # ── A. Login ─────────────────────────────────────────────────────
    r = s.post(base + "/api/method/login",
               data={"usr": args.portal_user, "pwd": args.portal_pw}, timeout=30)
    check("A1 login portal", r.status_code == 200, f"HTTP {r.status_code}")

    # ── B. Halaman portal (redirect ke /login = sesi rosak) ─────────
    # B1: /traveller me-redirect sah ke /traveller/bookings untuk user
    # login — ikut redirect, sahkan destinasi BUKAN /login.
    for label, path, follow in [
        ("B1 /traveller", "/traveller", True),
        ("B2 booking detail", f"/traveller/booking?ref={args.booking_ref}", False),
        ("B3 travellers", f"/traveller/travellers?ref={args.booking_ref}", False),
        ("B4 billing", f"/traveller/billing?ref={args.booking_ref}", False),
        ("B5 addons", f"/traveller/booking_addons?booking={args.booking_ref}", False),
    ]:
        r = s.get(base + path, timeout=30, allow_redirects=follow)
        ok = r.status_code == 200 and "/login" not in r.url
        check(label, ok, f"HTTP {r.status_code}, url: {r.url[:80]}")

    # ── C. Endpoint perimeter (shape minimum) ────────────────────────
    st, j = api_get(s, base, "travel_booking.api.portal_booking.get_booking_data",
                    booking_number=args.booking_ref)
    booking = (j or {}).get("message") or {}
    ok = st == 200 and booking.get("booking") and "slots" in booking
    check("C1 get_booking_data", ok, f"HTTP {st}, keys: {list(booking)[:5]}")

    so_name = ""
    pay = booking.get("payment") or {}
    so_list = pay.get("so_list") or []
    if so_list:
        so_name = so_list[0].get("name") or ""
    check("C2 SO ditemui dalam payload", bool(so_name),
          "tiada SO aktif — guna booking berbayar untuk smoke penuh")

    st, _ = api_get(s, base, "travel_booking.api.pricing.get_payment_settings")
    check("C3 get_payment_settings", st == 200, f"HTTP {st}")

    st, j = api_get(s, base, "travel_booking.api.addon_manager.get_available_addons",
                    booking_number=args.booking_ref)
    ok = st in (200, 417)  # 417 = validation biasa (cth booking belum aktif)
    check("C4 get_available_addons (200/417 ok)", ok, f"HTTP {st}")

    # ── D. NEGATIF — IDOR ────────────────────────────────────────────
    st, j = api_get(s, base, "travel_booking.api.portal_booking.get_booking_data",
                    booking_number=args.other_booking_ref)
    denied = st in (403, 404) or (j or {}).get("exc_type") in (
        "PermissionError", "DoesNotExistError", "ValidationError")
    check("D1 booking orang LAIN ditolak", denied, f"HTTP {st}")

    # ── E. NEGATIF — Varian B (REST doctype kekal tertutup) ──────────
    if so_name:
        r = s.get(base + "/api/resource/Sales Order/" + so_name, timeout=30)
        check("E1 /api/resource/Sales Order → 403 (Varian B)",
              r.status_code in (403, 404), f"HTTP {r.status_code}")
        r = s.get(base + f"/api/resource/Payment Entry?filters={{}}", timeout=30)
        check("E2 /api/resource/Payment Entry list → 403 (Varian B)",
              r.status_code in (401, 403), f"HTTP {r.status_code}")
    else:
        print("  SKIP E (tiada SO — jalankan dengan booking berbayar)")

    # ── F. Halaman awam (tanpa login) ────────────────────────────────
    g = requests.Session()
    for label, path in [("F1 /booknow (guest)", "/booknow"),
                        ("F2 /trips (guest)", "/trips")]:
        r = g.get(base + path, timeout=30, allow_redirects=False)
        check(label, r.status_code == 200, f"HTTP {r.status_code}")

    # ── Ringkasan ────────────────────────────────────────────────────
    print(f"\n{'═' * 40}\nKeputusan: {PASS} PASS, {FAIL} FAIL")
    if FAILURES:
        print("\nKegagalan:")
        for f in FAILURES:
            print(f"  • {f}")
        print("\nTINDAKAN: jangan buka portal kepada customer. Rujuk DEPLOY_RUNBOOK.md.")
        sys.exit(1)
    print("Perimeter portal SIHAT — sistem selalu dibuka.")
    sys.exit(0)


if __name__ == "__main__":
    main()
