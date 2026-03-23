/*
  parser.js
  - 文本清洗与解析：噪音过滤、分隔策略、词性识别、行解析为 {term,pos,meaning}
  - 关键函数：parseText（解析入口）、parseLine（单行解析）、buildLexiconObject（对象模式输出构建）
*/
(() => {
  const LexiForge = (window.LexiForge = window.LexiForge || {});
  const { escapeRegExp, splitLines, isSeparatorLine } = LexiForge.Utils;

  const POS_TOKENS = [
    "loc.prep.",
    "loc.conj.",
    "loc.adv.",
    "m.pl.",
    "f.pl.",
    "interj.",
    "prnl.",
    "intr.",
    "p.p.",
    "pron.",
    "prep.",
    "conj.",
    "num.",
    "adj.",
    "adv.",
    "vt.",
    "vi.",
    "tr.",
    "m.",
    "f.",
    "n.",
    "v.",
  ]
    .slice()
    .sort((a, b) => b.length - a.length);

  const POS_ALT = POS_TOKENS.map(escapeRegExp).join("|");
  const LEADING_POS_RE = new RegExp(`^(${POS_ALT})\\s+`, "i");
  const POS_ANYWHERE_RE = new RegExp(`\\s(${POS_ALT})(?=\\s+)`, "i");

  // Markdown：内联语法去除（强调/链接/代码等），供表格/列表/段落复用
  function stripMarkdownInlineSyntax(text) {
    let s = String(text == null ? "" : text);
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1");
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
    s = s.replace(/`([^`]+)`/g, "$1");
    s = s.replace(/~~([^~]+)~~/g, "$1");
    s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
    s = s.replace(/__([^_]+)__/g, "$1");
    s = s.replace(/\*([^*]+)\*/g, "$1");
    s = s.replace(/_([^_]+)_/g, "$1");
    s = s.replace(/<\/?[^>]+>/g, "");
    s = s.replace(/\\([\\`*_{}\[\]()#+\-.!|>])/g, "$1");
    s = s.replace(/\u00a0/g, " ").replace(/[\u200b-\u200d\uFEFF]/g, "");
    return s.replace(/\s+/g, " ").trim();
  }

  // Markdown：按行归一化（去掉 fenced code block，保留文本结构）
  function normalizeMarkdownLines(text) {
    const rawLines = splitLines(String(text || ""));
    const out = [];
    let inFence = false;
    let fenceToken = "";
    for (const rawLine of rawLines) {
      const line = String(rawLine == null ? "" : rawLine).replace(/\u00a0/g, " ").replace(/[\u200b-\u200d\uFEFF]/g, "");
      const trimmed = line.trim();
      const fenceMatch = trimmed.match(/^(```+|~~~+)\s*/);
      if (fenceMatch) {
        const token = fenceMatch[1];
        if (!inFence) {
          inFence = true;
          fenceToken = token[0];
        } else if (token[0] === fenceToken) {
          inFence = false;
          fenceToken = "";
        }
        continue;
      }
      if (inFence) continue;
      out.push(line);
    }
    return out;
  }

  // Markdown：表格分隔行（| --- | :---: |）判定
  function isMarkdownTableSeparatorCells(cells) {
    const list = Array.isArray(cells) ? cells : [];
    if (list.length < 2) return false;
    for (const c of list) {
      const s = String(c || "").trim();
      if (!s) return false;
      if (!/^:?-{3,}:?$/.test(s.replace(/\s+/g, ""))) return false;
    }
    return true;
  }

  // Markdown：稳定拆分表格行（处理首尾竖线与 \| 转义）
  function splitMarkdownRowToCells(row) {
    const s = String(row == null ? "" : row);
    const cells = [];
    let cur = "";
    let esc = false;
    for (let i = 0; i < s.length; i += 1) {
      const ch = s[i];
      if (esc) {
        cur += ch;
        esc = false;
        continue;
      }
      if (ch === "\\") {
        esc = true;
        continue;
      }
      if (ch === "|") {
        cells.push(cur);
        cur = "";
        continue;
      }
      cur += ch;
    }
    cells.push(cur);

    const trimmed = s.trim();
    let out = cells;
    if (trimmed.startsWith("|")) out = out.slice(1);
    if (trimmed.endsWith("|")) out = out.slice(0, -1);
    return out.map((c) => String(c == null ? "" : c).trim());
  }

  function isMarkdownTableRowLine(line) {
    const s = String(line || "");
    const trimmed = s.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith("#")) return false;
    if (trimmed.startsWith(">")) return false;
    const pipeCount = (trimmed.match(/\|/g) || []).length;
    if (pipeCount < 2) return false;
    const cells = splitMarkdownRowToCells(trimmed);
    return cells.length >= 2;
  }

  // Markdown：解析连续表格块为标准 entries（忽略表头与分隔行）
  function parseMarkdownTable(lines) {
    try {
      const list = Array.isArray(lines) ? lines : [];
      if (!list.length) return [];

      let startIndex = 0;
      if (list.length >= 2) {
        const maybeSep = splitMarkdownRowToCells(list[1]);
        if (isMarkdownTableSeparatorCells(maybeSep)) startIndex = 2;
      }

      const out = [];
      for (let i = startIndex; i < list.length; i += 1) {
        const row = String(list[i] || "").trim();
        if (!row) continue;
        const rawCells = splitMarkdownRowToCells(row);
        if (isMarkdownTableSeparatorCells(rawCells)) continue;
        if (rawCells.length < 3) continue;

        const cells = rawCells.map((c) => stripMarkdownInlineSyntax(c));
        const term = normalizeTerm(cells[0]);
        const pos = String(cells[1] || "").replace(/\s+/g, " ").trim();
        let meaning = stripMarkdownInlineSyntax(cells[2]);
        if (cells.length > 3) {
          meaning = [meaning, ...cells.slice(3)].filter(Boolean).join(" | ");
        }
        const normalizedMeaning = normalizeMeaning(meaning);
        if (!term || !normalizedMeaning) continue;
        out.push({ term, pos: pos || "", meaning: normalizedMeaning });
      }
      return out;
    } catch (err) {
      return [];
    }
  }

  function parseMarkdownListItem(line) {
    const trimmed = String(line || "").trim();
    const m = trimmed.match(/^(\s*[-*+]\s+)(\[[ xX]\]\s+)?(.*)$/);
    if (!m) return null;
    const body = String(m[3] || "").trim();
    if (!body) return null;

    if ((body.match(/\|/g) || []).length >= 2) {
      const rawCells = splitMarkdownRowToCells(body);
      if (rawCells.length >= 3) {
        const cells = rawCells.map((c) => stripMarkdownInlineSyntax(c));
        const term = normalizeTerm(cells[0]);
        const pos = String(cells[1] || "").replace(/\s+/g, " ").trim();
        const meaning = normalizeMeaning([cells[2], ...cells.slice(3)].filter(Boolean).join(" | "));
        if (!term || !meaning) return null;
        return { term, pos: pos || "", meaning };
      }
    }

    const bodyPlain = stripMarkdownInlineSyntax(body);
    const idx = bodyPlain.indexOf("：") >= 0 ? bodyPlain.indexOf("：") : bodyPlain.indexOf(":");
    if (idx > 0) {
      const term = normalizeTerm(bodyPlain.slice(0, idx).trim());
      const meaningPart = bodyPlain.slice(idx + 1).trim();
      if (!term || !meaningPart) return null;
      const { pos, meaning } = extractLeadingPos(meaningPart);
      const normalizedMeaning = normalizeMeaning(meaning);
      if (!normalizedMeaning) return null;
      return { term, pos: pos || "", meaning: normalizedMeaning };
    }

    return null;
  }

  // Markdown：输入检测（表格优先；列表/标题为辅助信号）
  function isMarkdownInput(text) {
    const lines = normalizeMarkdownLines(text);
    let tableSepCount = 0;
    let tableRowCount = 0;
    let mdSignalCount = 0;
    for (let i = 0; i < lines.length && i < 80; i += 1) {
      const s = String(lines[i] || "").trim();
      if (!s) continue;
      if (/^#{1,6}\s+/.test(s)) mdSignalCount += 1;
      if (/^\s*[-*+]\s+/.test(s)) mdSignalCount += 1;
      if (/\*\*[^*]+\*\*/.test(s) || /`[^`]+`/.test(s) || /\[[^\]]+\]\([^)]+\)/.test(s)) mdSignalCount += 1;

      if (isMarkdownTableRowLine(s)) {
        tableRowCount += 1;
        const cells = splitMarkdownRowToCells(s);
        if (isMarkdownTableSeparatorCells(cells)) tableSepCount += 1;
      }
    }
    if (tableSepCount >= 1) return true;
    if (tableRowCount >= 4 && mdSignalCount >= 1) return true;
    if (mdSignalCount >= 3 && tableRowCount >= 2) return true;
    return false;
  }

  function cleanRawLine(line) {
    return String(line || "")
      .replace(/\u00a0/g, " ")
      .replace(/[\u200b-\u200d\uFEFF]/g, "")
      .trim();
  }

  function isNoiseLine(line) {
    const s = String(line || "").trim();
    if (!s) return true;
    if (isSeparatorLine(s)) return true;

    if (/^===.+===$/.test(s)) return true;
    if (/^==+\s*.+\s*==+$/.test(s)) return true;
    if (/^(Lesson|Unit|Chapter)\s*\d+(\b|$)/i.test(s)) return true;
    if (/^第\s*\d+\s*(课|单元|章)\b/.test(s)) return true;
    if (/^(词书名|书名|标题)\s*[:：]/.test(s)) return true;
    if (/^(TXT|JSON)\s*$/i.test(s)) return true;
    if (/^(格式说明|使用说明|说明)\s*[:：]?/.test(s)) return true;
    if (/^每行\s*[:：]/.test(s)) return true;
    if (/^\s*(term)\s*(<TAB>|tab|制表符)\s*(meaning)\s*$/i.test(s)) return true;

    return false;
  }

  function extractLeadingPos(meaningText) {
    const s = String(meaningText || "").trim();
    const m = s.match(LEADING_POS_RE);
    if (!m) return { pos: "", meaning: s };
    return { pos: m[1], meaning: s.slice(m[0].length).trim() };
  }

  function splitTermMeaning(line) {
    const raw = String(line || "").trim();
    if (!raw) return null;

    if (raw.includes("\t")) {
      const parts = raw.split("\t");
      const term = parts[0] == null ? "" : parts[0].trim();
      const meaning = parts.slice(1).join("\t").trim();
      return { term, meaning };
    }

    const m2 = raw.match(/^(.*?)\s{2,}(.+)$/);
    if (m2) return { term: m2[1].trim(), meaning: m2[2].trim() };

    const mPos = raw.match(POS_ANYWHERE_RE);
    if (mPos && typeof mPos.index === "number") {
      const idx = mPos.index;
      const term = raw.slice(0, idx).trim();
      const meaning = raw.slice(idx).trim();
      return { term, meaning };
    }

    const cjkIdx = raw.search(/[\u4e00-\u9fff]/);
    if (cjkIdx > 0) {
      const before = raw.slice(0, cjkIdx);
      const lastSpace = before.lastIndexOf(" ");
      if (lastSpace > 0) {
        const term = raw.slice(0, lastSpace).trim();
        const meaning = raw.slice(lastSpace).trim();
        return { term, meaning };
      }
    }

    const m1 = raw.match(/^(\S+)\s+(.+)$/);
    if (m1) return { term: m1[1].trim(), meaning: m1[2].trim() };

    return null;
  }

  function normalizeTerm(term) {
    return String(term || "").replace(/\s+/g, " ").trim();
  }

  function normalizeMeaning(meaning) {
    return String(meaning || "").replace(/\s+/g, " ").trim();
  }

  function parseLine(line) {
    const s = cleanRawLine(line);
    if (!s) return { ok: false, reason: "empty" };
    if (isNoiseLine(s)) return { ok: false, reason: "noise" };

    const parts = splitTermMeaning(s);
    if (!parts) return { ok: false, reason: "split_failed" };

    const term = normalizeTerm(parts.term);
    let meaningPart = normalizeMeaning(parts.meaning);

    if (!term || !meaningPart) return { ok: false, reason: "missing_fields" };

    const { pos, meaning } = extractLeadingPos(meaningPart);
    const normalizedMeaning = normalizeMeaning(meaning);
    if (!normalizedMeaning) return { ok: false, reason: "missing_meaning" };

    return {
      ok: true,
      word: {
        term,
        pos: pos ? pos : "",
        meaning: normalizedMeaning,
      },
    };
  }

  function parseText(inputText) {
    const rawLines = splitLines(String(inputText || ""));
    const words = [];
    let skipped = 0;

    for (const line of rawLines) {
      const res = parseLine(line);
      if (!res.ok) {
        skipped += 1;
        continue;
      }
      words.push(res.word);
    }

    return {
      words,
      stats: {
        totalLines: rawLines.length,
        parsedLines: words.length,
        skippedLines: skipped,
      },
    };
  }

  // Markdown：将整段 Markdown 解析为 entries；同时复用原有 parseLine 兜底解析普通行
  function parseMarkdownToWordEntries(text) {
    try {
      const lines = normalizeMarkdownLines(text);
      const out = [];
      let i = 0;
      while (i < lines.length) {
        const raw = String(lines[i] || "");
        const s = raw.trim();
        if (!s) {
          i += 1;
          continue;
        }

        if (/^<!--/.test(s)) {
          i += 1;
          continue;
        }
        if (/^#{1,6}\s+/.test(s)) {
          i += 1;
          continue;
        }
        if (/^\s*>/.test(s)) {
          i += 1;
          continue;
        }
        if (/^[-*_]{3,}\s*$/.test(s)) {
          i += 1;
          continue;
        }

        if (isMarkdownTableRowLine(s)) {
          const block = [];
          while (i < lines.length && isMarkdownTableRowLine(String(lines[i] || "").trim())) {
            block.push(String(lines[i] || "").trim());
            i += 1;
          }
          const entries = parseMarkdownTable(block);
          if (entries.length) out.push(...entries);
          continue;
        }

        const listWord = parseMarkdownListItem(s);
        if (listWord) {
          out.push(listWord);
          i += 1;
          continue;
        }

        const plain = stripMarkdownInlineSyntax(s);
        const res = parseLine(plain);
        if (res && res.ok) out.push(res.word);
        i += 1;
      }
      return out;
    } catch (err) {
      return [];
    }
  }

  // 统一入口：Markdown 走 Markdown 解析链路，否则保持原 TXT 解析链路
  function parseInput(inputText) {
    const text = String(inputText || "");
    if (!text.trim()) return parseText(text);
    if (!isMarkdownInput(text)) return parseText(text);
    const words = parseMarkdownToWordEntries(text);
    const totalLines = normalizeMarkdownLines(text).length;
    return {
      words,
      stats: {
        totalLines,
        parsedLines: words.length,
        skippedLines: Math.max(0, totalLines - words.length),
      },
    };
  }

  function buildLexiconObject(meta, words) {
    const name = String(meta && meta.name != null ? meta.name : "").trim();
    const description = String(meta && meta.description != null ? meta.description : "").trim();
    const language = String(meta && meta.language != null ? meta.language : "").trim();

    const out = {
      name: name || "我的词书",
      description: description || "",
      language: language || "auto",
      words: Array.isArray(words) ? words : [],
    };

    return out;
  }

  LexiForge.Parser = {
    POS_TOKENS,
    parseText,
    // Markdown support
    parseInput,
    isMarkdownInput,
    parseMarkdownToWordEntries,
    parseMarkdownTable,
    stripMarkdownInlineSyntax,
    normalizeMarkdownLines,
    buildLexiconObject,
  };
})();
