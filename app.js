(function () {
  "use strict";

  const DB_FILE = "pacha_malayalam_curated.db";
  const SQLJS_BASE = "https://cdn.jsdelivr.net/npm/sql.js@1.14.0/dist/";

  let entries = [];
  let alphaBuckets = new Map();
  let searchResults = [];
  let searchPage = 1;
  const SEARCH_PAGE_SIZE = 40;

  let activeLetter = "അ";
  let alphaPage = 1;
  const ALPHA_PAGE_SIZE = 90;

  const ML_LETTERS = [
    "അ","ആ","ഇ","ഈ","ഉ","ഊ","ഋ","എ","ഏ","ഐ","ഒ","ഓ","ഔ",
    "ക","ഖ","ഗ","ഘ","ങ","ച","ഛ","ജ","ഝ","ഞ","ട","ഠ","ഡ","ഢ","ണ",
    "ത","ഥ","ദ","ധ","ന","പ","ഫ","ബ","ഭ","മ","യ","ര","ല","വ",
    "ശ","ഷ","സ","ഹ","ള","ഴ","റ"
  ];
  const ML_SET = new Set(ML_LETTERS);
  const CHILLU_TO_BASE = { "ൺ": "ണ", "ൻ": "ന", "ർ": "ര", "ൽ": "ല", "ൾ": "ള", "ൿ": "ക" };

  let collator;
  try {
    collator = new Intl.Collator("ml", { sensitivity: "base" });
  } catch (_e) {
    collator = { compare: (a, b) => a.localeCompare(b) };
  }

  function mlSkeleton(str) {
    if (!str) return "";
    return String(str)
      .toLowerCase()
      .trim()
      .replace(/ൺ/g, "ണ")
      .replace(/ൻ/g, "ന")
      .replace(/ർ/g, "ര")
      .replace(/ൽ/g, "ല")
      .replace(/ൾ/g, "ള")
      .replace(/ൿ/g, "ക")
      .replace(/[\u0D4D\u0D3E-\u0D4C\u0D57\u0D02\u0D03\u200C\u200D]/g, "")
      .replace(/റ/g, "ര")
      .replace(/ഴ/g, "ള")
      .replace(/[ശഷ]/g, "സ")
      .replace(/(.)\1+/g, "$1");
  }

  function getInitialLetter(hw) {
    for (const ch of hw) {
      if (ML_SET.has(ch)) return ch;
      if (CHILLU_TO_BASE[ch]) return CHILLU_TO_BASE[ch];
    }
    return "Other";
  }

  function escHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function highlightText(text, query) {
    if (!query) return escHtml(text);
    const safe = escHtml(text);
    const qEsc = escHtml(query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try {
      return safe.replace(new RegExp(`(${qEsc})`, "gi"), "<mark>$1</mark>");
    } catch (_e) {
      return safe;
    }
  }

  function levenshtein(a, b, maxDist) {
    if (a === b) return 0;
    const la = a.length;
    const lb = b.length;
    if (Math.abs(la - lb) > maxDist) return maxDist + 1;
    let prev = new Array(lb + 1);
    let curr = new Array(lb + 1);
    for (let j = 0; j <= lb; j++) prev[j] = j;
    for (let i = 1; i <= la; i++) {
      curr[0] = i;
      let minRow = i;
      const ca = a.charCodeAt(i - 1);
      for (let j = 1; j <= lb; j++) {
        const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
        const val = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        curr[j] = val;
        if (val < minRow) minRow = val;
      }
      if (minRow > maxDist) return maxDist + 1;
      [prev, curr] = [curr, prev];
    }
    return prev[lb];
  }

  function loadFromSqliteBuffer(SQL, buf) {
    const db = new SQL.Database(new Uint8Array(buf));

    const entryRes = db.exec(
      `SELECT e.id, e.headword, e.pos, e.variation, e.reference, e.etym, e.cognates, e.notes,
              m.root_stem, m.affixes
       FROM entries e
       LEFT JOIN entries_morphology m ON m.entry_id = e.id`
    );

    const rows = entryRes[0] ? entryRes[0].values : [];
    const byId = new Map();
    entries = rows.map((r) => {
      const hw = r[1] || "";
      const variation = r[3] || "";
      const obj = {
        id: r[0],
        hw,
        hwLower: hw.toLowerCase(),
        hwSkel: mlSkeleton(hw),
        pos: r[2] || "",
        variation,
        varLower: variation.toLowerCase(),
        reference: r[4] || "",
        etym: r[5] || "",
        cognates: r[6] || "",
        notes: r[7] || "",
        morphRoot: r[8] || "",
        morphAffix: r[9] || "",
        meanings: []
      };
      byId.set(obj.id, obj);
      return obj;
    });

    const mRes = db.exec("SELECT entry_id, meaning_text FROM entries_meanings ORDER BY id");
    if (mRes[0]) {
      for (const r of mRes[0].values) {
        const e = byId.get(r[0]);
        if (e) e.meanings.push(r[1]);
      }
    }
    db.close();

    // Build Malayalam alphabetical buckets
    const alphaSorted = [...entries].sort((a, b) => collator.compare(a.hw, b.hw));
    alphaBuckets = new Map();
    for (const ch of ML_LETTERS) alphaBuckets.set(ch, []);
    alphaBuckets.set("Other", []);
    for (const e of alphaSorted) {
      const k = getInitialLetter(e.hw);
      if (!alphaBuckets.has(k)) alphaBuckets.set(k, []);
      alphaBuckets.get(k).push(e);
    }

    document.getElementById("wordCount").textContent = entries.length.toLocaleString();
    document.getElementById("dbFallbackBox").classList.add("hidden");

    // Word of the Day
    if (entries.length > 0) {
      const today = new Date();
      const seed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
      const wotd = entries[seed % entries.length];
      const wotdLink = document.getElementById("wotdLink");
      wotdLink.textContent = wotd.hw;
      wotdLink.onclick = (ev) => {
        ev.preventDefault();
        document.getElementById("fuzzyCheckbox").checked = false;
        document.getElementById("searchBox").value = wotd.hw;
        searchPage = 1;
        runSearch();
      };
    }
  }

  async function initDatabase() {
    const SQL = await initSqlJs({ locateFile: (file) => SQLJS_BASE + file });

    document.getElementById("dbFileInput").addEventListener("change", async (ev) => {
      const file = ev.target.files && ev.target.files[0];
      if (!file) return;
      document.getElementById("wordCount").textContent = "Loading…";
      const buf = await file.arrayBuffer();
      loadFromSqliteBuffer(SQL, buf);
    });

    try {
      const resp = await fetch(DB_FILE);
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const buf = await resp.arrayBuffer();
      loadFromSqliteBuffer(SQL, buf);
    } catch (_err) {
      document.getElementById("wordCount").textContent = "Select .db file";
      document.getElementById("dbFallbackBox").classList.remove("hidden");
    }
  }

  function runSearch() {
    const qRaw = document.getElementById("searchBox").value.trim();
    const isFuzzy = document.getElementById("fuzzyCheckbox").checked;
    const posFilter = document.getElementById("posFilter").value;

    const resultsEl = document.getElementById("results");
    const pagEl = document.getElementById("searchPagination");
    const wotdEl = document.getElementById("wordOfTheDay");

    if (!qRaw) {
      resultsEl.innerHTML = "";
      pagEl.classList.add("hidden");
      wotdEl.classList.remove("hidden");
      return;
    }

    wotdEl.classList.add("hidden");
    const q = qRaw.toLowerCase();
    const qSkel = mlSkeleton(qRaw);
    const isAscii = /^[\x00-\x7F]+$/.test(qRaw);
    const matches = [];

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (posFilter && !e.pos.includes(posFilter)) continue;
      let score = 0;

      // 1. Headword & variation
      if (e.hwLower === q) score = Math.max(score, 100);
      else if (e.hwLower.startsWith(q)) score = Math.max(score, 90);
      else if (e.hwLower.includes(q)) score = Math.max(score, 76);
      else if (e.varLower && e.varLower.includes(q)) score = Math.max(score, 68);

      // 2. Inbuilt reverse search across meanings (English & Malayalam)
      for (let m = 0; m < e.meanings.length; m++) {
        const ml = e.meanings[m].toLowerCase();
        if (ml === q) score = Math.max(score, 96);
        else if (ml.startsWith(q)) score = Math.max(score, 86);
        else if (ml.includes(q)) score = Math.max(score, 74);
        else if (isFuzzy && isAscii && q.length >= 3 && ml.length <= 24 && Math.abs(ml.length - q.length) <= 2) {
          const dm = levenshtein(q, ml, 2);
          if (dm <= 2) score = Math.max(score, Math.round((1 - dm / Math.max(q.length, ml.length)) * 70));
        }
      }

      // 3. Optional fuzzy matching on Malayalam headwords
      if (isFuzzy && score < 85 && !isAscii) {
        if (e.hwSkel && qSkel && e.hwSkel === qSkel) score = Math.max(score, 92);
        else if (qSkel.length >= 2 && e.hwSkel.includes(qSkel)) score = Math.max(score, 80);
        else {
          const maxD = Math.max(1, Math.floor(Math.max(q.length, e.hwLower.length) * 0.35));
          if (Math.abs(e.hwLower.length - q.length) <= maxD) {
            const d = levenshtein(q, e.hwLower, maxD);
            if (d <= maxD) score = Math.max(score, Math.round((1 - d / Math.max(q.length, e.hwLower.length)) * 84));
          }
          if (score < 60 && qSkel.length >= 2 && Math.abs(e.hwSkel.length - qSkel.length) <= maxD) {
            const ds = levenshtein(qSkel, e.hwSkel, maxD);
            if (ds <= maxD) score = Math.max(score, Math.round((1 - ds / Math.max(qSkel.length, e.hwSkel.length)) * 78));
          }
        }
      }

      if (score >= (isFuzzy ? 45 : 1)) {
        matches.push({ entry: e, score });
      }
    }

    matches.sort((a, b) => b.score - a.score || collator.compare(a.entry.hw, b.entry.hw));
    searchResults = matches;
    searchPage = 1;
    renderSearchPage(qRaw, isFuzzy);
  }

  function renderSearchPage(qRaw, isFuzzy) {
    const resultsEl = document.getElementById("results");
    const pagEl = document.getElementById("searchPagination");
    const total = searchResults.length;

    if (total === 0) {
      resultsEl.innerHTML = `<div class="entry">ഫലങ്ങളൊന്നും കണ്ടെത്തിയില്ല (No results found for "${escHtml(qRaw)}").</div>`;
      pagEl.classList.add("hidden");
      return;
    }

    const totalPages = Math.ceil(total / SEARCH_PAGE_SIZE);
    const start = (searchPage - 1) * SEARCH_PAGE_SIZE;
    const slice = searchResults.slice(start, start + SEARCH_PAGE_SIZE);

    const html = [`<div class="results-meta">${total.toLocaleString()} ഫലങ്ങൾ കണ്ടെത്തി</div>`];
    for (const item of slice) {
      const e = item.entry;
      const hwHtml = highlightText(e.hw, qRaw);
      const meaningsHtml = e.meanings.map((m) => `<li>• ${highlightText(m, qRaw)}</li>`).join("");
      const morphStr = [
        e.morphRoot ? `Root: ${e.morphRoot}` : "",
        e.morphAffix ? `Affixes: ${e.morphAffix}` : ""
      ].filter(Boolean).join(" | ");

      html.push(`
        <div class="entry">
          <div class="entry-header">
            <span class="headword">${hwHtml}</span>
            ${e.variation ? `<span class="variant">(${escHtml(e.variation)})</span>` : ""}
            ${e.pos ? `<span class="pos">${escHtml(e.pos)}</span>` : ""}
            ${isFuzzy ? `<span class="fuzzy-score">${item.score}%</span>` : ""}
          </div>
          <ul class="meanings">${meaningsHtml}</ul>
          ${e.etym ? `<div class="entry-meta-line"><strong>നിരുക്തം / Etymology:</strong> ${escHtml(e.etym)}</div>` : ""}
          ${e.cognates ? `<div class="entry-meta-line"><strong>ബന്ധുരൂപങ്ങൾ / Cognates:</strong> ${escHtml(e.cognates)}</div>` : ""}
          ${morphStr ? `<div class="entry-meta-line"><strong>രൂപവിജ്ഞാനം / Morphology:</strong> ${escHtml(morphStr)}</div>` : ""}
          ${e.reference ? `<div class="entry-meta-line"><strong>ആധാരം / Ref:</strong> ${escHtml(e.reference)}</div>` : ""}
          ${e.notes ? `<div class="notes">${escHtml(e.notes)}</div>` : ""}
        </div>
      `);
    }

    resultsEl.innerHTML = html.join("");

    if (totalPages > 1) {
      pagEl.classList.remove("hidden");
      document.getElementById("searchPageInfo").textContent = `${searchPage} / ${totalPages}`;
      document.getElementById("searchPrevBtn").disabled = searchPage <= 1;
      document.getElementById("searchNextBtn").disabled = searchPage >= totalPages;
    } else {
      pagEl.classList.add("hidden");
    }
  }

  function renderAlphabetBar() {
    const bar = document.getElementById("alphabetFilter");
    const out = [];
    for (const [letter, list] of alphaBuckets.entries()) {
      if (list.length === 0) continue;
      const cls = letter === activeLetter ? "alphabet-letter active" : "alphabet-letter";
      out.push(`<button type="button" class="${cls}" data-letter="${escHtml(letter)}">${escHtml(letter)}</button>`);
    }
    bar.innerHTML = out.join("");
  }

  function renderGlossaryPage() {
    const posFilter = document.getElementById("glossaryPosFilter").value;
    const rawList = alphaBuckets.get(activeLetter) || [];
    const list = posFilter ? rawList.filter((e) => e.pos.includes(posFilter)) : rawList;

    const total = list.length;
    const totalPages = Math.max(1, Math.ceil(total / ALPHA_PAGE_SIZE));
    if (alphaPage > totalPages) alphaPage = totalPages;

    document.getElementById("glossaryStatus").textContent =
      `"${activeLetter}" — ${total.toLocaleString()} വാക്കുകൾ (അക്ഷരമാല ക്രമത്തിൽ)`;

    const start = (alphaPage - 1) * ALPHA_PAGE_SIZE;
    const slice = list.slice(start, start + ALPHA_PAGE_SIZE);
    const itemsHtml = slice.map((e) => {
      const gloss = e.meanings[0] ? escHtml(e.meanings[0]) : "";
      return `<li><a href="#" data-hw="${escHtml(e.hw)}">${escHtml(e.hw)}</a>${gloss ? `<span class="glossary-gloss">— ${gloss}</span>` : ""}</li>`;
    }).join("");

    document.getElementById("glossaryResults").innerHTML = `<ul>${itemsHtml}</ul>`;

    const pag = document.getElementById("paginationControls");
    if (totalPages > 1) {
      pag.classList.remove("hidden");
      document.getElementById("alphaPageInfo").textContent = `${alphaPage} / ${totalPages}`;
      document.getElementById("alphaPrevBtn").disabled = alphaPage <= 1;
      document.getElementById("alphaNextBtn").disabled = alphaPage >= totalPages;
    } else {
      pag.classList.add("hidden");
    }
  }

  function switchView(view) {
    const isHome = view === "home";
    document.getElementById("homeView").classList.toggle("hidden", !isHome);
    document.getElementById("searchHeaderControls").classList.toggle("hidden", !isHome);
    document.getElementById("glossaryView").classList.toggle("hidden", isHome);
    document.getElementById("navHome").classList.toggle("active-nav", isHome);
    document.getElementById("navGlossary").classList.toggle("active-nav", !isHome);
    document.getElementById("menu").classList.remove("show");
    if (!isHome) {
      renderAlphabetBar();
      renderGlossaryPage();
    }
    window.scrollTo(0, 0);
  }

  document.getElementById("menuToggleBtn").addEventListener("click", () => {
    document.getElementById("menu").classList.toggle("show");
  });
  document.getElementById("brand").addEventListener("click", () => switchView("home"));
  document.getElementById("navHome").addEventListener("click", () => switchView("home"));
  document.getElementById("footHome").addEventListener("click", () => switchView("home"));
  document.getElementById("navGlossary").addEventListener("click", () => switchView("glossary"));
  document.getElementById("footGlossary").addEventListener("click", () => switchView("glossary"));

  let timer;
  document.getElementById("searchBox").addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(runSearch, 140);
  });
  document.getElementById("searchBox").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") runSearch();
  });
  document.getElementById("simpleSearchBtn").addEventListener("click", runSearch);
  document.getElementById("fuzzyCheckbox").addEventListener("change", runSearch);
  document.getElementById("posFilter").addEventListener("change", runSearch);

  document.getElementById("searchPrevBtn").addEventListener("click", () => {
    if (searchPage > 1) {
      searchPage--;
      renderSearchPage(document.getElementById("searchBox").value.trim(), document.getElementById("fuzzyCheckbox").checked);
      window.scrollTo(0, 0);
    }
  });
  document.getElementById("searchNextBtn").addEventListener("click", () => {
    searchPage++;
    renderSearchPage(document.getElementById("searchBox").value.trim(), document.getElementById("fuzzyCheckbox").checked);
    window.scrollTo(0, 0);
  });

  document.getElementById("alphabetFilter").addEventListener("click", (ev) => {
    const btn = ev.target.closest(".alphabet-letter");
    if (!btn) return;
    activeLetter = btn.dataset.letter;
    alphaPage = 1;
    renderAlphabetBar();
    renderGlossaryPage();
  });
  document.getElementById("glossaryPosFilter").addEventListener("change", () => {
    alphaPage = 1;
    renderGlossaryPage();
  });
  document.getElementById("alphaPrevBtn").addEventListener("click", () => {
    if (alphaPage > 1) { alphaPage--; renderGlossaryPage(); window.scrollTo(0, 0); }
  });
  document.getElementById("alphaNextBtn").addEventListener("click", () => {
    alphaPage++; renderGlossaryPage(); window.scrollTo(0, 0);
  });

  document.getElementById("glossaryResults").addEventListener("click", (ev) => {
    const link = ev.target.closest("a[data-hw]");
    if (!link) return;
    ev.preventDefault();
    switchView("home");
    document.getElementById("fuzzyCheckbox").checked = false;
    document.getElementById("posFilter").value = "";
    document.getElementById("searchBox").value = link.dataset.hw;
    runSearch();
  });

  initDatabase();
})();
