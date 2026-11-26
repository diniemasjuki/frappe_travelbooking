# travel_booking/utils/image_optimize.py
# Optimisasi imej PUBLIC yang di-upload ke mana-mana form Travel Booking
# (galeri trip, cover photo, meta OG, day image itinerary): resize ke had
# sisi panjang + mampat semula. Fail PRIVATE (passport, resit, dokumen)
# TIDAK disentuh — aliran dokumen portal ada normalisasi sendiri di
# upload_normalize.py.
# Dipasang sebagai doc_events File.after_insert (hooks.py) — setiap
# upload = rekod File baharu, jadi after_insert cukup; edit Desk yang
# ganti fail turun mencipta rekod baharu.
# ─────────────────────────────────────────────────────────────────────

import io
import os

import frappe
from PIL import Image, ImageOps

# Had sisi panjang — cukup untuk hero/web pada skrin retina; foto telefon
# moden (4000px+) diturunkan ke saiz ini.
MAX_EDGE = 1920
# Kualiti re-encode JPEG/WebP — sweet spot saiz vs kualiti untuk web.
QUALITY = 85
# Bawah saiz ini fail sudah kecil — jangan proses (jimat CPU, elak
# re-encode sia-sia ikon/thumbnail).
MIN_BYTES = 64 * 1024
# Format yang diproses — SVG (vector) & GIF (beranimasi) dilangkau.
_OK_EXTS = (".jpg", ".jpeg", ".png", ".webp")


def optimize_public_image(doc, method=None):
	"""Hook File.after_insert — resize & mampat imej PUBLIC yang disimpan
	lokal. Gagal optimisasi TIDAK PERNAH membatalkan upload — fail asal
	kekal diguna (log ralat sahaja)."""
	if doc.is_private:
		return
	ext = os.path.splitext(doc.file_name or doc.file_url or "")[1].lower()
	if ext not in _OK_EXTS:
		return
	if (doc.file_size or 0) < MIN_BYTES:
		return
	try:
		path = doc.get_full_path()
		# URL luar (S3/CDN) bukan path lokal — biarkan.
		if not path or not os.path.isfile(path):
			return
		with open(path, "rb") as f:
			original = f.read()
		optimized = _optimize(original, ext)
	except Exception:
		frappe.log_error(
			title="Image Optimize Failed",
			message=f"{doc.file_url or doc.file_name}: {frappe.get_traceback()}",
		)
		return
	if not optimized or len(optimized) >= len(original):
		# Tiada penjimatan — kekalkan fail asal.
		return
	with open(path, "wb") as f:
		f.write(optimized)
	# file_size kekal selari dengan kandungan sebenar (list view & kuota).
	doc.db_set("file_size", len(optimized))


def _optimize(data: bytes, ext: str) -> bytes | None:
	"""Resize (max sisi panjang MAX_EDGE) + mampat semula. Orientasi EXIF
	diaplikasi ke piksel dahulu — EXIF (GPS/kamera) terbuang sekali gus."""
	img = Image.open(io.BytesIO(data))
	img = ImageOps.exif_transpose(img)
	if max(img.size) > MAX_EDGE:
		img.thumbnail((MAX_EDGE, MAX_EDGE), Image.Resampling.LANCZOS)
	buf = io.BytesIO()
	if ext in (".jpg", ".jpeg"):
		img.convert("RGB").save(buf, "JPEG", quality=QUALITY,
			optimize=True, progressive=True)
	elif ext == ".png":
		# Format PNG dikekalkan (transparan dijaga) — resize + optimize sahaja.
		img.save(buf, "PNG", optimize=True)
	else:  # .webp
		img.save(buf, "WEBP", quality=QUALITY, method=6)
	return buf.getvalue()
