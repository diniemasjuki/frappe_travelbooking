/* ══════════════════════════════════════════════════════════════════
   TravelBookingSearchBox — PAKEJ KOTAK CARIAN STANDARD (global)
   ══════════════════════════════════════════════════════════════════
   Komponen boleh guna semula untuk SEMUA kotak carian app travel_
   booking (page admin, pakej senarai, modal). Dimuatkan global
   melalui hooks.app_include_js — tersedia sebagai
   window.TravelBookingSearchBox di mana-mana desk, tanpa include.

   Antara muka standard:
   • Markup  : <span class="mba-searchwrap">
                   <input type="text" … />
                   <button class="mba-search-clear" hidden>✕</button>
               </span>
   • Tingkah : butang ✕ tampak HANYA bila input berisi; klik ✕ =
               kosongkan input + trigger 'input' (handler carian
               sedia ada berjalan semula) + fokus semula.
   • Auto-bind: handler input/klik diikat SEKALI pada document —
               mana-mana markup standard di atas berfungsi serta-merta
               tanpa wiring tambahan.

   API
   ───
   • html(opts)               → string HTML wrap standard
       opts = { placeholder, value, cls (kelas input tambahan),
                attrs (dict → atribut input, cth. {'data-search':'tv'}),
                title (tooltip butang) }

   • mount($el, opts)         → $el.html(html(opts)); pulang $input

   • sync($btn|$wrap)         → selaraskan keterlihatan butang ✕ ikut
                                 nilai input (dipanggil sendiri oleh
                                 auto-bind; untuk kes luar biasa sahaja)

   • attach($wrapper, opts)   → tambah butang ✕ pada CONTROL sedia
                                 ada (cth. select Autocomplete
                                 frappe.ui.form.make_control):
                                 $wrapper.addClass('mba-searchwrap--ac')
                                 + butang abs anything kanan.
       opts = { on_clear($input, $btn) — lalai: kosongkan input +
                trigger 'change' (handler df.change control berjalan) }

   Contoh:
       // Markup biasa (cukup — auto-bind menguruskan ✕)
       el.innerHTML = TravelBookingSearchBox.html({
           placeholder: __('Search...'), value: st.search,
           attrs: { 'data-search': 'tv' }, cls: 'form-control',
       });

       // Control Autocomplete
       const ac = frappe.ui.form.make_control({ fieldtype: 'Autocomplete', … });
       TravelBookingSearchBox.attach(ac.$wrapper);
   ══════════════════════════════════════════════════════════════════ */

(function () {
	'use strict';

	const $ = window.jQuery;
	// esc — frappe.utils.escape_html bila ada (desk); fallback ringkas
	// untuk konteks bukan desk.
	const esc = (window.frappe && frappe.utils && frappe.utils.escape_html)
		? frappe.utils.escape_html
		: (v) => String(v ?? '').replace(/[&<>"']/g,
			(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
	const t = (s) => (typeof __ === 'function' ? __(s) : s);

	/* ---------- HTML wrap standard ---------- */
	function html(opts) {
		opts = opts || {};
		const attrs = Object.keys(opts.attrs || {})
			.map((k) => `${k}="${esc(opts.attrs[k])}"`).join(' ');
		const val = opts.value == null ? '' : String(opts.value);
		return `<span class="mba-searchwrap">
			<input type="text" class="${esc(opts.cls || '')}" ${attrs}
				placeholder="${esc(opts.placeholder || '')}" value="${esc(val)}" />
			<button type="button" class="mba-search-clear" ${val ? '' : 'hidden'}
				title="${esc(opts.title || t('Clear search'))}"
				aria-label="${esc(t('Clear search'))}">✕</button>
		</span>`;
	}

	/* ---------- Keterlihatan butang ✕ ---------- */
	function sync(btn_or_wrap) {
		const $w = $(btn_or_wrap).closest('.mba-searchwrap');
		const $inp = $w.find('> input').first();
		if ($inp.length) $w.find('.mba-search-clear').prop('hidden', !$inp.val());
	}

	/* ---------- Auto-bind (sekali pada document) ----------
	   Semua markup standard hidup tanpa wiring: taip → butang tampak;
	   klik ✕ → kosongkan + trigger 'input' (handler carian sedia ada
	   — debounce, reload — berjalan seperti user memadam teks). */
	if ($ && !$(document).data('zsb-bound')) {
		$(document).data('zsb-bound', true)
			.on('input.zsb', '.mba-searchwrap > input', function () {
				$(this).closest('.mba-searchwrap').find('.mba-search-clear')
					.prop('hidden', !this.value);
			})
			.on('click.zsb', '.mba-searchwrap .mba-search-clear', function () {
				const $inp = $(this).closest('.mba-searchwrap').find('> input').first();
				if (!$inp.val()) return;
				$inp.val('').trigger('input').trigger('focus');
				$(this).prop('hidden', true);
			});
	}

	/* ---------- Render terus ke elemen ---------- */
	function mount($el, opts) {
		if (!$el || !$el.length) return null;
		$el.html(html(opts));
		return $el.find('> input').first();
	}

	/* ---------- Butang ✕ untuk control sedia ada (Autocomplete) ----------
	   Bungkus $wrapper control (make_control) dengan kelas
	   mba-searchwrap--ac + butang ✕ mutlak kanan. Klik lalai: kosongkan
	   input + trigger 'change' — callback df.change control (cth.
	   penapis papan Rooming Board) berjalan seperti pilihan dikosongkan.
	   opts.get_value($inp) → nilai EFEKTIF control untuk keterlihatan ✕:
	   penting untuk Autocomplete frappe yang memaparkan LABEL opsyen
	   bernilai '' (cth. "All Categories") walaupun nilai kosong — teks
	   input tidak pernah benar-benar kosong (format_for_input).
	   Idempotent — butang sedia ada tidak diduakan. */
	function attach($wrapper, opts) {
		opts = opts || {};
		if (!$wrapper || !$wrapper.length) return null;
		const $inp = $wrapper.find('input').first();
		if (!$inp.length) return null;
		const effective = () => (opts.get_value ? opts.get_value($inp) : $inp.val());
		let $btn = $wrapper.find('.mba-search-clear').first();
		if (!$btn.length) {
			$wrapper.addClass('mba-searchwrap--ac');
			$btn = $(`<button type="button" class="mba-search-clear" hidden
				title="${esc(t('Clear search'))}" aria-label="${esc(t('Clear search'))}">✕</button>`);
			$wrapper.append($btn);
			// sync_soon — keterlihatan ✕ diselaraskan pada beberapa tick:
			// pipeline nilai control (cth. Autocomplete.set_value → format
			// semula teks input) selesai SELEPAS handler on_clear/change
			// dan TIDAK memancarkan event input/change baru, jadi sync
			// serta-merta boleh membaca nilai lapuk.
			const sync_soon = () => [0, 120, 400].forEach(
				(d) => setTimeout(() => $btn.prop('hidden', !effective()), d));
			$inp.on('input.zsb-ac change.zsb-ac blur.zsb-ac awesomplete-selectcomplete.zsb-ac',
				sync_soon);
			$btn.on('click.zsb-ac', () => {
				if (!effective()) return;
				if (opts.on_clear) opts.on_clear($inp, $btn);
				else $inp.val('').trigger('change').trigger('focus');
				sync_soon();
			});
		}
		$btn.prop('hidden', !effective());
		return $btn;
	}

	window.TravelBookingSearchBox = { html, mount, sync, attach };
})();
