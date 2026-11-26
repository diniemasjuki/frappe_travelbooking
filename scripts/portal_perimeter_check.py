#!/usr/bin/env python3
# travel_booking/scripts/portal_perimeter_check.py
#
# PERIMETER AUDIT (Varian B — endpoint-sahaja) — lint statik yang mengesan
# laluan akses LANGSUNG ke doctype ERPNext (SO/PE/SI/PR/Proforma/File)
# dari kod sisi client portal. Prinsip perimeter: portal customer hanya
# bercakap dengan endpoint whitelisted travel_booking.api.* yang (a)
# mengesahkan pemilikan secara manual dan (b) memulangkan unjuran selamat.
#
# Corak yang DILARANG dalam JS/HTML portal (public/js + www):
#   1. /api/resource/...            — REST doctype (permission matrix ERPNext)
#   2. frappe.client.get / get_list / get_value / insert / set_value
#                                   — wrapper REST yang sama
#   3. /api/method/frappe.client... — sama, laluan method
#   4. /files/... (href/src dibina dari file_url medan DB) — muat turun fail
#                                   standard menyemak kebenaran doctype pemilik
#   5. /print?... / download_pdf    — cetakan standard menyemak kebenaran baca
#   6. frappe.utils.file_manager    — endpoint fail standard
#
# Pengecualian yang dibenarkan (wilayah BUKAN portal):
#   - public/js/trip_detail.js, booknow.js, cruise_schedule.js, analytics.js:
#     halaman AWAM (guest) yang sengaja membaca katalog awam — tetap
#     dikecualikan corak 4/5 sahaja jika melibatkan fail AWAM (cover_image
#     dll). Corak 1-3 tetap dilarang merata.
#   - rujukan dalam komen / string dokumentasi (dikesan via heuristik ringkas —
#     baris yang bermula dengan // atau * diabaikan).
#
# Guna:  python3 scripts/portal_perimeter_check.py [--root <path>]
# Keluar: senarai penemuan (file:line) + ringkasan; exit code 1 bila ada
# penemuan KRITIKAL (corak 1-3) — sedia untuk CI/pre-deploy gate.

import argparse
import re
import sys
from pathlib import Path

# Corak kritikal — akses REST doctype terus
CRITICAL_PATTERNS = [
    (re.compile(r"""["'/]api/resource/"""), "REST /api/resource/ terus"),
    (re.compile(r"""\bfrappe\.client\.(get|get_list|get_value|insert|set_value|delete)\b"""),
     "frappe.client.* (REST doctype)"),
    (re.compile(r"""/api/method/frappe\.client\."""), "method frappe.client terus"),
]

# Corak amaran — fail/cetak standard (bergantung kebenaran doctype pemilik)
WARN_PATTERNS = [
    (re.compile(r"""["'](/files/|file_url)"""), "URL fail mentah /file_url"),
    (re.compile(r"""/print\?|download_pdf|/api/method/frappe\.utils\.print_format"""),
     "cetakan standard (kebenaran baca doctype)"),
    (re.compile(r"""frappe\.utils\.file_manager|download_file"""), "endpoint fail standard"),
]

# Wilayah yang diaudit (JS portal + HTML portal)
AUDIT_GLOBS = ["public/js/*.js", "www/**/*.html"]

# JS halaman awam (katalog trip) — corak fail awam dibenarkan; corak REST
# kekal dilarang. (booknow.js ada /api/method/travel_booking sahaja —
# dibenarkan kerana endpoint allow_guest milik kita.)
PUBLIC_PAGE_JS = {"trip_detail.js", "cruise_schedule.js", "analytics.js",
                  "affiliate_capture.js"}

SKIP_LINE = re.compile(r"""^\s*(//|\*|/\*|<!--)""")  # komen


def iter_files(root: Path):
    for pattern in AUDIT_GLOBS:
        for f in root.glob(pattern):
            if f.is_file():
                yield f


def audit(root: Path):
    findings = []
    for f in iter_files(root):
        rel = str(f.relative_to(root))
        is_public_page = f.name in PUBLIC_PAGE_JS
        try:
            lines = f.read_text(encoding="utf-8", errors="replace").splitlines()
        except Exception:
            continue
        for i, line in enumerate(lines, 1):
            if SKIP_LINE.match(line):
                continue
            for pat, label in CRITICAL_PATTERNS:
                if pat.search(line):
                    findings.append(("CRITICAL", rel, i, label, line.strip()[:120]))
            if is_public_page:
                continue  # fail awam dibenarkan untuk corak amaran
            for pat, label in WARN_PATTERNS:
                if pat.search(line):
                    findings.append(("WARN", rel, i, label, line.strip()[:120]))
    return findings


def main():
    ap = argparse.ArgumentParser(description="Portal perimeter audit (Varian B)")
    ap.add_argument("--root",
                    default=str(Path(__file__).resolve().parent.parent / "travel_booking"),
                    help="Root PAKET travel_booking (default: <repo>/travel_booking)")
    args = ap.parse_args()
    root = Path(args.root).resolve()
    if not (root / "public" / "js").is_dir():
        print(f"RALAT: {root} bukan root pakej (tiada public/js). Guna --root <repo>/travel_booking")
        sys.exit(2)

    findings = audit(root)
    crit = [f for f in findings if f[0] == "CRITICAL"]
    warn = [f for f in findings if f[0] == "WARN"]

    for sev, rel, line, label, text in findings:
        print(f"[{sev}] {rel}:{line} — {label}")
        print(f"       {text}")

    print(f"\nRingkasan: {len(crit)} kritikal, {len(warn)} amaran")
    if crit:
        print("GAGAL — laluan langsung ke doctype ERPNext mesti ditukar ke endpoint perimeter.")
        sys.exit(1)
    print("LULUS — perimeter endpoint-sahaja terpelihara.")
    sys.exit(0)


if __name__ == "__main__":
    main()
