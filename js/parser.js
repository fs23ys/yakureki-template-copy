/**
 * 薬歴テンプレコピー - HTML解析ロジック
 *
 * Googleドキュメントを「ファイル→ダウンロード→ウェブページ(HTML)」で
 * 書き出したHTMLを解析し、見出し(h1〜h6)ごとに「コピー対象ブロック」を抽出する。
 *
 * ブラウザ(<script src="js/parser.js">)からは window.TemplateParser として、
 * Node.js(テスト用)からは require('./parser.js') として利用できる。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TemplateParser = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var HEADING_TAGS = { H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6 };
  var START_MARK = '##S##';

  /**
   * 要素のテキストを「行」の配列にする。
   * <br> は改行として扱い、&nbsp; は通常の空白として扱う。
   */
  function extractLines(doc, el) {
    var clone = el.cloneNode(true);
    var brs = clone.querySelectorAll('br');
    for (var i = 0; i < brs.length; i++) {
      brs[i].replaceWith(doc.createTextNode('\n'));
    }
    var text = clone.textContent.replace(/ /g, ' ');
    return text.split('\n').map(function (line) {
      return line.trim();
    });
  }

  function trimBlankEdges(lines) {
    var start = 0;
    var end = lines.length;
    while (start < end && lines[start] === '') start++;
    while (end > start && lines[end - 1] === '') end--;
    return lines.slice(start, end);
  }

  /**
   * @param {string} htmlString GoogleドキュメントからエクスポートされたHTML文字列
   * @param {Function} [DOMParserImpl] 明示的に使うDOMParser実装(Node.jsのテストではjsdomのものを渡す)
   * @returns {Array<{id:string, level:number, title:string, block:string, rawText:string}>}
   */
  function parseTemplateHtml(htmlString, DOMParserImpl) {
    if (typeof htmlString !== 'string' || htmlString.trim() === '') {
      throw new Error('HTMLの内容が空です。ファイルを確認してください。');
    }

    var DP = DOMParserImpl || (typeof DOMParser !== 'undefined' ? DOMParser : null);
    if (!DP) {
      throw new Error('この環境ではDOMParserが利用できません。');
    }

    var doc = new DP().parseFromString(htmlString, 'text/html');
    var body = doc.body;
    if (!body) {
      throw new Error('HTMLの解析に失敗しました(body要素が見つかりません)。');
    }

    var headings = [];
    var current = null;

    var walker = doc.createTreeWalker(body, 1 /* NodeFilter.SHOW_ELEMENT */);
    var node = walker.nextNode();
    while (node) {
      var tag = node.tagName;
      if (Object.prototype.hasOwnProperty.call(HEADING_TAGS, tag)) {
        var title = node.textContent.replace(/ /g, ' ').trim();
        current = {
          id: 'h' + headings.length,
          level: HEADING_TAGS[tag],
          title: title,
          lines: []
        };
        headings.push(current);
      } else if (tag === 'P' && current) {
        var lines = extractLines(doc, node);
        Array.prototype.push.apply(current.lines, lines);
      }
      node = walker.nextNode();
    }

    if (headings.length === 0) {
      throw new Error('見出し(h1〜h6)が見つかりませんでした。Googleドキュメントのエクスポート形式(ウェブページ.html)を確認してください。');
    }

    var results = headings.map(function (h) {
      var startIndex = -1;
      for (var i = 0; i < h.lines.length; i++) {
        if (h.lines[i].indexOf(START_MARK) !== -1) {
          startIndex = i;
          break;
        }
      }
      var blockLines = startIndex === -1 ? h.lines.slice() : h.lines.slice(startIndex);
      blockLines = trimBlankEdges(blockLines);

      return {
        id: h.id,
        level: h.level,
        title: h.title,
        block: blockLines.join('\n'),
        rawText: trimBlankEdges(h.lines).join('\n')
      };
    });

    applyEffectiveBlocks(results);
    return results;
  }

  // この件数を超える子孫ブロックが見つかった場合は、無関係な内容まで
  // まとめて連結表示してしまうのを避けるため、自動集約しない
  // (H1/H2のような大きな区分見出しでは、配下に何十件ものブロックが
  // 存在することがあり、それらを1つの詳細パネルに連結しても実用的でないため)。
  var MAX_AGGREGATE_BLOCKS = 6;

  /**
   * 見出し自体に本文(##S##ブロック)が無い場合(下位の子見出しにしか
   * 本文が無いグルーピング用の見出しなど)、その配下(次の同格以上の
   * 見出しが現れるまでの範囲)にある本文を持つ子孫見出しのブロックを
   * *すべて* effectiveBlocks(配列)として個別に保持する(1件だけとは限らない)。
   * ただし件数が MAX_AGGREGATE_BLOCKS を超える場合は自動集約せず空にする
   * (tooManyToAggregate フラグを立てる)。
   * プレビュー/コピーは block ではなく effectiveBlocks を使い、
   * 複数ある場合はそれぞれ別ブロックとして表示・コピーする。
   */
  /**
   * 見出しレベル(h1〜h6)は文書内で必ずしも1段ずつ増減するとは限らず、
   * 「H5の次にH2、その次にまたH5」のように大きく前後することがある。
   * 生のレベル番号でインデント幅を決めると、行ごとにインデントが不規則に
   * ジャンプして見た目が揃わなくなるため、実際の入れ子の深さ(depth)を
   * スタックで計算し直し、インデント・文字サイズなどの見た目はこちらを使う。
   * (バッジに表示する「H2」などのラベルは、引き続き生のlevelを使う)
   *
   * 同じスタックを使って、各見出しから見た祖先見出しのタイトル一覧(breadcrumb)も
   * 一緒に計算する。検索結果やツリーからの選択時に「DO ＞ 皮膚科用薬 ＞ …」のような
   * パンくずリストを表示するために使う。
   */
  function computeVisualDepth(results) {
    var stack = [];
    for (var i = 0; i < results.length; i++) {
      var level = results[i].level;
      while (stack.length && stack[stack.length - 1].level >= level) {
        stack.pop();
      }
      results[i].breadcrumb = stack
        .map(function (s) { return s.title; })
        .filter(function (t) { return t && t.trim() !== ''; });
      // 祖先見出し(id/level/title)をそのまま保持しておく。「◯◯自動入力」機能で、
      // ある本文ブロックの祖先にあるレベル4見出し(薬品名見出し)を探すために使う。
      results[i].ancestors = stack.slice();
      stack.push({ id: results[i].id, level: level, title: results[i].title });
      results[i].depth = stack.length;
    }
  }

  /**
   * 見出しの祖先の中から、指定したlevelに一致する最も近いものを返す。
   * 見つからなければnull。
   */
  function findAncestorByLevel(heading, level) {
    var ancestors = (heading && heading.ancestors) || [];
    for (var i = ancestors.length - 1; i >= 0; i--) {
      if (ancestors[i].level === level) return ancestors[i];
    }
    return null;
  }

  function applyEffectiveBlocks(results) {
    computeVisualDepth(results);
    for (var idx = 0; idx < results.length; idx++) {
      var r = results[idx];
      r.tooManyToAggregate = false;
      if (r.block) {
        r.effectiveBlocks = [{ id: r.id, title: r.title, block: r.block }];
        continue;
      }
      var blocks = [];
      var pathStack = [];
      for (var j = idx + 1; j < results.length && results[j].level > r.level; j++) {
        while (pathStack.length && pathStack[pathStack.length - 1].level >= results[j].level) {
          pathStack.pop();
        }
        pathStack.push({ level: results[j].level, title: results[j].title });
        if (results[j].block) {
          var breadcrumb = pathStack.map(function (p) { return p.title; }).join(' ▸ ');
          blocks.push({ id: results[j].id, title: breadcrumb, block: results[j].block });
        }
      }
      if (blocks.length > MAX_AGGREGATE_BLOCKS) {
        r.effectiveBlocks = [];
        r.tooManyToAggregate = true;
      } else {
        r.effectiveBlocks = blocks;
      }
    }
  }

  // ①〜⑳等の丸数字(Unicode「囲み数字」ブロック)を見出し先頭から取り除くための正規表現。
  var CIRCLED_NUMBER_RE = /^[①-⓿㉑-㊿]+\s*/;

  /**
   * 見出しレベル4のタイトルから「薬品名」だけを取り出す。
   * 例: 「① ロキソプロフェン」→「ロキソプロフェン」
   *     「① レキサルティ（認知症に伴う精神症状安定）」→「レキサルティ」(括弧内は補足情報)
   */
  function cleanDrugName(rawTitle) {
    var t = String(rawTitle || '').replace(CIRCLED_NUMBER_RE, '');
    var m = t.match(/[（(]/);
    if (m) t = t.slice(0, m.index);
    return t.trim();
  }

  /**
   * 見出しレベル4(薬品名見出し)のタイトルから、「◯◯自動入力」機能の
   * 薬剤名欄に使う初期値・候補チップを取り出す。
   * - 括弧が無い、または括弧内が読点/カンマで区切られていない(単一の補足文)場合は、
   *   括弧より前を薬品名として初期値にする(candidatesは空)。
   *   例:「① アムロジピン（歯茎の腫れ・浮腫なし）」→ name:「アムロジピン」
   * - 括弧内が読点/カンマ区切りで2件以上に分かれる場合は、薬品名が列挙されている
   *   とみなし、初期値は空にしてcandidatesにそれぞれを返す(末尾の「等」「など」、
   *   「…」等の省略記号のみの項目は除く)。
   *   例:「② PPI（エソメプラゾール、ランソプラゾール等）」→ name:「」, candidates:["エソメプラゾール","ランソプラゾール"]
   */
  function parseDrugHeadingTitle(rawTitle) {
    var t = String(rawTitle || '').replace(CIRCLED_NUMBER_RE, '').trim();
    var m = t.match(/[（(]([^）)]*)[）)]/);
    if (!m) return { name: t, candidates: [] };

    var name = t.slice(0, m.index).trim();
    var rawParts = m[1].split(/[、，,]/);
    if (rawParts.length < 2) {
      return { name: name, candidates: [] };
    }

    var candidates = rawParts
      .map(function (s) { return s.trim().replace(/(等|など)$/, '').trim(); })
      .filter(function (s) { return s !== '' && !/^[…‥.・]+$/.test(s); });
    // 「リクシアナ（腎機能低下により、30→15mgへ減量）」のように読点を含む補足文は
    // 薬品名の列挙ではない。ひらがな・矢印を含む項目があれば列挙とみなさない。
    if (candidates.some(function (s) { return /[ぁ-ん→]/.test(s); })) {
      return { name: name, candidates: [] };
    }
    return { name: '', candidates: candidates };
  }

  // 「◯◯」「○○」「〇〇」の表記ゆれ、括弧の全角/半角ゆれを許容するプレースホルダー正規表現。
  // 括弧内の文字列を「ラベル」とする(薬剤名／副作用／治療薬／薬効等)。括弧が無い場合はラベル無し。
  var PLACEHOLDER_RE = /[◯○〇]{2}(?:[（(]([^）)]*)[）)])?/g;
  var PLACEHOLDER_OTHER_LABEL = 'その他';

  /**
   * テキスト中に出現する◯◯プレースホルダーのラベル一覧を、出現順(重複除去)で返す。
   */
  function extractPlaceholders(text) {
    var order = [];
    var seen = {};
    var re = new RegExp(PLACEHOLDER_RE.source, 'g');
    var m;
    while ((m = re.exec(text))) {
      var label = (m[1] || '').trim() || PLACEHOLDER_OTHER_LABEL;
      if (!seen[label]) {
        seen[label] = true;
        order.push(label);
      }
    }
    return order;
  }

  /**
   * テキストを、プレースホルダー部分とそれ以外に分割したセグメント列にする。
   * valuesByLabelにそのラベルの入力値(trim後、空でない)があれば type:'filled'、
   * 無ければ type:'empty'(元の◯◯表記のまま)を返す。
   * プレビューのハイライト表示・コピー時の置換の両方で共通して使う。
   */
  function buildPlaceholderSegments(text, valuesByLabel) {
    var segments = [];
    var lastIndex = 0;
    var re = new RegExp(PLACEHOLDER_RE.source, 'g');
    var m;
    while ((m = re.exec(text))) {
      if (m.index > lastIndex) {
        segments.push({ type: 'text', value: text.slice(lastIndex, m.index) });
      }
      var label = (m[1] || '').trim() || PLACEHOLDER_OTHER_LABEL;
      var raw = valuesByLabel && Object.prototype.hasOwnProperty.call(valuesByLabel, label)
        ? valuesByLabel[label]
        : '';
      var value = String(raw || '').trim();
      if (value) {
        segments.push({ type: 'filled', label: label, value: value });
      } else {
        segments.push({ type: 'empty', label: label, raw: m[0] });
      }
      lastIndex = m.index + m[0].length;
    }
    if (lastIndex < text.length) {
      segments.push({ type: 'text', value: text.slice(lastIndex) });
    }
    return segments;
  }

  /**
   * 入力値でプレースホルダーを置換した最終テキストを返す(コピー用)。
   * 前後の文章は一切変更しない(置換のみ)。未入力のラベルは◯◯表記のまま残す。
   */
  function applyPlaceholders(text, valuesByLabel) {
    return buildPlaceholderSegments(text, valuesByLabel).map(function (seg) {
      if (seg.type === 'text') return seg.value;
      if (seg.type === 'filled') return seg.value;
      return seg.raw;
    }).join('');
  }

  /**
   * 未入力のまま残る◯◯プレースホルダーが1つでもあればtrue。
   */
  function hasUnfilledPlaceholder(text, valuesByLabel) {
    return buildPlaceholderSegments(text, valuesByLabel).some(function (seg) {
      return seg.type === 'empty';
    });
  }

  // 見出し先頭の絵文字アイコン(🔵等)を取り除くための正規表現(parser.js内でも
  // 薬効分類名のクレンジングに使うため、app.js側のstripIconPrefixとは別に用意する)。
  var ICON_PREFIX_RE_FOR_PARSER = new RegExp('^(\\p{Extended_Pictographic}\\uFE0F?)\\s*', 'u');
  // 「No.19」「No.4」のような通し番号ラベルを取り除くための正規表現。
  var NO_LABEL_RE = /^No\.?\s*\d+\s*/i;

  /**
   * 見出しレベル3(薬効分類見出し、「🔵 No.X 〇〇」形式)のタイトルから
   * 「🔵」や「No.X」を取り除き、薬効分類名だけを取り出す。
   * 例: 「🔵 No.1 睡眠薬」→「睡眠薬」
   */
  function cleanCategoryName(rawTitle) {
    var t = String(rawTitle || '').replace(ICON_PREFIX_RE_FOR_PARSER, '');
    t = t.replace(NO_LABEL_RE, '');
    return t.trim();
  }

  // 指定した見出し(idx番目、レベルr.level)の配下(次の同格以上の見出しが
  // 現れるまでの範囲)に、レベル4の見出しが1つでも存在するかを調べる。
  function hasDirectLevel4Descendant(results, idx) {
    var r = results[idx];
    for (var j = idx + 1; j < results.length && results[j].level > r.level; j++) {
      if (results[j].level === 4) return true;
    }
    return false;
  }

  /**
   * 見出しを名前(薬品名 または 薬効分類名)ごとにグルーピングし、
   * 「薬品名インデックス」「薬効分類インデックス」共通のデータ構造を作る。
   * - 表記ゆれ(全角/半角など)は Unicode正規化(NFKC)してから同一名として名寄せする。
   * - 各項目の実体(候補)は、その見出しのeffectiveBlocks(本文を持つ子孫見出しへの
   *   集約結果。無ければ自分自身)の id をそのまま使う。実際の表示(パンくず・本文)は
   *   このidから見出し本体を引いて使う想定(呼び出し側でfindHeadingするなど)。
   */
  function buildNameIndex(results, isTarget, nameOf) {
    var groupMap = {};
    var order = [];

    results.forEach(function (h, idx) {
      if (!isTarget(h, idx)) return;
      var name = nameOf(h);
      if (!name) return;
      var key = name.normalize ? name.normalize('NFKC') : name;
      if (!groupMap[key]) {
        groupMap[key] = { name: name, key: key, entryIds: [] };
        order.push(key);
      }
      var blocks = h.effectiveBlocks || [];
      blocks.forEach(function (b) {
        groupMap[key].entryIds.push(b.id);
      });
    });

    var groups = order
      .map(function (key) { return groupMap[key]; })
      .filter(function (g) { return g.entryIds.length > 0; });

    groups.sort(function (a, b) { return a.name.localeCompare(b.name, 'ja'); });

    return groups;
  }

  // 「① ロキソプロフェン」のように丸数字で始まるタイトルは、本来はレベル4に
  // 置かれるはずの具体的な薬品名。原本のGoogleドキュメントには、レベル4を
  // 挟まずレベル3の位置に直接こうした薬品名見出しを書いている箇所があるため、
  // レベル3であっても丸数字始まりのタイトルは「薬効分類」ではなく「薬品名」として扱う。
  function isDrugLikeTitle(rawTitle) {
    return CIRCLED_NUMBER_RE.test(String(rawTitle || '').trim());
  }

  /**
   * 「薬品名インデックス」: 見出しレベル4(具体的な薬品名見出し)、および
   * レベル3でも丸数字始まりで実質的に薬品名そのものを名乗っているものを対象にする。
   */
  function buildDrugIndex(results) {
    return buildNameIndex(
      results,
      function (h, idx) {
        if (h.level === 4) return true;
        return h.level === 3 && !hasDirectLevel4Descendant(results, idx) && isDrugLikeTitle(h.title);
      },
      function (h) { return cleanDrugName(h.title); }
    );
  }

  /**
   * 「薬効分類インデックス」: 見出しレベル3のうち、配下にレベル4を1つも
   * 持たず(=個別の薬品名が存在せず、薬効分類全体で1つのテンプレしかないケース)、
   * かつタイトルが薬品名らしい丸数字始まりでもないものを対象にする。
   * 判定は薬効分類名ごとではなく、見出しの出現箇所ごと(インスタンス単位)に行う。
   */
  function buildCategoryIndex(results) {
    return buildNameIndex(
      results,
      function (h, idx) {
        return h.level === 3 && !hasDirectLevel4Descendant(results, idx) && !isDrugLikeTitle(h.title);
      },
      function (h) { return cleanCategoryName(h.title); }
    );
  }

  return {
    parseTemplateHtml: parseTemplateHtml,
    applyEffectiveBlocks: applyEffectiveBlocks,
    cleanDrugName: cleanDrugName,
    cleanCategoryName: cleanCategoryName,
    buildDrugIndex: buildDrugIndex,
    buildCategoryIndex: buildCategoryIndex,
    findAncestorByLevel: findAncestorByLevel,
    parseDrugHeadingTitle: parseDrugHeadingTitle,
    extractPlaceholders: extractPlaceholders,
    buildPlaceholderSegments: buildPlaceholderSegments,
    applyPlaceholders: applyPlaceholders,
    hasUnfilledPlaceholder: hasUnfilledPlaceholder
  };
});
