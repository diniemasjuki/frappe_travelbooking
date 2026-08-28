/* travel_booking/public/js/destination_search.js
   Autocomplete destinasi untuk hero search homepage (cruise + tour).

   Membaca senarai destinasi dari <script id="rcSearchDestinations"> (JSON
   {name, destination_name, destination_country}) dan pasang combobox pada
   setiap [data-rc-autocomplete].
     - Tapis case-insensitive semasa menaip (nama atau negara)
     - Navigasi keyboard: ↑/↓ gerak highlight, Enter pilih, Esc tutup
     - Klik item atau luar menutup senarai
     - Nilai terpilih (destination point name) disimpan dlm hidden input
       name="destination" supaya form posting ke /cruises, /tours atau /trips. */

(function () {
  "use strict";

  function init() {
    var dataEl = document.getElementById("rcSearchDestinations");
    if (!dataEl) return;
    var raw = [];
    try {
      raw = JSON.parse(dataEl.textContent || "[]");
    } catch (e) {
      return;
    }

    var items = raw.map(function (d) {
      var name = d.destination_name || d.name || "";
      var country = d.destination_country || "";
      return {
        value: d.name || "",
        name: name,
        country: country,
        label: country ? name + ", " + country : name,
      };
    });

    var nodes = document.querySelectorAll("[data-rc-autocomplete]");
    Array.prototype.forEach.call(nodes, function (node) {
      buildCombobox(node, items);
    });
  }

  function buildCombobox(root, items) {
    var input = root.querySelector(".rc-ac-input");
    var hidden = root.querySelector('input[type="hidden"]');
    var list = root.querySelector(".rc-ac-list");
    if (!input || !hidden || !list) return;

    var activeIdx = -1;
    var currentMatches = [];
    var MAX = 50;

    function render(q) {
      q = (q || "").trim().toLowerCase();
      currentMatches = !q
        ? items.slice(0, MAX)
        : items.filter(function (it) {
            return (
              it.label.toLowerCase().indexOf(q) !== -1 ||
              it.name.toLowerCase().indexOf(q) !== -1
            );
          });

      list.innerHTML = "";
      if (!currentMatches.length) {
        var empty = document.createElement("li");
        empty.className = "rc-ac-empty";
        empty.textContent = "No destinations found";
        list.appendChild(empty);
        list.hidden = false;
        input.setAttribute("aria-expanded", "true");
        activeIdx = -1;
        return;
      }
      currentMatches.slice(0, MAX).forEach(function (it, i) {
        var li = document.createElement("li");
        li.className = "rc-ac-item";
        li.setAttribute("role", "option");
        li.dataset.idx = String(i);

        var nameSpan = document.createElement("span");
        nameSpan.className = "rc-ac-name";
        nameSpan.textContent = it.name;
        li.appendChild(nameSpan);

        if (it.country) {
          var cSpan = document.createElement("span");
          cSpan.className = "rc-ac-country";
          cSpan.textContent = it.country;
          li.appendChild(cSpan);
        }

        // mousedown fires before the input's blur, so the pick registers
        li.addEventListener("mousedown", function (e) {
          e.preventDefault();
          select(parseInt(li.dataset.idx, 10));
        });
        list.appendChild(li);
      });
      activeIdx = -1;
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
    }

    function open() { render(input.value); }

    function close() {
      list.hidden = true;
      list.innerHTML = "";
      input.setAttribute("aria-expanded", "false");
      activeIdx = -1;
    }

    function select(i) {
      var it = currentMatches[i];
      if (!it) return;
      input.value = it.label;
      hidden.value = it.value;
      close();
    }

    function setActive(idx) {
      var opts = list.querySelectorAll(".rc-ac-item");
      if (!opts.length) return;
      Array.prototype.forEach.call(opts, function (o) {
        o.classList.remove("active");
      });
      if (idx < 0) idx = opts.length - 1;
      if (idx >= opts.length) idx = 0;
      activeIdx = idx;
      var el = opts[idx];
      if (el) el.scrollIntoView({ block: "nearest" });
    }

    input.addEventListener("focus", open);
    input.addEventListener("input", function () {
      hidden.value = ""; // kosongkan pilihan semasa menaip
      render(input.value);
    });
    input.addEventListener("keydown", function (e) {
      if (list.hidden) {
        if (e.key === "ArrowDown") open();
        return;
      }
      if (e.key === "ArrowDown") { e.preventDefault(); setActive(activeIdx + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActive(activeIdx - 1); }
      else if (e.key === "Enter") {
        if (activeIdx >= 0) { e.preventDefault(); select(activeIdx); }
      }
      else if (e.key === "Escape") { close(); }
    });
    input.addEventListener("blur", function () {
      setTimeout(close, 120);
    });
    document.addEventListener("click", function (e) {
      if (!root.contains(e.target)) close();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
