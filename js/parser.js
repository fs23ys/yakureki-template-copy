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
  function applyEffectiveBlocks(results) {
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

  return {
    parseTemplateHtml: parseTemplateHtml,
    applyEffectiveBlocks: applyEffectiveBlocks
  };
});
