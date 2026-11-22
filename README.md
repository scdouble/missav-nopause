# missav-nopause

MissAV の動画ページで、**タブを切り替えたときや別のウィンドウをクリックしたときに動画が勝手に一時停止するのを防ぐ** Tampermonkey 用ユーザースクリプトです。

自分での一時停止（プレイヤーのボタン、動画のクリック、スペースキー、メディアキー）はこれまでどおり使えます。

## 対応ドメイン

スクリプトの `@match` / `@include` に入っているドメインです（サブドメインを含む）。

- missav.ai / missav.ws / missav.com / missav.live / missav.tv / missav.to
- missav123.com / missav01.com
- 123av.com / 123av.ws
- 上記以外でも `missav〜.〜` 形式のドメイン（`@include` の正規表現）

使っているドメインが入っていない場合は、`@match https://そのドメイン/*` を1行追加してください。

## インストール（Tampermonkey）

### rawのURLから入れる（おすすめ）

1. ブラウザに [Tampermonkey](https://www.tampermonkey.net/) を入れておきます。
2. 次のURLを開きます。Tampermonkey のインストール画面が出るので「インストール」を押します。
   https://raw.githubusercontent.com/scdouble/missav-nopause/main/missav-nopause.user.js

### 手動で入れる

1. Tampermonkey のメニューから「新規スクリプトを追加」を開きます。
2. 最初から入っている中身をすべて消し、`missav-nopause.user.js` の全文を貼り付けて保存します。

古い版を入れていた場合は、無効にするか削除してから入れてください。

## 動いているかの確かめ方

1. 動画ページを開いて F12 で DevTools を開き、「Console」を見ます。
2. 次のようなログが出ていれば動いています。
   ```
   [missav-nopause] active in page world (v2.1)
   ```
3. Console で次を入力すると、状態を確認できます。
   ```js
   window.__missavNoPause
   ```
   - `droppedListeners`：無視したページ側の blur・visibilitychange の登録
   - `blocked`：自動の一時停止を止めた回数
   - `allowed`：通した一時停止（自分の操作など）の回数
   - `log`：直近の動作の記録

## 仕組み（四段の対策）

本体の処理は、ページ自身のJavaScriptと同じ環境（main world）で動くように `<script>` 要素として注入します。注入できない場合は `unsafeWindow` 経由、または直接実行に切り替えます。

1. **見せかけ**：`document.hidden`・`visibilityState`・`hasFocus()` などを、常に「表示中・フォーカスあり」と返すようにします。
2. **登録を無視**：window・document への blur・visibilitychange などのイベント登録と、`onblur` などへの代入を無視します。
3. **イベントを止める**：それでも届いた window・document 宛ての blur・visibilitychange と、ページの外へ抜ける focusout を、キャプチャ段階で止めます。入力欄どうしのフォーカス移動は止めません。
4. **保険**：`window.player`（Plyr）と動画の `pause()` を包みます。フォーカスが外れている・非表示のとき（またはその直後）で、直前に本物のクリックやキー操作が無い一時停止だけを無視します。`window.player` が後から代入されても対応します。

## うまく動かないときの確認点

- Tampermonkey のアイコンを押したメニューで、このスクリプトが有効で、そのページで実行中になっているか。
- Chrome の場合、「拡張機能の管理」→ Tampermonkey の「詳細」で「ユーザースクリプトを許可」がオンになっているか（Chrome のバージョンによってはデベロッパーモードをオン）。
- アドレスバーのドメインが「対応ドメイン」に入っているか。
- Tampermonkey の設定（上級者向け表示）で、インジェクションモードが「即時」になっているか。
- Console に Content Security Policy のエラーが出ていないか。`window.__missavNoPause` が `undefined` なら、スクリプトがページ側に届いていません。

## 既知の制限

- **ミュートで自動再生している動画**は、タブを切り替えると Chrome 自体が止めます。ブラウザ側の省電力の仕組みなので、このスクリプトでは防げません。音ありで再生している場合は止まりません。
- ページの仕組みが変わると効かなくなることがあります。

## 動作を確認した環境

- macOS の Brave ブラウザで確認済みです。
- 開発時には v2.0 を Chromium（Playwright）で検証しました。2026-10-10 時点のページのアーカイブとテスト用ページを使い、タブ切替・別ウィンドウへの切替で一時停止しないこと、手動の一時停止が使えることを確認しています。
- Firefox・Safari、Violentmonkey などほかのユーザースクリプト管理ツールでは確認していません。
