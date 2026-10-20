# travel_booking/utils/upload_normalize.py
# Standardisasi upload fail portal (SEMUA form — traveller, resit manual
# payment, booking wizard):
#   1. Sahkan jenis fail daripada MAGIC BYTES (bukan nama/extension).
#   2. PDF → render halaman 1 ke PNG (PyMuPDF) supaya semua lampiran
#      disimpan sebagai IMEJ — preview <img>, paparan Desk dan matching
#      dhash/sha beroperasi atas format yang sama di merata sistem.
# Dipakai oleh: portal_traveller (passport/visa), portal_payment (resit
# manual portal), so_helpers (resit booking wizard).
# ─────────────────────────────────────────────────

import base64
import re

import frappe


def _detect_file_kind(content: bytes) -> str | None:
    """Jenis fail dari MAGIC BYTES — 'jpeg' | 'png' | 'pdf' | None.
    Nama fail/extension TIDAK dipercayai (upload portal boleh menghantar
    apa saja tanpa extension yang betul)."""
    if content[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if content[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if content[:5] == b"%PDF-":
        return "pdf"
    return None


def _pdf_to_image(content: bytes, target_width: int = 2200) -> bytes | None:
    """Render halaman pertama PDF (halaman bio-data passport / resit) ke
    PNG — PyMuPDF (fitz, sudah ada dalam bench env, tiada binary sistem).
    Lebar dihadkan supaya token AI & masa OCR terkawal. Return None bila
    PDF rosak/terlindung kata laluan — caller throw mesej jelas."""
    try:
        import fitz  # PyMuPDF

        with fitz.open(stream=content, filetype="pdf") as doc:
            page = doc.load_page(0)
            zoom = max(1.0, min(4.0, target_width / max(page.rect.width, 1)))
            pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
            return pix.tobytes("png")
    except Exception:
        return None


def _pdf_extract_text(content: bytes, max_pages: int = 3) -> str:
    """Teks TERBENAM PDF (text layer) — halaman 1 hingga max_pages.
    Kosong untuk PDF hasil scan (image-only, tiada text layer); untuk
    PDF digital (e-issued) teks ini adalah aksara TEPAT dokumen —
    fast-path extraction tanpa OCR."""
    try:
        import fitz

        parts = []
        with fitz.open(stream=content, filetype="pdf") as doc:
            for i in range(min(doc.page_count, max_pages)):
                parts.append(doc.load_page(i).get_text() or "")
        return "\n".join(parts)
    except Exception:
        return ""


def _decode_and_normalize_upload(filedata: str, filename: str, label: str = "document") -> tuple:
    """Decode base64 upload portal + sahkan jenis fail (JPG/PNG/PDF via
    magic bytes — bukan nama fail). PDF → render halaman 1 ke PNG supaya
    preview borang (<img>), matching dhash/sha dan paparan Desk sentiasa
    beroperasi atas IMEJ. `label` (cth "document" / "receipt") dipakai
    dalam mesej ralat. Return (content_bytes, filename)."""
    if "," in filedata:
        filedata = filedata.split(",", 1)[1]
    try:
        content = base64.b64decode(filedata)
    except Exception:
        frappe.throw("Invalid file data.")
    kind = _detect_file_kind(content)
    if not kind:
        frappe.throw("Please upload a JPG, PNG, or PDF file.")
    if kind == "pdf":
        rendered = _pdf_to_image(content)
        if not rendered:
            frappe.throw(
                "This PDF could not be processed — please upload a clear "
                f"JPG or PNG image of the {label} instead."
            )
        stem = re.sub(r"\.[^.]+$", "", (filename or "document"))
        return rendered, f"{stem}_page1.png"
    return content, filename
