"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  MAX_SOURCE_CODE_POINTS,
  MAX_SPEECH_CODE_POINTS,
  selectAutomaticSpeechText,
} = require("./persona-auto-speech-selection.cjs");

const eligible = [
  ["はい、声はあとから差し替えられます。", "はい、声はあとから差し替えられます。"],
  ["発送は三件です。", "発送は三件です。"],
  ["警告があります。設定を確認してください。", "警告があります。設定を確認してください。"],
  ["実装が完了しました。次の準備もできています。三文目は読みません。", "実装が完了しました。次の準備もできています。"],
  ["# 完了\n\n**自動発話を接続しました。** 次回から短い返答を話します。\n\n- 詳細は後段", "自動発話を接続しました。 次回から短い返答を話します。"],
  ["接続は完了しました。\n\n確認先: /Users/example/private", "接続は完了しました。"],
];

const ineligible = [
  null,
  "",
  "調査中です。",
  "これから作業します。",
  "せやな、できたで。",
  "`npm run test` を実行しました。",
  "```js\nconsole.log('x')\n```",
  "$ npm run build",
  "Traceback (most recent call last):",
  "| 項目 | 値 |",
  "- 一件目\n- 二件目\n- 三件目",
  "保存先は /Users/example/private です。",
  "https://example.invalid を確認してください。",
  "連絡先は user@example.invalid です。",
  "接続先は 127.0.0.1 です。",
  "commit abcdef1234567890",
  "API_TOKEN=must-not-cross",
  "思考過程: 内部の推論です。",
  "plain English only",
  "> 引用です。",
  "diff --git a/file b/file",
  "<p>安全な案内です。</p>",
  "完了<!--内部メモ-->しました。",
  "<!DOCTYPE html>安全な案内です。",
  "<?private note?>安全な案内です。",
  "FEATURE_FLAG=enabled 安全な案内です。",
  "安全な案内です。my_api_token=secret",
  "詳細は ./private を確認してください。",
  "確認先は（/Users/example/private）です。",
  "確認は custom:reference を参照してください。",
  "echo 安全な案内です。",
  "Error: 問題が発生しました。",
  "安全確認のため npm test を実行しました。",
  "詳細は scripts/persona-auto-speech-hook.cjs を確認してください。",
  "詳細は foo/bar を確認してください。",
  "詳細は www.example.com を確認してください。",
  "詳細は example.co.jp を確認してください。",
  "テストを実行中です。",
  "設定を確認中です。",
  "[ERROR] 接続に失敗しました。",
  "[warn] 再接続が必要です。",
  "調査しています。",
  "調査を続けています。",
  "作業を進めています。",
  "作業を行っています。",
  "確認しております。",
  "検証を実施しています。",
  "テストしています。",
  "ビルドを実行しております。",
  "ほんまに完了しました。",
  `${"あ".repeat(95)}${"a".repeat(70)}`,
];

test("selectAutomaticSpeechText selects approved safe Japanese prose", () => {
  for (const [message, expected] of eligible) {
    assert.equal(selectAutomaticSpeechText(message), expected, message);
  }
});

test("selectAutomaticSpeechText rejects every unsafe or ineligible message class", () => {
  for (const message of ineligible) {
    assert.equal(selectAutomaticSpeechText(message), null, String(message));
  }
});

test("selector exports its source and speech code-point limits", () => {
  assert.equal(MAX_SPEECH_CODE_POINTS, 160);
  assert.ok(MAX_SOURCE_CODE_POINTS >= MAX_SPEECH_CODE_POINTS);
  assert.equal(
    selectAutomaticSpeechText("あ".repeat(MAX_SOURCE_CODE_POINTS + 1)),
    null,
  );
});

test("selector truncates a long Japanese sentence at the speech limit", () => {
  const longJapaneseSentence = "あ".repeat(170);
  const selected = selectAutomaticSpeechText(longJapaneseSentence);

  assert.ok([...selected].length <= 160);
  assert.equal(selected.endsWith("…"), true);
});

test("selector preserves complete sentence boundaries instead of adding an ellipsis", () => {
  const message = `${"あ".repeat(150)}。${"い".repeat(20)}`;

  assert.equal(selectAutomaticSpeechText(message), `${"あ".repeat(150)}。`);
  assert.equal(selectAutomaticSpeechText(message).endsWith("…"), false);
});

test("selector stops before a structural block that follows opening prose", () => {
  assert.equal(
    selectAutomaticSpeechText("安全な案内です\n- 詳細です。"),
    "安全な案内です",
  );
});

test("selector never splits a surrogate pair when it must truncate", () => {
  const message = `${"あ".repeat(158)}😀いう`;

  assert.equal(selectAutomaticSpeechText(message), `${"あ".repeat(158)}😀…`);
  assert.equal([...selectAutomaticSpeechText(message)].length, 160);
});
