"use strict";

const MAX_SOURCE_CODE_POINTS = 12_000;
const MAX_SPEECH_CODE_POINTS = 160;

const ATX_HEADING = /^\s{0,3}#{1,6}(?:\s|$)/;
const COMMAND_PREFIX = /(?:npm|pnpm|yarn|npx|node|git|curl|wget|cd|ls|rm|mkdir|echo|printf|cat|head|tail|grep|rg|sed|awk|python(?:3)?|ruby|go|cargo|make|docker|kubectl|ssh|scp|chmod|chown|touch|cp|mv|find|bash|sh|zsh|fish|powershell|cmd)\b/;
const STACK_OR_DIFF = /(?:Traceback \(most recent call last\):|(?:[A-Za-z_][\w.]*Error|Exception|Error)\s*:|at\s+.+\(.+:\d+:\d+\)|(?:---|\+\+\+)\s|@@\s|diff --git\b)/;
const STRUCTURAL_BLOCK = new RegExp(
  "^(?:\\s*(?:[-+*]\\s+|\\d+[.)]\\s+|>\\s?|\\|.*\\|\\s*$|```|~~~|"
    + STACK_OR_DIFF.source
    + "|\\$\\s|"
    + COMMAND_PREFIX.source
    + "))",
  "i",
);
const ROUTINE_PROGRESS = /(?:調査|作業|実装|確認|検証|テスト|ビルド|修正|対応|準備|処理|設定)(?:を|に)?(?:し|続け|行っ|行なっ|実施し|実行し|開始し|進め|進行し|継続し|続行し|あたっ|やっ|取り組ん)(?:ています|ている|ております|ており|でいます|でいる|でおります|でおり)/;
const UNSAFE_CONTENT = [
  /`/, // Inline or fenced code.
  new RegExp(`(?:^|[\\s;&|])(?:\\$\\s|${COMMAND_PREFIX.source}(?=\\s|$))`, "im"),
  new RegExp(`(?:^|\\n)\\s*${STACK_OR_DIFF.source}`, "im"),
  /(?:^|\n)\s*\|.*\|\s*$/m,
  /(?:^|[^\w])(?:~?[\\/]|\.\.?[\\/]|[A-Za-z]:[\\/])(?:[^\s\\/]+[\\/])*[^\s\\/]+/,
  /\S+[\\/]\S+/,
  /\b[a-z][a-z0-9+.-]*:(?=\S)/i,
  /\b(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}\b/i,
  /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i,
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/,
  /(?<![a-f0-9])[a-f0-9]{7,64}(?![a-f0-9])/i,
  /(?:^|[^a-z0-9])(?:api[_-]?(?:key|token)|access[_-]?token|auth[_-]?token|token|secret|password|credential)\s*[:=]/i,
  /(?:^|[^A-Z0-9_])[A-Z][A-Z0-9_]*\s*=/,
  /(?:思考過程|内部(?:の)?推論|推論過程|chain[ -]?of[ -]?thought)\s*[:：]/i,
  /(?:調査中|作業中|テストを実行中|設定を確認中|これから(?:作業|実装|調査)|(?:作業|実装|調査)(?:を)?(?:開始|進行|継続)します)/,
  ROUTINE_PROGRESS,
  /\[(?:error|warn(?:ing)?|info|debug|trace|fatal)\]/i,
  /(?:<!|<\?|\?>|-->)/,
  /<\/?[a-z][^>]*>/i,
  /(?:せやな|せやで|せやねん|できたで|ほんま(?:に)?|あかん|ちゃう|おおきに|知らんけど|やねん|やで|やん|やろ)/,
];

function hasUnsafeContent(text) {
  return UNSAFE_CONTENT.some((pattern) => pattern.test(text));
}

function normalizeMarkdown(text) {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
    .replace(/(?<!_)_([^_\n]+)_(?!_)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function firstProseParagraph(text) {
  const lines = text.split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "" || ATX_HEADING.test(line)) {
      index += 1;
      continue;
    }
    break;
  }

  if (index === lines.length || STRUCTURAL_BLOCK.test(lines[index])) {
    return null;
  }

  const paragraph = [];
  while (
    index < lines.length
    && lines[index].trim() !== ""
    && !STRUCTURAL_BLOCK.test(lines[index])
  ) {
    paragraph.push(lines[index]);
    index += 1;
  }
  return paragraph.join(" ");
}

function codePoints(text) {
  return [...text];
}

function selectSentenceText(text) {
  const characters = codePoints(text);
  const boundaries = [];

  for (let index = 0; index < characters.length; index += 1) {
    if (/[。！？!?]/.test(characters[index])) {
      boundaries.push(index + 1);
      if (boundaries.length === 2) break;
    }
  }

  const selectedLength = boundaries.length === 0
    ? characters.length
    : boundaries[boundaries.length - 1];
  if (selectedLength <= MAX_SPEECH_CODE_POINTS) {
    return characters.slice(0, selectedLength).join("");
  }

  const firstBoundary = boundaries[0];
  if (firstBoundary !== undefined && firstBoundary <= MAX_SPEECH_CODE_POINTS) {
    return characters.slice(0, firstBoundary).join("");
  }

  return `${characters.slice(0, MAX_SPEECH_CODE_POINTS - 1).join("")}…`;
}

function isPredominantlyJapanese(text) {
  const japaneseCharacters = text.match(/[ぁ-ゟ゠-ヿㇰ-ㇿ一-鿿々ー]/gu) ?? [];
  const lettersOrDigits = text.match(/[\p{L}\p{N}]/gu) ?? [];
  return japaneseCharacters.length >= 3
    && japaneseCharacters.length * 2 >= lettersOrDigits.length;
}

function selectAutomaticSpeechText(message) {
  if (typeof message !== "string") return null;

  const source = message.replace(/\r\n?/g, "\n").trim();
  if (source === "" || codePoints(source).length > MAX_SOURCE_CODE_POINTS) {
    return null;
  }

  const paragraph = firstProseParagraph(source);
  if (paragraph === null || hasUnsafeContent(paragraph)) return null;

  const normalized = normalizeMarkdown(paragraph);
  if (normalized === "" || hasUnsafeContent(normalized)) return null;

  const selected = selectSentenceText(normalized);
  return !hasUnsafeContent(selected) && isPredominantlyJapanese(selected)
    ? selected
    : null;
}

module.exports = {
  MAX_SOURCE_CODE_POINTS,
  MAX_SPEECH_CODE_POINTS,
  selectAutomaticSpeechText,
};
