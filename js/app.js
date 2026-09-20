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
    expandedGroupIds: {},
    view: 'tree',       // 'tree' | 'index'
    indexMode: 'drug',  // 'drug' | 'category' (viewが'index'の時のみ有効)
    drugGroups: [],
    categoryGroups: [],
    selectedDrugKey: null,
    selectedCategoryKey: null
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
  var detailPaneEl = document.getElementById('detailPane');
  var themeToggleBtn = document.getElementById('themeToggle');
  var drugAlphabetNavEl = document.getElementById('drugAlphabetNav');
  var viewTabButtons = Array.prototype.slice.call(document.querySelectorAll('.view-tab'));
  var indexSubtabsEl = document.getElementById('indexSubtabs');
  var indexSubtabButtons = Array.prototype.slice.call(document.querySelectorAll('.index-subtab'));

  // ヘッダーが常時メッセージで埋まらないよう、取り込み成功時などの通知は
  // 表示しない(コピー操作はボタン側の一時フィードバックで十分なため)。
  // 実際に確認してほしい異常(取得失敗など)の時だけヘッダーに表示する。
  function setStatus(message, kind) {
    if (kind !== 'error') {
      statusEl.textContent = '';
      statusEl.className = 'status-message';
      return;
    }
    statusEl.textContent = message;
    statusEl.className = 'status-message status-error';
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

  function toKatakana(str) {
    return str.replace(/[ぁ-ゖ]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) + 0x60);
    });
  }

  function normalizeForSearch(str) {
    return toKatakana(str).toLowerCase();
  }

  // 日本語の見出しは「抗てんかん薬」のように語の区切りに空白が無い複合語が多く、
  // 先頭一致(単語の先頭からの一致)だけに絞ると「てんかん」のような語の途中の部分文字列で
  // 検索できなくなってしまう。見出し内のどこにあってもヒットするよう、単純な部分一致にする。
  function matchIndex(text, query) {
    if (!query) return -1;
    return normalizeForSearch(text).indexOf(normalizeForSearch(query));
  }

  function highlightMatch(text, query) {
    if (!query) return escapeHtml(text);
    var idx = matchIndex(text, query);
    if (idx === -1) return escapeHtml(text);
    return (
      escapeHtml(text.slice(0, idx)) +
      '<mark>' + escapeHtml(text.slice(idx, idx + query.length)) + '</mark>' +
      escapeHtml(text.slice(idx + query.length))
    );
  }

  // 見出し単体のタイトルだけでなく、上位の親見出し(パンくずリスト)も含めて
  // 検索対象にする。「てんかん」で検索したとき、自分自身のタイトルに無くても
  // 親見出しに含まれていればヒットするようにする。
  function headingSearchText(h) {
    return (h.breadcrumb || []).concat([h.title]).join(' ');
  }

  function headingMatchesQuery(h, query) {
    return normalizeForSearch(headingSearchText(h)).indexOf(normalizeForSearch(query)) !== -1;
  }

  function buildBreadcrumbHtml(ancestors, query, stripIcon) {
    return ancestors
      .map(function (t) { return highlightMatch(stripIcon ? stripIconPrefix(t) : t, query); })
      .join('<span class="breadcrumb-sep">›</span>');
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
    var iconBase = icon.replace(new RegExp('\\uFE0F$'), '');
    var dotColor = DOT_ICON_MAP[iconBase];
    // ドットアイコンへの置き換え対象外の記号(▶など)は、サイズ・縦位置がズレる原因になるため
    // 特別扱いせず、通常の文字として表示する。
    if (!dotColor) return highlightMatch(title, query);
    var rest = title.slice(m[0].length);
    return '<span class="title-icon"><span class="dot dot-' + dotColor + '" aria-hidden="true"></span></span>' + highlightMatch(rest, query);
  }

  // 見出し先頭の絵文字アイコン(🟠🔵など)を取り除いたテキストを返す。
  // 検索結果一覧はパンくず+タイトルが並ぶため、絵文字バッジが多いと煩雑になる。
  // 通常のツリー表示では引き続きアイコンを表示するため、検索結果でのみ使う。
  function stripIconPrefix(title) {
    var m = title.match(ICON_PREFIX_RE);
    return m ? title.slice(m[0].length) : title;
  }

  // 薬剤名インデックスの五十音ジャンプ用: 先頭の文字がどの行(あ行〜わ行)に
  // 属するかを判定する。濁点・半濁点・拗音・長音は対応する清音の行にまとめる。
  var GYOU_LIST = ['あ', 'か', 'さ', 'た', 'な', 'は', 'ま', 'や', 'ら', 'わ', '他'];

  var KANA_ROW_MAP = (function () {
    var rows = {
      'あ': 'アイウエオァィゥェォヴ',
      'か': 'カキクケコガギグゲゴヵヶ',
      'さ': 'サシスセソザジズゼゾ',
      'た': 'タチツテトダヂヅデドッ',
      'な': 'ナニヌネノ',
      'は': 'ハヒフヘホバビブベボパピプペポ',
      'ま': 'マミムメモ',
      'や': 'ヤユヨャュョ',
      'ら': 'ラリルレロ',
      'わ': 'ワヲンヮ'
    };
    var map = {};
    Object.keys(rows).forEach(function (row) {
      rows[row].split('').forEach(function (ch) { map[ch] = row; });
    });
    return map;
  })();

  // 「下剤」「鉄剤」のように漢字始まりの薬効分類名は、文字コードだけでは読み(五十音)が
  // わからないため、上のKANA_ROW_MAPだけでは判定できず「他」に落ちてしまう。
  // 現状登場する漢字始まりの名前について、読みの先頭カナを手動で登録しておく
  // (前方一致で判定するため、絵文字などが後ろに付いていても問題ない)。
  // 今後データが更新され、ここに無い漢字始まりの名前が増えた場合は追記が必要。
  var KANJI_READING_PREFIXES = [
    ['下剤', 'ゲ'],
    ['外用ステロイド', 'ガ'],
    ['外服薬', 'ガ'],
    ['外用薬', 'ガ'],
    ['漢方薬', 'カ'],
    ['気管支', 'キ'],
    ['抗アレルギー薬', 'コ'],
    ['抗うつ薬', 'コ'],
    ['抗てんかん薬', 'コ'],
    ['抗菌薬', 'コ'],
    ['抗凝固薬', 'コ'],
    ['抗血小板薬', 'コ'],
    ['降圧薬', 'コ'],
    ['高尿酸血症', 'コ'],
    ['脂質異常症', 'シ'],
    ['耳鼻科用薬', 'ジ'],
    ['睡眠薬', 'ス'],
    ['鎮痛剤', 'チ'],
    ['鎮痛薬', 'チ'],
    ['注射薬', 'チ'],
    ['貼付剤', 'チ'],
    ['鉄剤', 'テ'],
    ['内服薬', 'ナ'],
    ['泌尿器科用薬', 'ヒ'],
    ['保湿剤', 'ホ'],
    ['目薬', 'メ'],
    ['利尿薬', 'リ'],
    ['昌泰', 'マ']
  ];

  function gyouOf(name) {
    if (!name) return '他';
    var ch = toKatakana(name.charAt(0));
    if (KANA_ROW_MAP[ch]) return KANA_ROW_MAP[ch];
    for (var i = 0; i < KANJI_READING_PREFIXES.length; i++) {
      if (name.indexOf(KANJI_READING_PREFIXES[i][0]) === 0) {
        return KANA_ROW_MAP[KANJI_READING_PREFIXES[i][1]] || '他';
      }
    }
    return '他';
  }

  function findHeading(id) {
    for (var i = 0; i < state.headings.length; i++) {
      if (state.headings[i].id === id) return state.headings[i];
    }
    return null;
  }

  function buildHeadingItemEl(h, query, withBreadcrumb) {
    var li = document.createElement('li');
    var visualLevel = h.depth || h.level;
    li.className = 'heading-item level-' + visualLevel +
      (withBreadcrumb ? ' search-result' : '') +
      (state.selectedId === h.id ? ' selected' : '');
    li.dataset.id = h.id;

    var row = document.createElement('div');
    row.className = 'heading-row';
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-pressed', state.selectedId === h.id ? 'true' : 'false');
    row.dataset.action = 'select';
    var breadcrumbHtml = '';
    if (withBreadcrumb && h.breadcrumb && h.breadcrumb.length) {
      breadcrumbHtml = '<span class="heading-breadcrumb">' + buildBreadcrumbHtml(h.breadcrumb, query, true) + '</span>';
    }
    // 検索結果一覧では絵文字アイコン(🟠🔵など)を出さず、見出し本文をそのまま大きく太字で見せる。
    var titleHtml = withBreadcrumb
      ? highlightMatch(stripIconPrefix(h.title), query)
      : renderTitleHtml(h.title, query);
    row.innerHTML =
      breadcrumbHtml +
      '<span class="heading-title">' + titleHtml + '</span>';
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
    var query = state.filter.trim();
    var breadcrumbHtml = '';
    if (h.breadcrumb && h.breadcrumb.length) {
      breadcrumbHtml = '<div class="detail-breadcrumb">' + buildBreadcrumbHtml(h.breadcrumb, query) + '</div>';
    }
    header.innerHTML =
      breadcrumbHtml +
      '<div class="detail-header-main">' +
      '<span class="detail-title">' + renderTitleHtml(h.title, query) + '</span>' +
      '</div>';
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

  // 薬品名インデックス・薬効分類インデックスは、対象となる見出しレベルや
  // 名前のクレンジング方法が違うだけで、UI(五十音一覧→候補一覧)の構造は共通のため、
  // 表示に必要な情報をこのオブジェクトにまとめて使い回す。
  function getIndexConfig() {
    if (state.indexMode === 'category') {
      return {
        groups: state.categoryGroups,
        selectedKey: state.selectedCategoryKey,
        selectAction: 'select-category',
        backAction: 'back-to-category-list',
        emptyNoneText: 'この文書からは、個別の薬品名を持たない薬効分類が見つかりませんでした。',
        noMatchText: function (q) { return '「' + q + '」に一致する薬効分類が見つかりません。'; },
        candidateNoneText: 'この薬効分類の候補が見つかりませんでした。'
      };
    }
    return {
      groups: state.drugGroups,
      selectedKey: state.selectedDrugKey,
      selectAction: 'select-drug',
      backAction: 'back-to-drug-list',
      emptyNoneText: 'この文書からは薬品名(見出しレベル4)が見つかりませんでした。',
      noMatchText: function (q) { return '「' + q + '」に一致する薬品名が見つかりません。'; },
      candidateNoneText: 'この薬品名の候補が見つかりませんでした。'
    };
  }

  function render() {
    if (state.view === 'index') {
      drugAlphabetNavEl.hidden = !!getIndexConfig().selectedKey;
      renderIndexView();
      return;
    }
    drugAlphabetNavEl.hidden = true;
    renderTreeView();
  }

  function renderTreeView() {
    var query = state.filter.trim();

    listEl.innerHTML = '';

    if (state.headings.length === 0) {
      emptyEl.textContent = 'まだテンプレートが取り込まれていません。上の「更新」からHTMLファイルを取り込んでください。';
      return;
    }

    if (query) {
      var filtered = state.headings.filter(function (h) {
        return headingMatchesQuery(h, query);
      });
      if (filtered.length === 0) {
        emptyEl.textContent = '「' + query + '」に一致する見出しが見つかりません。';
        return;
      }
      emptyEl.textContent = '';
      var frag = document.createDocumentFragment();
      filtered.forEach(function (h) {
        frag.appendChild(buildHeadingItemEl(h, query, true));
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

  // インデックス(薬品名/薬効分類 共通): 名前一覧(五十音別)、または
  // 選択中の名前に紐づく候補一覧を描画する。
  function renderIndexView() {
    listEl.innerHTML = '';
    var config = getIndexConfig();

    if (state.headings.length === 0) {
      emptyEl.textContent = 'まだテンプレートが取り込まれていません。上の「更新」からHTMLファイルを取り込んでください。';
      drugAlphabetNavEl.innerHTML = '';
      return;
    }

    if (config.selectedKey) {
      renderIndexCandidates(config);
      return;
    }

    var query = state.filter.trim();
    var groups = config.groups.filter(function (g) {
      return !query || normalizeForSearch(g.name).indexOf(normalizeForSearch(query)) !== -1;
    });

    if (config.groups.length === 0) {
      emptyEl.textContent = config.emptyNoneText;
      renderDrugAlphabetNav([]);
      return;
    }
    if (groups.length === 0) {
      emptyEl.textContent = config.noMatchText(query);
      renderDrugAlphabetNav([]);
      return;
    }
    emptyEl.textContent = '';

    var byGyou = {};
    groups.forEach(function (g) {
      var gy = gyouOf(g.name);
      if (!byGyou[gy]) byGyou[gy] = [];
      byGyou[gy].push(g);
    });

    renderDrugAlphabetNav(GYOU_LIST.filter(function (gy) { return byGyou[gy] && byGyou[gy].length; }));

    var frag = document.createDocumentFragment();
    GYOU_LIST.forEach(function (gy) {
      if (!byGyou[gy] || !byGyou[gy].length) return;

      var labelLi = document.createElement('li');
      labelLi.className = 'drug-gyou-label';
      labelLi.id = 'drugGyou-' + gy;
      labelLi.textContent = gy === '他' ? '英数字・その他' : gy + '行';
      frag.appendChild(labelLi);

      byGyou[gy].forEach(function (g) {
        var li = document.createElement('li');
        li.className = 'drug-name-item';
        var row = document.createElement('div');
        row.className = 'drug-name-row';
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.dataset.action = config.selectAction;
        row.dataset.key = g.key;
        row.innerHTML =
          '<span class="drug-name-text">' + highlightMatch(g.name, query) + '</span>' +
          '<span class="drug-name-count">' + g.entryIds.length + '件</span>';
        li.appendChild(row);
        frag.appendChild(li);
      });
    });
    listEl.appendChild(frag);
  }

  function renderIndexCandidates(config) {
    var group = config.groups.filter(function (g) { return g.key === config.selectedKey; })[0];
    if (!group) {
      if (state.indexMode === 'category') state.selectedCategoryKey = null;
      else state.selectedDrugKey = null;
      renderIndexView();
      return;
    }

    var entries = group.entryIds.map(findHeading).filter(Boolean);

    var backLi = document.createElement('li');
    backLi.className = 'drug-back-row';
    var backRow = document.createElement('div');
    backRow.className = 'drug-back-button';
    backRow.tabIndex = 0;
    backRow.setAttribute('role', 'button');
    backRow.dataset.action = config.backAction;
    backRow.textContent = '← 一覧に戻る';
    backLi.appendChild(backRow);
    listEl.appendChild(backLi);

    var titleLi = document.createElement('li');
    titleLi.className = 'drug-selected-heading';
    titleLi.textContent = group.name + 'の候補(' + entries.length + '件)';
    listEl.appendChild(titleLi);

    if (entries.length === 0) {
      emptyEl.textContent = config.candidateNoneText;
      return;
    }
    emptyEl.textContent = '';

    var frag = document.createDocumentFragment();
    entries.forEach(function (h) {
      frag.appendChild(buildHeadingItemEl(h, '', true));
    });
    listEl.appendChild(frag);
  }

  function renderDrugAlphabetNav(availableGyouList) {
    drugAlphabetNavEl.innerHTML = GYOU_LIST.map(function (gy) {
      var disabled = availableGyouList.indexOf(gy) === -1;
      return '<button type="button" class="drug-gyou-jump" data-gyou="' + gy + '"' + (disabled ? ' disabled' : '') + '>' + gy + '</button>';
    }).join('');
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
    detailPaneEl.scrollTop = 0;
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
      return;
    }

    if (actionEl.dataset.action === 'select-drug') {
      state.selectedDrugKey = actionEl.dataset.key;
      render();
      return;
    }

    if (actionEl.dataset.action === 'back-to-drug-list') {
      state.selectedDrugKey = null;
      render();
      return;
    }

    if (actionEl.dataset.action === 'select-category') {
      state.selectedCategoryKey = actionEl.dataset.key;
      render();
      return;
    }

    if (actionEl.dataset.action === 'back-to-category-list') {
      state.selectedCategoryKey = null;
      render();
    }
  });

  listEl.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var actionEl = e.target.closest(
      '[data-action="select"], [data-action="toggle-group"], ' +
      '[data-action="select-drug"], [data-action="back-to-drug-list"], ' +
      '[data-action="select-category"], [data-action="back-to-category-list"]'
    );
    if (!actionEl) return;
    e.preventDefault();
    actionEl.click();
  });

  drugAlphabetNavEl.addEventListener('click', function (e) {
    var btn = e.target.closest('.drug-gyou-jump');
    if (!btn || btn.disabled) return;
    var target = document.getElementById('drugGyou-' + btn.dataset.gyou);
    if (target) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });

  function updateSearchPlaceholder() {
    if (state.view !== 'index') {
      searchInput.placeholder = '🔍 見出しを検索…';
      return;
    }
    searchInput.placeholder = state.indexMode === 'category' ? '🔍 薬効分類名を検索…' : '🔍 薬品名を検索…';
  }

  viewTabButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var view = btn.dataset.view;
      if (state.view === view) return;
      state.view = view;
      indexSubtabsEl.hidden = view !== 'index';
      updateSearchPlaceholder();
      viewTabButtons.forEach(function (b) {
        var active = b === btn;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      render();
    });
  });

  indexSubtabButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var mode = btn.dataset.indexMode;
      if (state.indexMode === mode) return;
      state.indexMode = mode;
      updateSearchPlaceholder();
      indexSubtabButtons.forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      render();
    });
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
      state.drugGroups = TemplateParser.buildDrugIndex(headings);
      state.categoryGroups = TemplateParser.buildCategoryIndex(headings);
      state.selectedId = null;
      state.selectedDrugKey = null;
      state.selectedCategoryKey = null;
      state.filter = '';
      state.expandedGroupIds = {};
      searchInput.value = '';
      render();
      renderDetailPane();

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

  // 手動でのHTML取り込みUIは廃止した(共有テンプレートの更新はリポジトリの
  // data/template.htmlを直接差し替える運用に統一したため)。
  // ただし自動テストからはHTML文字列を直接取り込めると都合が良いため、
  // importHtmlをテスト用フックとして公開しておく。
  window.__importHtmlForTest = importHtml;

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
          state.drugGroups = TemplateParser.buildDrugIndex(restored);
          state.categoryGroups = TemplateParser.buildCategoryIndex(restored);
          setStatus('共有テンプレートを取得できなかったため、このブラウザに保存されていた内容を復元しました(見出し' + restored.length + '件)。', 'error');
        } else {
          setStatus('共有テンプレートを取得できませんでした。オフラインの場合は接続を確認するか、下の「更新」からHTMLファイルを取り込んでください。', 'error');
        }
        render();
        renderDetailPane();
      });
  })();
})();
