/**
 * 薬歴テンプレコピー - UIロジック
 * parser.js の TemplateParser.parseTemplateHtml() を使って
 * 検索・見出し一覧・プレビュー・コピーのUIを構築する。
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'yakurekiTemplateCopy.headings.v1';
  var THEME_KEY = 'yakurekiTemplateCopy.theme.v1';
  var TEMPLATE_URL = 'data/template.html';

  var state = {
    headings: [],
    selectedId: null,
    filter: '',
    expandedGroupIds: {}
  };

  function loadFromStorage() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return null;
      TemplateParser.applyEffectiveBlocks(parsed);
      return parsed;
    } catch (err) {
      return null;
    }
  }

  function saveToStorage(headings) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(headings));
      return true;
    } catch (err) {
      return false;
    }
  }

  var listEl = document.getElementById('headingList');
  var emptyEl = document.getElementById('emptyMessage');
  var searchInput = document.getElementById('searchInput');
  var statusEl = document.getElementById('statusMessage');
  var fileInput = document.getElementById('fileInput');
  var dropzone = document.getElementById('dropzone');
  var pasteInput = document.getElementById('htmlPasteInput');
  var pasteImportBtn = document.getElementById('pasteImportBtn');
  var updateArea = document.getElementById('updateArea');
  var detailPaneEl = document.getElementById('detailPane');
  var themeToggleBtn = document.getElementById('themeToggle');

  function setStatus(message, kind) {
    statusEl.textContent = message;
    statusEl.className = 'status-message' + (kind ? ' status-' + kind : '');
  }

  function applyTheme(theme) {
    if (theme) {
      document.documentElement.setAttribute('data-theme', theme);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }

  (function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (err) { saved = null; }
    if (saved === 'dark' || saved === 'light') applyTheme(saved);
  })();

  themeToggleBtn.addEventListener('click', function () {
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var current = document.documentElement.getAttribute('data-theme') || (prefersDark ? 'dark' : 'light');
    var next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch (err) { /* ignore: theme just won't persist */ }
  });

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // SOAP形式の見出しマーカー(##S##など)を色分けしたバッジ表示に変換する。
  var MARKER_CLASS_MAP = {
    '##S##': 'marker-s',
    '##O##': 'marker-o',
    '##A##': 'marker-a',
    '##EP##': 'marker-ep',
    '##OP##': 'marker-op'
  };

  function renderBlockHtml(text) {
    return text.split('\n').map(function (line) {
      var trimmed = line.trim();
      var markerClass = MARKER_CLASS_MAP[trimmed];
      if (markerClass) {
        return '<span class="marker-badge ' + markerClass + '">' + escapeHtml(trimmed) + '</span>';
      }
      return escapeHtml(line);
    }).join('\n');
  }

  function highlightMatch(title, query) {
    if (!query) return escapeHtml(title);
    var idx = title.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return escapeHtml(title);
    return (
      escapeHtml(title.slice(0, idx)) +
      '<mark>' + escapeHtml(title.slice(idx, idx + query.length)) + '</mark>' +
      escapeHtml(title.slice(idx + query.length))
    );
  }

  var ICON_PREFIX_RE = new RegExp('^(\\p{Extended_Pictographic}\\uFE0F?)(\\s*)', 'u');

  // 丸い色付き絵文字は、OSによって見た目がバラつく上に古臭く見えるため、
  // 統一感のあるCSS製のドットアイコンに置き換える。それ以外の絵文字(▶等)はそのまま表示する。
  var DOT_ICON_MAP = {
    '🔴': 'red',    // 🔴
    '🟠': 'orange', // 🟠
    '🟡': 'yellow', // 🟡
    '🟢': 'green',  // 🟢
    '🔵': 'blue',   // 🔵
    '🟣': 'purple', // 🟣
    '🟤': 'brown',  // 🟤
    '⚫': 'black',       // ⚫
    '⚪': 'white'        // ⚪
  };

  function renderTitleHtml(title, query) {
    var m = title.match(ICON_PREFIX_RE);
    if (!m) return highlightMatch(title, query);
    var icon = m[1];
    var rest = title.slice(m[0].length);
    var iconBase = icon.replace(new RegExp('\\uFE0F$'), '');
    var dotColor = DOT_ICON_MAP[iconBase];
    var iconHtml = dotColor
      ? '<span class="dot dot-' + dotColor + '" aria-hidden="true"></span>'
      : escapeHtml(icon);
    return '<span class="title-icon">' + iconHtml + '</span>' + highlightMatch(rest, query);
  }

  function findHeading(id) {
    for (var i = 0; i < state.headings.length; i++) {
      if (state.headings[i].id === id) return state.headings[i];
    }
    return null;
  }

  function buildHeadingItemEl(h, query) {
    var li = document.createElement('li');
    li.className = 'heading-item level-' + h.level + (state.selectedId === h.id ? ' selected' : '');
    li.dataset.id = h.id;

    var row = document.createElement('div');
    row.className = 'heading-row';
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-pressed', state.selectedId === h.id ? 'true' : 'false');
    row.dataset.action = 'select';
    var showBadge = h.level !== 1 && !!h.block;
    row.innerHTML =
      (showBadge ? '<span class="badge">H' + h.level + '</span>' : '') +
      '<span class="heading-title">' + renderTitleHtml(h.title, query) + '</span>';
    li.appendChild(row);

    return li;
  }

  // 選択中の見出しの内容(##S##〜##OP##ブロック)を右側の詳細パネルに描画する。
  function renderDetailPane() {
    detailPaneEl.innerHTML = '';

    var h = state.selectedId ? findHeading(state.selectedId) : null;
    if (!h) {
      var empty = document.createElement('p');
      empty.className = 'detail-empty';
      empty.textContent = '左の一覧から見出しを選択すると、ここに内容が表示されます。';
      detailPaneEl.appendChild(empty);
      return;
    }

    var header = document.createElement('div');
    header.className = 'detail-header';
    var showBadge = h.level !== 1 && !!h.block;
    header.innerHTML =
      (showBadge ? '<span class="badge">H' + h.level + '</span>' : '') +
      '<span class="detail-title">' + renderTitleHtml(h.title, '') + '</span>';
    detailPaneEl.appendChild(header);

    var blocks = h.effectiveBlocks || [];
    var isOwn = blocks.length === 1 && blocks[0].id === h.id;

    if (blocks.length > 0 && !isOwn) {
      var hint = document.createElement('p');
      hint.className = 'preview-hint';
      if (blocks.length === 1) {
        hint.textContent = 'この見出し自体には本文が無いため、「' + blocks[0].title + '」の内容を表示しています。';
      } else {
        hint.textContent = 'この見出し自体には本文が無いため、配下にある' + blocks.length + '件('
          + blocks.map(function (b) { return '「' + b.title + '」'; }).join('・') + ')をそれぞれ分けて表示しています。';
      }
      detailPaneEl.appendChild(hint);
    }

    if (blocks.length === 0) {
      var emptyPre = document.createElement('pre');
      emptyPre.className = 'preview-text';
      emptyPre.textContent = h.tooManyToAggregate
        ? '(この見出しの配下には項目が多数あるため、まとめて表示できません。左の一覧から個別の項目を選択してください。)'
        : '(この見出しにはコピー対象の本文がありません)';
      detailPaneEl.appendChild(emptyPre);
      return;
    }

    blocks.forEach(function (b, i) {
      var blockWrap = document.createElement('div');
      blockWrap.className = 'preview-block';

      if (blocks.length > 1) {
        var blockTitle = document.createElement('p');
        blockTitle.className = 'preview-block-title';
        blockTitle.textContent = b.title;
        blockWrap.appendChild(blockTitle);
      }

      var copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'copy-btn';
      copyBtn.dataset.action = 'copy';
      copyBtn.dataset.blockIndex = String(i);
      copyBtn.textContent = 'コピー';
      blockWrap.appendChild(copyBtn);

      var pre = document.createElement('pre');
      pre.className = 'preview-text';
      pre.innerHTML = renderBlockHtml(b.block);
      blockWrap.appendChild(pre);

      detailPaneEl.appendChild(blockWrap);
    });
  }

  // H1見出しを区切りとして、以降(次のH1が現れるまで)の見出しをその配下として
  // グルーピングする。検索していないときのアコーディオン表示に使う。
  function computeGroups(headings) {
    var groups = [];
    var current = null;
    headings.forEach(function (h) {
      if (h.level === 1 && h.title.trim() === '') {
        return; // タイトルが空のH1(書式だけ残った空行など)はグループ区切りとして扱わず無視する
      }
      if (h.level === 1) {
        current = { heading: h, items: [] };
        groups.push(current);
      } else if (current) {
        current.items.push(h);
      } else {
        if (!groups.length) groups.push({ heading: null, items: [] });
        groups[0].items.push(h);
      }
    });
    return groups;
  }

  function render() {
    var query = state.filter.trim();

    listEl.innerHTML = '';

    if (state.headings.length === 0) {
      emptyEl.textContent = 'まだテンプレートが取り込まれていません。上の「更新」からHTMLファイルを取り込んでください。';
      return;
    }

    if (query) {
      var filtered = state.headings.filter(function (h) {
        return h.title.toLowerCase().indexOf(query.toLowerCase()) !== -1;
      });
      if (filtered.length === 0) {
        emptyEl.textContent = '「' + query + '」に一致する見出しが見つかりません。';
        return;
      }
      emptyEl.textContent = '';
      var frag = document.createDocumentFragment();
      filtered.forEach(function (h) {
        frag.appendChild(buildHeadingItemEl(h, query));
      });
      listEl.appendChild(frag);
      return;
    }

    emptyEl.textContent = '';
    var groups = computeGroups(state.headings);
    var groupFrag = document.createDocumentFragment();

    groups.forEach(function (g) {
      if (!g.heading) {
        g.items.forEach(function (h) { groupFrag.appendChild(buildHeadingItemEl(h, '')); });
        return;
      }

      var isExpanded = !!state.expandedGroupIds[g.heading.id];

      var card = document.createElement('li');
      card.className = 'group-card' + (isExpanded ? ' expanded' : '');
      card.dataset.groupId = g.heading.id;

      var header = document.createElement('div');
      header.className = 'group-card-header';
      header.tabIndex = 0;
      header.setAttribute('role', 'button');
      header.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
      header.dataset.action = 'toggle-group';
      header.innerHTML =
        '<span class="chevron" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M9 6l8 6-8 6V6z"/></svg></span>' +
        '<span class="heading-title">' + renderTitleHtml(g.heading.title, '') + '</span>';
      card.appendChild(header);

      if (isExpanded) {
        var body = document.createElement('ul');
        body.className = 'group-body';
        g.items.forEach(function (h) {
          body.appendChild(buildHeadingItemEl(h, ''));
        });
        card.appendChild(body);
      }

      groupFrag.appendChild(card);
    });

    listEl.appendChild(groupFrag);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) resolve(); else reject(new Error('execCommand failed'));
      } catch (err) {
        reject(err);
      }
    });
  }

  function selectHeading(id) {
    state.selectedId = state.selectedId === id ? null : id;
    render();
    renderDetailPane();
    if (state.selectedId && window.matchMedia('(max-width: 899px)').matches) {
      detailPaneEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }

  listEl.addEventListener('click', function (e) {
    var actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;

    if (actionEl.dataset.action === 'toggle-group') {
      var card = e.target.closest('.group-card');
      if (!card) return;
      var groupId = card.dataset.groupId;
      if (state.expandedGroupIds[groupId]) {
        delete state.expandedGroupIds[groupId];
      } else {
        state.expandedGroupIds[groupId] = true;
      }
      render();
      return;
    }

    if (actionEl.dataset.action === 'select') {
      var li = e.target.closest('.heading-item');
      if (!li) return;
      selectHeading(li.dataset.id);
    }
  });

  listEl.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var actionEl = e.target.closest('[data-action="select"], [data-action="toggle-group"]');
    if (!actionEl) return;
    e.preventDefault();
    actionEl.click();
  });

  // コピー ボタン自体も1秒間だけ「コピーしました!」表示に変える(クリックした実感を持たせる)。
  function showCopyFeedback(btn) {
    if (btn._copyFeedbackTimer) {
      clearTimeout(btn._copyFeedbackTimer);
    } else {
      btn._copyFeedbackOriginalText = btn.textContent;
    }
    btn.textContent = 'コピーしました!✅';
    btn.classList.add('copy-btn-success');
    btn._copyFeedbackTimer = setTimeout(function () {
      btn.textContent = btn._copyFeedbackOriginalText;
      btn.classList.remove('copy-btn-success');
      btn._copyFeedbackTimer = null;
    }, 1000);
  }

  detailPaneEl.addEventListener('click', function (e) {
    var actionEl = e.target.closest('[data-action="copy"]');
    if (!actionEl) return;
    var heading = state.selectedId ? findHeading(state.selectedId) : null;
    var blockIndex = Number(actionEl.dataset.blockIndex);
    var targetBlock = heading && heading.effectiveBlocks && heading.effectiveBlocks[blockIndex];
    if (!targetBlock) return;
    copyText(targetBlock.block).then(function () {
      setStatus('「' + targetBlock.title + '」の内容をコピーしました。', 'success');
      showCopyFeedback(actionEl);
    }).catch(function () {
      setStatus('コピーに失敗しました。お手数ですが、選択して手動でコピーしてください。', 'error');
    });
  });

  searchInput.addEventListener('input', function () {
    state.filter = searchInput.value;
    render();
  });

  function importHtml(htmlString, sourceLabel) {
    try {
      var headings = TemplateParser.parseTemplateHtml(htmlString);
      state.headings = headings;
      state.selectedId = null;
      state.filter = '';
      state.expandedGroupIds = {};
      searchInput.value = '';
      render();
      renderDetailPane();
      updateArea.open = false;

      var saved = saveToStorage(headings);
      if (saved) {
        setStatus(sourceLabel + 'を取り込みました(見出し' + headings.length + '件)。', 'success');
      } else {
        setStatus(sourceLabel + 'を取り込みましたが、保存に失敗しました(ブラウザのストレージ容量制限などが考えられます)。今回開いている間は利用できますが、次回は復元されません。', 'error');
      }
    } catch (err) {
      setStatus('取り込みに失敗しました: ' + err.message, 'error');
    }
  }

  function readFile(file) {
    var name = file.name || 'ファイル';
    if (!/\.html?$/i.test(name)) {
      setStatus('HTMLファイル(.html)を選択してください。', 'error');
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      importHtml(String(reader.result), '「' + name + '」');
    };
    reader.onerror = function () {
      setStatus('ファイルの読み込みに失敗しました。', 'error');
    };
    reader.readAsText(file, 'UTF-8');
  }

  fileInput.addEventListener('change', function () {
    var file = fileInput.files && fileInput.files[0];
    if (file) readFile(file);
    fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach(function (evt) {
    dropzone.addEventListener(evt, function (e) {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach(function (evt) {
    dropzone.addEventListener(evt, function (e) {
      e.preventDefault();
      dropzone.classList.remove('dragover');
    });
  });
  dropzone.addEventListener('drop', function (e) {
    var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) readFile(file);
  });

  pasteImportBtn.addEventListener('click', function () {
    var text = pasteInput.value;
    if (!text.trim()) {
      setStatus('貼り付けるHTMLソースが空です。', 'error');
      return;
    }
    importHtml(text, '貼り付けたHTMLソース');
    pasteInput.value = '';
  });

  // 全端末で同じ内容を見られるよう、まずリポジトリに同梱された共有テンプレート
  // (data/template.html)を自動取得する。取得できない場合(オフライン・file://で
  // 直接開いた場合など)のみ、以前ブラウザに保存された内容にフォールバックする。
  (function restoreOnLoad() {
    setStatus('共有テンプレートを読み込み中…', null);
    fetch(TEMPLATE_URL, { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(function (html) {
        importHtml(html, '共有テンプレート');
      })
      .catch(function () {
        var restored = loadFromStorage();
        if (restored && restored.length) {
          state.headings = restored;
          setStatus('共有テンプレートを取得できなかったため、このブラウザに保存されていた内容を復元しました(見出し' + restored.length + '件)。', 'error');
        } else {
          setStatus('共有テンプレートを取得できませんでした。オフラインの場合は接続を確認するか、下の「更新」からHTMLファイルを取り込んでください。', 'error');
        }
        render();
        renderDetailPane();
      });
  })();
})();
