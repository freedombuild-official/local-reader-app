# Reader-Wiki

言語: [English](README.md) | [日本語](README.ja.md)

Reader-Wiki は、Mac または Windows PC 上のフォルダを、ブラウザで読むための個人用閲覧領域に変えるアプリです。文書、ソースコード、テキスト、画像、PDF、ローカルの Git 変更を、別サービスへ移さずに閲覧できます。

通常の閲覧では、登録したフォルダ内のファイルを編集しません。Reader-Wiki は自分のコンピュータ上の `http://127.0.0.1:5173/` で動作します。AI Chat を有効にしない限り、リポジトリの内容を AI サービスへ送信しません。送信前にはリポジトリから渡す情報を取り外せるチップで表示し、ルートのルールファイルを自動提案する場合もあります。

現在の Reader-Wiki は、GitHub からソースファイルを入手して動かします。`.dmg`、`.exe`、App Store 用パッケージ、オンラインアカウント、ワンクリックのインストーラーはありません。以下の手順に沿って、ソースファイルのダウンロードから最初のフォルダを開くところまで進められます。

## 目次

- [できること](#できること)
- [macOSへのインストールと起動](#macosへのインストールと起動)
- [Windowsへのインストールと起動](#windowsへのインストールと起動)
- [閲覧するフォルダを設定する](#閲覧するフォルダを設定する)
- [画面の構成を理解する](#画面の構成を理解する)
- [任意のAI Chatを設定する](#任意のai-chatを設定する)
- [安全性とプライバシー](#安全性とプライバシー)
- [サポートと責任範囲](#サポートと責任範囲)
- [Reader-Wikiを更新する](#reader-wikiを更新する)
- [Reader-Wikiをアンインストールする](#reader-wikiをアンインストールする)
- [トラブルシューティング](#トラブルシューティング)
- [開発に参加する人向け](#開発に参加する人向け)
- [License](#license)

## できること

- 1つ以上のローカルフォルダを登録し、切り替える。
- ローカルの Git 状態を示す印と安全なパス制御を備えたファイルツリーを閲覧する。
- 登録フォルダごとに、Preview、Fixed、Pinned のファイルタブを最大5つ保持する。
- Markdown と安全な領域に隔離した HTML を表示し、ソースやコードを行番号付きで確認し、画像、PDF、対応する Markdown-in-DOCX ファイルをプレビューする。
- ファイル本文、パス、メッセージ、個別の Markdown コードブロックをコピーする。
- ファイル情報、Git 状態、クリックできる Markdown の見出し一覧を確認する。
- 一時的な Markdown メモを書き、必要ならダウンロードする。
- 選択したファイルを HTTP Delivery で一時的に別のブラウザタブへ開く。
- 文字サイズ、Light/Dark 表示、作業領域の幅を調整する。
- 任意で、明示的に選んだファイルやフォルダについて AI サービスへ質問する。

Reader-Wiki は閲覧を主目的とするアプリであり、汎用のファイル編集ソフト、ターミナル、Git クライアント、遠隔ファイルサーバーではありません。通常閲覧は登録したフォルダへ書き込みません。対応する任意のAI Chat **Current repo write**だけが明示的な例外で、準備確認の成功後にCurrent repoだけを編集できます。Repository Settings の保存で更新するのは Reader-Wiki 自身の設定だけで、Memo のダウンロードは利用者が明示的に指示したブラウザからの保存です。一覧から項目を削除しても、登録したフォルダは削除しません。

## インストール前の準備

必要なものは次のとおりです。

- macOS または Windows
- [Node.js](https://nodejs.org/en/download) `>=22.13.0 <27`
- pnpm `10.27.0`
- 現行のデスクトップ向けウェブブラウザ
- 登録するフォルダを読み取れる権限

[Git](https://git-scm.com/downloads) は推奨ですが、ZIP を使った基本閲覧には必須ではありません。Git で複製または更新する場合や、変更を示す印、削除済みの追跡対象ファイル、変更行を表示する場合に必要です。

AI ソフトウェアと API キーは任意です。AI 以外の閲覧機能は、どれも AI なしで使えます。

## GitHubからReader-Wikiを入手する

このリポジトリの GitHub ページで、どちらかを選びます。

1. 最も簡単な方法は、**Code** > **Download ZIP** を選び、ZIP を展開して、そのフォルダの場所を覚えておくことです。
2. Git をすでに使っている場合は、**Code** からこの GitHub ページに表示された HTTPS URL をコピーし、その URL からリポジトリを複製します。

以下のコマンドでは、例として `/path/to/reader-wiki` または `C:\path\to\reader-wiki` を使います。ダウンロードまたは複製したフォルダの実際の場所に置き換えてください。

## macOSへのインストールと起動

### 必要なツールをインストールする

1. 公式ダウンロードページから、対応するバージョンの Node.js をインストールします。
2. **Terminal** を開きます。
3. Node.js と npm を確認し、Reader-Wiki が使うバージョンの pnpm をインストールします。

   ```bash
   node --version
   npm --version
   npm install --global pnpm@10.27.0
   pnpm --version
   ```

pnpm のシステム全体へのインストールで権限エラーが出た場合は、ファイルシステムの権限をむやみに広げず、公式の [pnpm インストールガイド](https://pnpm.io/10.x/installation) を使ってください。

### Reader-Wikiをインストールする

1. ダウンロードした Reader-Wiki フォルダへ移動します。最も簡単な方法は、Terminal で末尾に半角空白を付けて `cd ` と入力し、Finder から Reader-Wiki フォルダを Terminal へドラッグして `Return` を押すことです。パスを直接入力することもできます。

   ```bash
   cd "/path/to/reader-wiki"
   ```

2. バージョンが固定された依存関係をインストールします。

   ```bash
   pnpm install --frozen-lockfile
   ```

3. 自分のコンピュータだけで使う非公開の設定ファイルを作成します。

   ```bash
   cp example.repositories.yaml repositories.yaml
   open -e repositories.yaml
   ```

4. 設定例を、読みたいフォルダの内容に置き換えます。実在する絶対パスを使います。

   ```yaml
   repositories:
     - id: my-docs
       label: My Documents
       root: '<absolute-path-to-your-folder>'
       defaultPath: README.md
       excludes:
         - .git
         - node_modules
         - dist
   ```

   フォルダの絶対パスが分からない場合は、Finder でフォルダを選び、`Option` を押しながらメニューを開いて **パス名をコピー** を選びます。または、Terminal で `cd ` と入力してからフォルダを Terminal 画面へドラッグし、`Return` を押して `pwd` を実行します。

   対象フォルダに `README.md` がない場合は、`defaultPath` を実在する別のファイルへ変更するか、その行を削除します。

5. Reader-Wiki をビルドします。

   ```bash
   pnpm build
   ```

6. 起動します。

   ```bash
   pnpm start
   ```

7. Terminal を開いたままにして、ブラウザで [http://127.0.0.1:5173/](http://127.0.0.1:5173/) を開きます。Terminal には正確な URL と設定ファイルのパスも表示されます。

8. Reader-Wiki を停止するときは、その Terminal ウィンドウに戻り、`Control+C` を押します。

## Windowsへのインストールと起動

この節のコマンドは、Command Prompt ではなく **PowerShell** で実行します。

### 必要なツールをインストールする

1. 公式の Windows 用インストーラーで、対応するバージョンの Node.js をインストールします。
2. **PowerShell** を開きます。
3. Node.js と npm を確認し、Reader-Wiki が使うバージョンの pnpm をインストールします。

   ```powershell
   node --version
   npm --version
   npm install --global pnpm@10.27.0
   pnpm --version
   ```

PowerShell で実行ポリシーにより `pnpm.ps1` を実行できないと表示された場合、ポリシーを弱めないでください。以降のコマンドでは、たとえば `pnpm.cmd --version` のように、`pnpm` の代わりに `pnpm.cmd` を使います。

### Reader-Wikiをインストールする

1. 展開または複製した Reader-Wiki フォルダへ移動します。エクスプローラーでそのフォルダを選び、`Shift` を押しながら右クリックして **パスのコピー** を選びます。PowerShell で末尾に半角空白を付けて `Set-Location ` と入力し、コピーしたパスを貼り付けて `Enter` を押します。パスを直接入力することもできます。

   ```powershell
   Set-Location 'C:\path\to\reader-wiki'
   ```

2. バージョンが固定された依存関係をインストールします。

   ```powershell
   pnpm install --frozen-lockfile
   ```

3. 自分のコンピュータだけで使う非公開の設定ファイルを作成して開きます。

   ```powershell
   Copy-Item example.repositories.yaml repositories.yaml
   notepad .\repositories.yaml
   ```

4. 設定例を、読みたいフォルダの内容に置き換えます。Windows の絶対パスを YAML の半角シングルクォートで囲み、各バックスラッシュは1回だけ書きます。

   ```yaml
   repositories:
     - id: my-docs
       label: My Documents
       root: '<absolute-path-to-your-folder>'
       defaultPath: README.md
       excludes:
         - .git
         - node_modules
         - dist
   ```

   エクスプローラーでフォルダを選び、`Shift` を押しながら右クリックして **パスのコピー** を選ぶこともできます。コピーされた両端の二重引用符を外し、YAML の単一引用符の間へ貼り付けてください。PowerShell では、次のコマンドでパスを確認できます。

   ```powershell
   (Resolve-Path '<absolute-path-to-your-folder>').Path
   ```

   対象フォルダに `README.md` がない場合は、`defaultPath` を実在する別のファイルへ変更するか、その行を削除します。

5. Reader-Wiki をビルドします。

   ```powershell
   pnpm build
   ```

6. 起動します。

   ```powershell
   pnpm start
   ```

7. PowerShell を開いたままにして、ブラウザで [http://127.0.0.1:5173/](http://127.0.0.1:5173/) を開きます。PowerShell には正確な URL と設定ファイルのパスも表示されます。

8. Reader-Wiki を停止するときは、その PowerShell ウィンドウに戻り、`Ctrl+C` を押します。

## Reader-Wikiを再び起動する

最初のビルド後は、通常起動に Reader-Wiki フォルダと `pnpm start` だけが必要です。

macOS:

```bash
cd "/path/to/reader-wiki"
pnpm start
```

Windows PowerShell:

```powershell
Set-Location 'C:\path\to\reader-wiki'
pnpm start
```

`pnpm start` は依存関係のインストールや、更新されたソースの再ビルドを行いません。新しいバージョンをダウンロードした後は、この README の更新手順を実行してください。

## 閲覧するフォルダを設定する

Reader-Wiki では登録した各フォルダを「リポジトリ」と呼びますが、Git で管理されていない文書フォルダも登録できます。

既定の設定ファイルは、Reader-Wiki フォルダ内の `repositories.yaml` です。このファイルには自分のコンピュータの絶対パスが含まれ、Git の対象から意図的に除外されるため、非公開にしてください。

各項目には次の設定値があります。

| 設定値 | 必須 | 意味 |
| --- | --- | --- |
| `id` | はい | Reader-Wiki 内で使う一意の名前。 |
| `label` | はい | リポジトリの選択欄に表示する名前。 |
| `root` | はい | 実在し、読み取れるフォルダの絶対パス。 |
| `defaultPath` | いいえ | リポジトリ選択時に開く、`root` 内のファイル。例: `README.md`。 |
| `excludes` | いいえ | 非表示にする、リポジトリからの相対パスで表したファイルまたはフォルダ。どの OS でも、入れ子の相対パスには `/` を使う。 |

リポジトリ ID は重複しないようにします。2つの項目が同じフォルダを指すこと、文字の大小または Unicode 正規化だけが異なること、ルートフォルダが親子関係になることは許可されません。これは、表示範囲と AI へ渡す情報の範囲が重なることを防ぐためです。

`.git` は常に非表示です。古い設定に `fetchRemote: true` が残っていても、Reader-Wiki は Git のリモートリポジトリから情報を取得しません。

`excludes` の各行では、次の簡単な指定方法を使えます。

- `node_modules` のようなフォルダ名またはファイル名。パス内の同名部分を除外する。
- `private/exports` のような正確な相対パス。その中にある項目も除外する。
- `'*.pem'` のような拡張子の指定。
- `'secret*'` のように、末尾を `*` にした名前の先頭一致。

先頭が `*` の項目を引用符なしで書くと YAML では別の意味になるため、例のとおり引用符で囲んでください。それ以外のワイルドカード記法には対応しません。自動で除外するのは `.git` だけです。`.env`、鍵ファイル、書き出しデータなどをツリー、AI に渡す候補、直接の HTTP Delivery 対象へ出したくない場合は、自分で機密パスを追加してください。

### Settingsからリポジトリを追加・編集する

最初の有効なリポジトリを設定した後は、ブラウザで一覧を管理できます。

1. 左サイドバー下部の歯車ボタンを選びます。
2. **Repositories** を開きます。
3. **Add repository** を選ぶか、既存の行を選んで編集します。
4. ID、表示名、ルートの絶対パス、任意の初期表示パス、除外する項目を入力します。
5. **Validate config** を選び、報告された問題をすべて解決します。
6. 書き込まれるファイルを確認したい場合は、**Preview YAML** を選びます。
7. **Save config** を選びます。

**Remove from list** は設定項目だけを削除します。フォルダや中のファイルは削除しません。変更したリポジトリ一覧を保存すると、以前のリポジトリ範囲は現行ではなくなるため、使用中の HTTP Delivery セッションは停止します。

Settings を読み込んだ後に別のプログラムが設定を変更した場合、Reader-Wiki は新しいファイルの上書きを拒否します。閲覧画面へ戻り、Settings を開き直してからやり直してください。

### 別の場所にある設定ファイルを使う

macOS:

```bash
READER_WIKI_CONFIG="<absolute-path-to-repositories.yaml>" pnpm start
```

Windows PowerShell:

```powershell
$env:READER_WIKI_CONFIG = '<absolute-path-to-repositories.yaml>'
pnpm start
```

Settings は選択された設定ファイルへ保存します。画面からリポジトリ一覧を編集する場合は、そのファイルが書き込み可能である必要があります。

## 画面の構成を理解する

メイン画面は3つの領域で構成されます。

1. 左サイドバーでリポジトリとファイルを選びます。
2. 中央で開いているファイルをタブ表示します。
3. 右パネルで **Outline**、**Memo**、**AI Chat** を切り替えます。

ブラウザの幅が狭いと、右パネルは閲覧領域の下へ移動し、さらに狭くなると1列表示になります。

### リポジトリの選択欄とファイルツリー

- **Repository** は、登録済みのルートフォルダを切り替えます。各リポジトリは、現在のページを開いている間、独立したファイルタブを保持します。
- **Reload repository** は、ローカルディスクからファイルツリーと開いているすべてのタブを再読み込みします。別の編集ソフトやプログラムがファイルを変更した後に使います。Reader-Wiki はファイルシステムを常時監視しません。
- **HTTP Delivery** は、一時配信中のファイル数、URL、各セッションの停止ボタンを表示します。
- **Collapse all folders** は、ルート以外の展開済みフォルダをすべて閉じます。ファイルタブは閉じません。
- 長いツリーは横スクロールに対応し、上位フォルダが画面上部に残ります。上部に固定された上位フォルダを選ぶと、元の位置へ移動します。
- Git の印は、`new`、`changed`、`deleted`、バイナリファイルの変更を示します。変更されたテキスト行もソース表示で示します。
- Git から取得できる場合、削除済みの追跡対象テキストファイルは、最後の `HEAD` の内容も表示できます。
- 非常に大きなツリーは、安全な上限で読み込みを止め、コンピュータの処理能力を使い切る代わりに一部のみ読み込んだという警告を表示することがあります。

ファイルまたはフォルダを右クリックすると、次の操作を使えます。

- **Copy Absolute Path**
- **Copy Relative Path**
- ファイルの **Open in New Tab**。ブラウザの別タブではなく、Reader-Wiki 内に別のファイルタブを開く。
- AI の接続設定が準備確認を通過した後の **Send a path to AI Chat**

右クリックメニューは、`Arrow Up`、`Arrow Down`、`Home`、`End`、`Escape`に対応します。

### ファイルタブ

各リポジトリは最大5つのタブを保持できます。

- **Preview** は通常の一時タブです。ツリーで別のファイルを選ぶと置き換わります。
- **Fixed** は、閉じるかPreviewに戻すまで残ります。
- **Pinned** は先頭に残り、自動では置き換わりません。

使用中のタブをダブルクリックまたはダブルタップすると、Preview と Fixed を切り替えます。タブを右クリックすると、**Fix Tab** または **Return to Preview**、**Pin** または **Unpin**、**HTTP Delivery**、**Close** を使えます。使用中のタブをもう一度選ぶと、ファイルツリー内の該当ファイルを表示します。

| キー | ファイルタブの操作 |
| --- | --- |
| `Left Arrow` / `Right Arrow` | 開いているタブ間を移動する。 |
| `Home` / `End` | 最初または最後のタブへ移動する。 |
| `Delete` | フォーカス中のタブを閉じる。 |
| `Shift+F10`またはコンテキストメニューキー | タブ操作のメニューを開く。 |
| `Enter`または`Space` | タブを選択する。すでに使用中ならツリー内に表示する。 |

右パネルのタブも、`Left Arrow`、`Right Arrow`、`Home`、`End`に対応します。

## ファイルを表示する

Reader-Wiki は、ファイル名、内容、サイズから安全な表示方法を選びます。

| ファイル | 利用できる表示方法 |
| --- | --- |
| Markdown | **Rendered** または **Source**。Rendered では YAML フロントマターを隠し、表、読み取り専用のタスクリスト、コードブロックのコピーと折り返しに対応する。 |
| HTML | スクリプトを無効にした隔離領域内の **Rendered**、または **Source**。 |
| ソースコード、JSON、YAML、設定ファイル、テキスト | 行番号、横スクロール、ローカル Git の変更を示す印が付いた **Raw**。 |
| PNG、JPEG、GIF、WebP、SVG | 画像のプレビュー。 |
| PDF | ブラウザ内の PDF プレビュー。 |
| Markdown ソースを含む `.docx` | Markdown として表示する。通常の Word のページレイアウトは再現しない。 |
| バイナリ、未対応、削除済みバイナリ、サイズ超過のファイル | 安全でない、または大きすぎる本文を読み込まず、ファイル情報だけを表示する。 |

上部の操作欄から、テキスト系ファイルの全文をコピーできます。Rendered Markdown のコードブロックには、そのブロックだけをコピーするボタンと、長い行の折り返しを切り替えるボタンがあります。

**Source** は長い行を折り返して読みやすく表示します。**Raw** は行の構造を維持し、横スクロールを使います。

Rendered Markdown と HTML は、文書内で明示的に参照された HTTPS 画像を読み込むことがあります。この場合、画像の配信元へ接続し、新しく開いた Markdown または HTML は最初に **Rendered** で表示されます。この接続を避ける必要がある場合は、信頼できない文書を Reader-Wiki で開く前に、別のプレーンテキスト編集ソフトで確認してください。

### 表示できるファイルサイズの上限

次の上限を超えるファイルは、本文全体の代わりにファイル情報だけを表示します。

| 種類 | 上限 |
| --- | ---: |
| MarkdownとHTML | 2.5 MB |
| コードとテキスト | 3 MB |
| Markdown-in-DOCX | DOCX ファイル自体が20 MiB。さらに安全な展開上限あり |
| PDF | 80 MiB |
| GIF | 25 MiB |
| PNG | 40 MiB |
| JPEGとWebP | 50 MiB |
| SVG | 10 MiB |

圧縮ファイル、インストーラー、データベース、旧形式の Office 文書、PowerPoint ファイル、Excel ファイルは文書本文として表示しません。確認できるファイル情報は表示します。

## Outlineとファイル情報を使う

右パネルで **Outline** を開くと、次を確認できます。

- ファイル名とリポジトリからの相対パス
- 種類、取得できる場合は MIME タイプ、表示状態
- ファイルサイズ、文字数、行数、作成日時
- ローカル Git の状態
- 対応する Markdown-in-DOCX ファイルのソース形式

Markdown では、**Table of Contents** に H1 から H6 までの見出しとソース上の行番号を表示します。見出しを選ぶと、中央の閲覧領域にある該当位置へスクロールします。

## 一時メモを使う

**Memo** は、現在のブラウザページで1つ使える一時的な Markdown メモ帳です。

- **Raw** で Markdown テキストを編集する。
- **Render** で表、タスクリスト、コードブロック操作付きのプレビューを表示する。
- コピーボタンでメモ全体をコピーする。
- ダウンロードボタンで、ブラウザから `reader-wiki-memo.md` を明示的に保存する。
- 削除ボタンで直ちに消去する。

Memo はリポジトリ内のファイルを作成・編集しません。ページを再読み込みまたは閉じる前に、残したい内容をダウンロードしてください。

## HTTP Deliveryを使う

HTTP Delivery は、選択したファイルに同じローカル Reader-Wiki サーバー上の一時 URL を与え、別のタブで開きます。中央の閲覧領域上部またはファイルタブのメニューから開始します。リポジトリ選択欄の横にある電波塔のボタンで、使用中の URL を開き直すか停止できます。

- 同時に最大5ファイルを配信できます。
- 登録したリポジトリ設定が変わらない間は、同じファイルの Delivery をもう一度開始すると既存の配信を再利用します。
- Delivery URL は固定された時点の写しではありません。アクセスするたびに、ローカルファイルの現在の内容を読み取ります。
- Markdown は、表、タスクリスト、コードブロック操作付きの独立した表示ページになります。
- テキストと動作を伴わない対応ファイルは、安全な場合にページ内で配信します。
- 配信する Markdown の上限は2 MiBです。そのほかの直接配信ファイルと付属ファイルの上限は25 MiBです。
- Delivery は動作を伴う内容を実行しないため、HTML、HTM、SVG ファイルを拒否します。
- ローカルの付属ファイルについては、配信した Markdown ファイルと同じフォルダまたはその下位フォルダにあり、本文から明示的に参照された PNG、JPEG、GIF、WebP、PDF だけを読み込めます。`../` を使う親フォルダへの参照は拒否します。
- 明示的に埋め込まれた HTTPS 画像は、離れた場所にある配信元へ直接リクエストされることがあります。
- 付属ファイルのうち、隠しファイル、認証情報らしいパス、除外パス、ルート外のパス、参照されていない隣接ファイルは利用できません。
- 直接配信するために選んだファイルは別扱いです。表示できる通常ファイルは、サイズ上限内であれば配信できます。ただし、HTML、HTM、SVG、シンボリックリンクを含むパスは除きます。秘密情報を含むファイルには Delivery を開始せず、機密パスを `excludes` に追加してください。
- 手動停止、サーバー停止、変更したリポジトリ設定の保存で配信は終了します。

これらの URL はローカルかつ一時的です。トンネル、ルーター規則、リバースプロキシ、公開ファイアウォール規則で外部公開しないでください。

## SettingsでReader-Wikiを調整する

歯車ボタンを選んで Settings を開きます。ページを再読み込みせず閲覧画面へ戻れば、現在のタブ、Memo、AI との会話は維持されます。

### Basic

- **Reader text scale**: Markdown、HTML、テキスト、コード、文書の閲覧領域を `×1`、`×1.5`、`×2` から選ぶ。
- **Appearance**: LightまたはDark。
- **Workspace density**: Compact、Comfortable、Focused。

この3つはブラウザに保存され、ページを再読み込みした後も残ります。

### Repositories

リポジトリ一覧の項目を追加、編集、検証、プレビュー、保存、削除します。通常の Settings 項目でディスクへファイルを書き込むのは、ここだけです。

### AI Chat

1つの AI 接続設定を選び、必要な接続情報だけを入力し、準備確認を実行して、対応するモデルの動作を調整します。AI の設定と認証情報は、`repositories.yaml` やブラウザの永続記憶領域へ書き込みません。

## 保存されるものを理解する

| 項目 | 保存場所 | ページ再読み込み後 |
| --- | --- | --- |
| リポジトリ一覧 | `repositories.yaml`または`READER_WIKI_CONFIG`で選んだファイル | 残る |
| 文字サイズ、テーマ、配置 | このローカルサイト用のブラウザ保存領域 | 残る |
| 開いているファイルタブ | 現在のページのメモリ | 消える |
| Memo | ダウンロードするまで現在のページのメモリ | 消える |
| AI との会話 | 現在のページのメモリ | 消える |
| AI 接続設定と認証情報 | 現在のページのメモリのみ | 消える |
| HTTP Delivery セッション | 現在の Reader-Wiki サーバープロセス | サーバー停止時に消える |
| 登録リポジトリ内のファイル | 閲覧機能は読み取るだけで、対応CLIへのAI Chat依頼はCurrent repoを編集できる | CLI編集依頼後に変更される場合がある |

## 任意のAI Chatを設定する

AI Chat は任意です。MVPで対応するのは、インストールと認証が完了している **Codex CLI** と **Claude Code CLI** です。Current repo境界を強制できるruntimeでは、どちらもnative toolを使ってCurrent repoを操作できます。**AI API** と **Local AI** は将来用の項目として表示を残しますが、actionはdisabledな **Comming soon** となり、このbuildではactiveにできません。4項目とも通常の`pnpm start`を入口とし、AI専用の別起動commandはありません。

AI Chat で使う AI アカウント、API キー、ローカル実行環境、モデル、接続先、認証情報は、利用者自身が用意して管理します。事業者の契約料金、API 利用料、token や quota の上限、ネットワーク利用、ローカルモデルのダウンロード、モデルのライセンス、ストレージ、メモリ、計算資源、電力、更新、モデル選択は利用者の責任と負担です。Reader-Wiki は AI 利用料を負担せず、事業者への支払いの返金、quota の増加、モデル選定の代行、事業者別の個別サポートを提供しません。

### AI APIとLocal AI

AI APIとLocal AIの実装は、provider設定やguarded edit protocolを含め、将来の対応用としてsourceに残します。ただしMVPの対象外です。4項目の設計を示すためcardは表示しますが、**Set active**はdisabledな**Comming soon**に置き換えます。このbuildでは、どちらの項目からもprovider requestを送らず、local runtimeも起動しません。

### CLIの項目

Codex CLIとClaude Code CLIは、Reader-Wikiで選択中のCurrent repoにあるfileをnative toolで編集できます。Reader-Wikiは、binary、既存の認証、必要な非対話flag、workspaceのreadinessが成功した場合だけ、登録済みrepository rootを作業directoryとして選択CLIを起動します。

1. Codex CLIまたはClaude Code CLIを、各CLIの公式手順に従って別途インストールします。
2. 自分のターミナルからCLIの通常の認証を完了し、Reader-Wikiを起動する前に動作を確認します。Reader-Wikiは、公式CLIが既存accountまたは対応する認証環境を利用できるようにしますが、credential値を表示または保存しません。
3. Reader-Wikiを通常どおり`pnpm start`で起動します。
4. **Settings** > **AI Chat**を開き、インストール済みCLIを使用中にして、**Check readiness**を選びます。
5. readinessの成功を確認し、Current repoを確かめてからAI Chatで依頼を送ります。

準備確認はrepository fileを編集しません。Codexの準備確認はmodel requestを送らず、installed CLI、persistent sign-in、flag、Current repoの書込権限、project MCP isolationを確認します。Claude Codeの準備確認は、期限切れまたは拒否されたcredentialをreadyと誤表示しないため、追加でtoolを渡さないmodel promptを1回送ります。Reader-Wikiは、sign-in手順、browser認証、CLIのinstall、model download、app内terminalを開始しません。

Codex CLIはCurrent repoを`-C`に指定し、そのworkspaceだけを書き込み可能にするrunごとに固有のpermission profileを使って非対話で起動します。runでは利用者configを読み込まず、無関係な組み込みintegrationを無効にしますが、既存のexec-policy ruleは迂回しません。Claude Code CLIはCurrent repoを作業directoryにし、user / project / localのsetting sourceと追加directoryを読み込まず、nativeな`Bash`、`Glob`、`Grep`、`Read`、`Edit`、`Write` toolを`acceptEdits` modeで使います。macOSとLinuxではnative Bash sandboxの起動成功を必須にし、sandbox外でのcommand再実行を許可しません。native Windowsでは同じsandbox境界を利用できないため、Claude Code CLIのreadinessをfail-closedにして編集runを開始しません。WSL2はLinux runtimeとして扱います。

Reader-WikiはCLI responseをguarded provider edit protocolへ変換せず、そのprotocolにあるfile個数、directory、read round、operation種別の上限をCLI runへ課しません。依頼に必要であれば、CLIはCurrent repo内の追加fileを確認・変更できます。選択context chipは初期contextであり、編集pathの上限ではありません。残す内容はresponseと実際のworking-tree diffを確認して判断してください。

### 送る情報を選んでメッセージを送る

1. 使用中の AI 接続設定で準備確認を完了します。
2. リポジトリ固有の質問をする場合は、ファイルツリーでファイルまたはフォルダを右クリックし、**Send a path to AI Chat** を選びます。
3. メッセージ欄の上にある、送信情報を示すチップを確認します。送りたくないものは取り除きます。
4. メッセージを入力して送信します。

パスの選択は任意です。一般的な質問、添付ファイルだけの質問、初期path hintを必要としないrepo-wide編集依頼では手順2を省けます。directoryや複数fileを選んだcontextも有効です。自動提案されたルートのルールを送りたくない場合は、確認して取り除いてください。

開いているファイルは自動送信されません。選択したファイルはテキストを渡せます。選択したフォルダが渡すのは直下の項目一覧だけで、入れ子にあるすべてのファイル本文ではありません。ルートに `AGENTS.md` または `CLAUDE.md` がある場合は、内容を確認して取り除くこともできる規則チップとして表示します。

ツリーで選んだパスとアップロードした添付ファイルは、1回の送信だけで使う情報です。送信後に入力欄から消えます。再試行で再利用するのは前のメッセージ本文だけで、一度限りのパスや添付ファイルを黙って復元することはありません。

AI へ送る情報には、主要項目12件、規則項目2件、合計64 KiB、1ファイルあたり最大16,000文字という上限があります。画像、PDF、バイナリ、未対応、サイズ超過のファイルは、本文ではなくファイル情報を渡します。

### 会話の操作

- AI Chat専用headerの**新規チャット**を選び、使用中のAI Entryとreadinessを保ったまま、transcript、下書き、再試行状態、添付file、1回限りのcontextを消去する。
- repositoryを切り替えても、使用中のAI Entry、readiness表示、transcriptを保持する。次の依頼は新しく選んだCurrent repoで実行する。
- 選択したCLI runが完了すると、応答を会話へ追加する。
- 利用者または AI のメッセージをコピーする。
- 実行中の送信をキャンセルする。
- 最後に失敗した送信を再試行する。
- AI の応答内で Markdown の表、タスクリスト、コードブロックのコピーと折り返しを使う。
- `Enter`で送信する。`Shift+Enter`または`Ctrl/Command+Enter`で改行する。
- ブラウザが対応する音声認識機能を提供する場合、音声入力を使う。
- 最大5ファイルをアップロードする。認識できる64 KiB以下のテキストファイルは本文の候補になりますが、AI 事業者への指示で使うのは添付ファイル1件につき最大12,000文字です。それ以外の添付ファイルは名前、種類、サイズの情報だけを送る。
- AI へ送る要求全体は約140 KiBが上限です。そのため、大きめのテキストファイルを複数添付すると拒否される場合があります。その場合は、数またはサイズを減らしてください。
- Codex CLIでは利用可能なresponse depthを選ぶ。Claude Code CLIは設定済みの既定動作を使う。

同じrepositoryで同時に実行できるAI処理は1件、server全体では最大4件です。CLI readinessはrepository切替後も共有する短いserver-side leaseを使い、各送信では選択中Current repoのrootと書込権限を引き続き検証します。leaseの期限切れ後は、送信時にEntry、認証、Current repo、revisionを自動再確認してから続行します。更新に失敗した場合はCLI runの前に停止します。page reloadとReader-Wiki server再起動では、新しいbrowser sessionとなり、memory上の会話を初期化します。

AI ChatにはAI Entryが返した利用者向けの自然言語応答だけを表示します。Reader-Wikiのbest-effort change auditとwarningは、会話へ追記せずrepository refreshとretry制御に使う内部run metadataとして保持します。実行に失敗した場合もraw CLI outputではなく、短い説明と次のactionを表示します。AIは助言を行うだけであり、人間が応答、repository、実際のworking-tree diffを確認して残す内容を判断します。

## 安全性とプライバシー

- Reader-Wiki は `127.0.0.1`、`localhost`、`::1` などのローカルループバックホストだけを受け付けます。`0.0.0.0` などのネットワークインターフェースは拒否します。
- 起動ごとに新しいブラウザセッションを作ります。API 呼び出しにはそのセッションが必要で、設定保存などの書き込みを伴う操作には、正確なローカル接続元と要求形式も必要です。
- 要求するパスは登録したルート内に留まる必要があります。絶対パスの入力、`..` による上位移動、除外パスを拒否します。ファイル本文の読み取りと HTTP Delivery では、パス途中のシンボリックリンクもすべて拒否します。ツリー表示では、ルート外へ解決されるリンクを拒否します。
- `.git` はファイル閲覧から常に除外します。Git コマンドはローカルの状態と差分情報だけに使い、Reader-Wiki は Git のリモートリポジトリへ接続しません。
- 通常閲覧はリポジトリ内のファイルを編集しません。Repository Settings が書き込むのは、選択された Reader-Wiki の設定ファイルだけです。
- AI APIとLocal AIは、このbuildではdisabledな**Comming soon**項目であり、repository contextまたは編集依頼を送信できません。
- Codex CLIと、macOSまたはLinux上のClaude Code CLIは、AI Chatで明示的にwriteを行う項目です。会話と画面上のcontextを受け取り、native toolでCurrent repo内の追加fileを確認し、Reader-Wikiのprovider編集上限を受けずに複数fileやnested directoryを作成・更新・rename・削除できます。Reader-Wikiは追加workspace rootを渡しません。native WindowsのClaude Code CLI編集はCurrent repo限定のBash境界を強制できないため、このMVPでは有効にしません。
- HTTP Delivery は一時的で制限されたローカル URL を使い、Reader-Wiki を公開サーバーにはしません。

信頼できない Reader-Wiki のソースを実行せず、ポートをトンネルやネットワーク規則で外部公開しないでください。セキュリティ上の問題を非公開で報告するには、[SECURITY.md](SECURITY.md)に従ってください。

## サポートと責任範囲

Reader-Wiki は MIT License のもとで無償公開される OSS です。有償製品または有償サポート契約に相当する個別の導入、設定、操作、トラブル対応サポートは含まれません。

Reader-Wiki を使うかどうか、どの環境でどう運用するかは、利用者自身の裁量と責任で判断してください。重要なrepositoryを扱う場合は、tool、設定、依存関係を変えたりCLI Entryを有効にしたりする前にbackupを用意してください。実行するcommand、登録するfolder、HTTP Deliveryで開くfile、AIへ送る情報、Codex CLIまたはClaude Code CLIが行ったすべてのfile変更を確認する責任は利用者にあります。

公開リポジトリで bug report や issue を受け付けている場合でも、個別返信、修正、公開時期、SLA は約束しません。セキュリティ報告は一般サポートとは別です。[SECURITY.md](SECURITY.md)に従い、修正前の脆弱性の詳細を public issue、discussion、AI への相談、スクリーンショット、ログへ投稿しないでください。

## Reader-Wikiを更新する

更新前に、実行中のサーバーを `Control+C` または `Ctrl+C` で停止します。

### Gitで複製した場合

Reader-Wiki フォルダで実行します。

```bash
git pull --ff-only
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

PowerShell でも同じコマンドを使います。実行ポリシーが `pnpm.ps1` を拒否する場合は、`pnpm.cmd` に置き換えます。

### ZIPをダウンロードした場合

1. 新しい ZIP をダウンロードし、新しいフォルダに展開します。
2. 古い Reader-Wiki フォルダの非公開ファイル `repositories.yaml` を、新しいフォルダへコピーします。
3. 新しいフォルダで `pnpm install --frozen-lockfile`、`pnpm build`、`pnpm start` を実行します。
4. 古い Reader-Wiki フォルダを削除する前に、リポジトリと設定を確認します。

## Reader-Wikiをアンインストールする

1. サーバーを `Control+C` または `Ctrl+C` で停止します。
2. リポジトリ一覧を残したい場合は、`repositories.yaml` を別の場所へコピーします。
3. Reader-Wiki のフォルダを削除します。
4. 保存された文字サイズ、テーマ、配置も削除したい場合は、ブラウザで `127.0.0.1:5173` のサイトデータを消去します。

Reader-Wiki をアンインストールしても、登録済みのリポジトリフォルダは削除しません。

## トラブルシューティング

困ったときは、この README ファイルを AI アシスタントへ添付し、現在の手順を一緒に確認してもらうこともできます。使用している OS、分かる場合は Reader-Wiki のバージョンまたはソースの revision、今いる手順、実行した正確なコマンドまたはクリック、表示された正確なエラーを伝えてください。API キー、パスワード、トークン、cookie、`.env` の内容、個人情報、非公開のパス、機密リポジトリの内容は送る前に取り除きます。AI の提案は誤ることがあるため、コマンドと影響を確認してから実行してください。AI に相談できることは、maintainer による個別サポートを意味しません。

### `pnpm`が見つからない

インストール後に新しいターミナルを開き、次を実行します。

```bash
npm install --global pnpm@10.27.0
pnpm --version
```

Windows で PowerShell の実行ポリシーが `pnpm.ps1` を拒否する場合は、`pnpm.cmd --version` を試します。

### Node.jsのバージョンが拒否される

`node --version` を実行します。`22.13.0` 以上、`27` 未満のバージョンをインストールしてください。

### `Repository config was not found`と表示される

Reader-Wiki 自身のフォルダから起動したか、`repositories.yaml` を作成したか確認します。`READER_WIKI_CONFIG` を使う場合は、その絶対パスが正しいか確認します。

### リポジトリ設定が安全でない、または無効と表示される

各ルートが実在して読み取れる絶対パスのフォルダか、ID が重複していないか、ルート同士が重ならないか、初期表示パスと除外項目がリポジトリからの相対パスか確認します。具体的な確認には **Settings** > **Repositories** > **Validate config** を使います。

### ポート5173が使用中

別のプロセスを停止するか、別のローカルポートを選びます。

macOS:

```bash
PORT=5174 pnpm start
```

Windows PowerShell:

```powershell
$env:PORT = '5174'
pnpm start
```

その後、`http://127.0.0.1:5174/`を開きます。

### `pnpm start`は動くがページがない、または古い

`pnpm start` は最後のビルド結果を配信します。停止してから、次を実行します。

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

### 古いブラウザタブでセッションまたは認証エラーが出る

サーバーを起動するたびに新しいローカルセッションを作ります。現在のサーバーが表示した URL を再読み込みするか、新しいタブで開きます。

### ローカルファイルの変更が表示されない

**Reload repository** を選びます。Reader-Wiki は登録フォルダを常時監視しません。

### Gitの変更を示す印が表示されない

Git がインストール済みか、登録フォルダが Git の作業ツリーか、そこで `git status` が動くか確認します。Git 情報を取得できなくても、基本的なファイル閲覧は継続します。

### AIの準備確認が失敗する

- Codex CLIまたはClaude Code CLIがインストール済みで、自分のterminalから動くか確認する。
- 同じterminalでCLI自身の認証status commandを実行し、必要ならsign-inを完了する。
- CLIが認証用の環境変数を使う場合は、その変数を利用できる環境からReader-Wikiを起動する。
- Claude Codeでは、古いまたは拒否された`ANTHROPIC_API_KEY`がpersistent sign-inより優先される場合がある。その変数を削除または更新し、必要なら`claude auth login`を完了してから、修正したterminalでReader-Wikiを起動する。
- 選択中のCurrent repoが存在し、利用者accountで書き込み可能か確認する。
- **Check readiness**をもう一度選ぶ。AI APIとLocal AIは、このbuildではdisabledな**Comming soon**項目のままです。

### 音声入力が利用できない

マイクボタンは、ブラウザが対応する音声認識 API を提供する場合だけ有効になります。文字入力による AI Chat は利用できます。

### HTTP Deliveryがファイルを拒否する

HTML、HTM、SVG にはメインの閲覧画面を使います。Markdown のローカル付属ファイルは、文書が `../` を使わず明示的に参照しているか、Markdown ファイルと同じフォルダまたは下位フォルダにあるか、除外対象やシンボリックリンク経由ではないかを確認します。配信する Markdown の上限は2 MiB、そのほかの配信ファイルと付属ファイルの上限は25 MiBです。

## 開発に参加する人向け

Reader-Wiki 自体を変更するときだけ、自動更新される開発用サーバーを使います。

```bash
pnpm dev
```

変更を共有する前に、次を実行します。

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm audit --prod
pnpm run scan:public
```

GitHub Actions は Ubuntu、Windows、macOS で、固定された依存関係のインストール、型の確認、テスト、本番用ビルド、公開ソースの検査を行います。

## License

Reader-Wiki は MIT License です。[LICENSE](LICENSE)を参照してください。

## まとめ

Reader-Wiki は、通常閲覧でファイルをオンラインサービスへ渡さず、1つ以上のフォルダを読むためのローカルなブラウザ作業領域です。macOS または Windows の手順から始め、フォルダの絶対パスを登録し、この README の全機能の節を操作説明書として使ってください。AI Chatは任意です。取り外せるchipは初期contextを示しますが、対応CLI Entryは依頼に必要な場合、Current repo内の追加fileを確認できます。
