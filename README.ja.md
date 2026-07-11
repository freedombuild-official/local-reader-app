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
| 登録リポジトリ内のファイル | 閲覧機能は読み取るだけで、利用者が明示依頼した制限付きCurrent repo write runだけが変更する | そのrun後だけ変更される場合がある |

## 任意のAI Chatを設定する

AI Chat は任意です。遠隔の AI 事業者には **AI API**、同じコンピュータで動くモデルサーバーには **Local AI** を使います。これらの既定は **Context-only** です。設定した接続先とモデルがReader-Wikiの厳格な編集protocol準備確認に成功した場合は、**Current repo write**を明示選択できます。この場合もモデルへshellやfilesystem accessを渡しません。Reader-Wikiが制限付きreadを仲介し、Current repo内で検証済みtext操作だけを適用します。**Codex CLI**と**Claude Code CLI**は導入とpersistent authの診断に使えますが、Current repoだけというfilesystem境界を証明できないため、このbuildでは両方のwriteをfail closedにします。4項目とも通常の`pnpm start`で使い、AI専用の別起動commandはありません。

AI Chat で使う AI アカウント、API キー、ローカル実行環境、モデル、接続先、認証情報は、利用者自身が用意して管理します。事業者の契約料金、API 利用料、token や quota の上限、ネットワーク利用、ローカルモデルのダウンロード、モデルのライセンス、ストレージ、メモリ、計算資源、電力、更新、モデル選択は利用者の責任と負担です。Reader-Wiki は AI 利用料を負担せず、事業者への支払いの返金、quota の増加、モデル選定の代行、事業者別の個別サポートを提供しません。

### AI API

1. **Settings** > **AI Chat** を開きます。
2. **AI API** を使用中にします。
3. OpenAI、Anthropic、Google、OpenAI-compatible、Custom から選びます。
4. 正確なモデル名と API キーを入力します。OpenAI-compatible と Custom には、接続先 URL と API 形式も必要です。
5. **Repository access**を**Context-only**のままにするか、Reader-Wikiの制限付きserver-side編集protocolを使うために**Current repo write**を明示選択します。
6. **Check readiness**を選びます。access modeを変えると、以前の準備確認は無効になります。

遠隔 AI の接続先は HTTPS を使い、公開ネットワークアドレスへ名前解決できる必要があります。Reader-Wiki は URL 内の認証情報、非公開または予約済みの遠隔アドレス、別の接続先への転送を拒否します。

準備確認では、設定した事業者のモデル一覧を取得するか、最小限のテスト指示を送ることがあります。リポジトリの内容は送信しません。

遠隔の AI 事業者へ送る情報はコンピュータの外へ出て、その事業者の方針が適用されます。送信前に、選択したパス、規則を示すチップ、添付ファイルをすべて確認してください。

AI APIの**Current repo write**は、設定したOpenAI-compatible、Anthropic、Googleのrequest形式を使います。CustomはSettingsで選んだAPI formatを使います。write readinessではrepository情報を含まないcapability promptを送り、接続先と選択モデルがversion付きJSON protocolを正確に返した場合だけ成功します。通常の文章で応答するモデルは**Context-only**では使えますが、write-readyにはなりません。

write runでは、Reader-Wikiが上限付きのrepository-relative tree manifestを送ります。モデルは制限付きread roundで追加のUTF-8 text fileを要求でき、providerへ見せたpathはrun summaryに表示します。serverはabsolute path、parent traversal、symlink、exclude、`.git`、`.codex`、`.agents`、Reader-Wikiのcontrol-plane file、binary、size超過、古いfile identityまたはhash、操作衝突、予約済みstaging名を拒否します。全操作を事前検査し、repo内のstagingとbackupを使い、作成、exact replace、全文write、明示承認済み削除を決定順で適用します。失敗時は可能な範囲でrollbackし、backupを削除する前に適用後のfileを再確認します。これはrollback付きの制限されたmulti-file適用であり、process crashにも耐える完全なfilesystem transactionや、同じ利用者権限の別processによる最後のpath確認からrenameまでのrace防止を保証するものではありません。

現在のメッセージでrepository編集を依頼したrunだけが、複数fileとnested pathを作成または更新できます。削除は、最新のuser messageに対象fileと完全一致する`DELETE: relative/path`行がある場合だけ許可します。fileごとに1行必要です。移動には、検証済みの移動先writeに加え、read済み移動元への完全一致した削除承認が必要です。以前のmessage、別path、wildcard、通常の文章は削除承認になりません。選択pathは任意のcontext hintで、編集許可範囲の上限ではありません。保存、直接編集、terminal、Preview / ApplyのUIはありません。

### OllamaまたはLM Studioを使うLocal AI

Local AI は、同じコンピュータ上で利用者が起動したモデルサーバーへ接続します。Reader-Wiki は特定のローカルモデルを必須にしません。選んだ実行環境が OpenAI 互換の接続先で配信できるモデルを使い、その実行環境に表示される正確なモデル名を入力してください。

たとえば LM Studio を使う場合は、次のように設定できます。

1. LM Studio を別途起動します。
2. 利用者が選んだモデルを読み込みます。
3. 通常 `http://127.0.0.1:1234/v1` となる LM Studio の OpenAI 互換サーバーを起動します。
4. Reader-Wiki で **Settings** > **AI Chat** を開き、**Local AI** を使用中にします。
5. **LM Studio** を選びます。
6. 接続先を `http://127.0.0.1:1234/v1` にし、モデルには LM Studio で読み込んだ正確なモデル名を入力します。
7. ローカルサーバーが要求しない限り、任意の認証情報は空欄にします。
8. **Repository access**を**Context-only**のままにするか、制限付きserver-side編集protocolを使うために**Current repo write**を明示選択します。
9. **Check readiness**を選びます。

Reader-Wiki は LM Studio や Ollama の起動、モデルのダウンロード、モデルの読み込み、モデルのライセンス確認、端末資源の管理を行いません。先にローカル実行環境側で準備し、選んだモデルに十分なストレージ、メモリ、計算資源があるか確認してください。

Ollamaなど、対応するlocal runtimeも、明示的なloopback hostとport、合致するAPI format、読み込み済みmodelの正確な名前を設定すれば利用できます。**Current repo write**は内蔵のLM StudioまたはOllama URLだけに限定しませんが、設定したmodelが厳格な編集protocolに従うことをreadinessで実証する必要があります。Reader-Wikiはlocal runtimeやmodelを起動またはdownloadしません。

### CLIの項目

Codex CLIとClaude Code CLIの項目は、このbuildでは診断専用です。インストール済みbinary、persistent sign-in、関連する非対話flag、選択workspaceを検査しますが、Current repo write境界は必ず**Check failed**になり、CLI編集runを開始しません。

1. Codex CLIまたはClaude Code CLIを、各CLIの公式手順に従って別途インストールします。
2. 自分のターミナルからCLIのpersistent sign-inを完了し、Reader-Wikiを起動する前に動作を確認します。Reader-Wikiはcredential-likeな環境変数をCLIの子processへ意図的に渡さないため、環境変数だけで設定したAPI keyではこの確認を通過しません。
3. Reader-Wikiを通常どおり`pnpm start`で起動します。
4. **Settings** > **AI Chat**を開き、インストール済みCLIを使用中にして、**Check readiness**を選びます。
5. 診断結果を確認します。このCLI項目ではAI Chatの入力欄は使えません。対応するrequestにはAI APIまたはLocal AIを使います。

準備確認は、AI promptの送信やrepository編集をせずにこれらの診断を行います。Reader-Wikiは、sign-in手順、browser認証、CLIのinstall、model download、terminal、Git remote操作を開始しません。

Codex CLI 0.144.1にはstructured outputとread-only sandboxがありますが、planner processからすべてのbuilt-in toolとextension toolが消えていることを、全対応platformでReader-Wikiが実証できません。Claude Code CLIにはno-toolとstructured-outputのflagがありますが、このbuildではisolated persistent authenticationと同じsynthetic conformance checkを備えたplannerとして未統合・未実証です。このため、両項目はfail closedを維持します。将来のCLI plannerもrepository filesystem accessを受け取らず、Reader-Wiki serverだけが適用できる同じguarded protocol objectを返す必要があります。

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

- AI 事業者が逐次表示に対応する場合、応答を会話へ順次表示する。
- 利用者または AI のメッセージをコピーする。
- 実行中の送信をキャンセルする。
- 最後に失敗した送信を再試行する。
- AI の応答内で Markdown の表、タスクリスト、コードブロックのコピーと折り返しを使う。
- `Enter`で送信する。`Shift+Enter`または`Ctrl/Command+Enter`で改行する。
- ブラウザが対応する音声認識機能を提供する場合、音声入力を使う。
- 最大5ファイルをアップロードする。認識できる64 KiB以下のテキストファイルは本文の候補になりますが、AI 事業者への指示で使うのは添付ファイル1件につき最大12,000文字です。それ以外の添付ファイルは名前、種類、サイズの情報だけを送る。
- AI へ送る要求全体は約140 KiBが上限です。そのため、大きめのテキストファイルを複数添付すると拒否される場合があります。その場合は、数またはサイズを減らしてください。
- 対応する GPT 系モデルでは Low、Medium、High の応答の深さを選び、対応する Qwen 系モデルでは Thinking mode を選ぶ。それ以外はモデルの既定値を使う。

同じリポジトリで同時に実行できる AI 処理は1件、サーバー全体では最大4件です。readinessは短いserver-side leaseを使います。leaseが期限切れになった場合やserver再起動で消えた場合でも、画面に**Connected**または**Success**が残っていれば、送信時に同じEntry、設定、Current repo、revisionを自動再確認してから続行します。更新に失敗した場合はprovider編集要求またはCLI runの前に停止します。設定変更またはrepo切替では引き続きreadinessを無効にします。

AI APIとLocal AIの**Context-only**応答末尾には、repository変更がないことを示す結果が付きます。すべての**Current repo write**応答は、providerへ見せたread pathと、new、changed、deletedのCurrent repo pathを表示します。cleanupまたは適用後確認が完了しなければ`unverified` warningを表示します。AIは助言を行うだけであり、人間が応答、repository、実際のworking tree diffを確認して残す内容を判断します。

## 安全性とプライバシー

- Reader-Wiki は `127.0.0.1`、`localhost`、`::1` などのローカルループバックホストだけを受け付けます。`0.0.0.0` などのネットワークインターフェースは拒否します。
- 起動ごとに新しいブラウザセッションを作ります。API 呼び出しにはそのセッションが必要で、設定保存などの書き込みを伴う操作には、正確なローカル接続元と要求形式も必要です。
- 要求するパスは登録したルート内に留まる必要があります。絶対パスの入力、`..` による上位移動、除外パスを拒否します。ファイル本文の読み取りと HTTP Delivery では、パス途中のシンボリックリンクもすべて拒否します。ツリー表示では、ルート外へ解決されるリンクを拒否します。
- `.git` はファイル閲覧から常に除外します。Git コマンドはローカルの状態と差分情報だけに使い、Reader-Wiki は Git のリモートリポジトリへ接続しません。
- 通常閲覧はリポジトリ内のファイルを編集しません。Repository Settings が書き込むのは、選択された Reader-Wiki の設定ファイルだけです。
- AI APIとLocal AIは、会話、version付きsystem指示、画面上のchipと添付fileで確認できる情報を送ります。**Context-only**ではrepository write toolを送りません。**Current repo write**では、上限付きのrepository-relative tree manifestと、guarded readで要求された追加fileだけも送ります。遠隔AIにはその情報を設定した事業者へ送信します。
- AI APIとLocal AIの既定は**Context-only**です。write runでもmodelはfilesystemやshellへ直接accessできず、Reader-Wiki serverだけがCurrent repo内で上限付きUTF-8 text操作を検証して適用します。選択context pathはrunをそのpathだけに制限しません。Reader-Wikiは、commit、push、pull、fetch、checkout、merge、reset、rebase、tag、branchを代行しません。
- HTTP Delivery は一時的で制限されたローカル URL を使い、Reader-Wiki を公開サーバーにはしません。

信頼できない Reader-Wiki のソースを実行せず、ポートをトンネルやネットワーク規則で外部公開しないでください。セキュリティ上の問題を非公開で報告するには、[SECURITY.md](SECURITY.md)に従ってください。

## サポートと責任範囲

Reader-Wiki は MIT License のもとで無償公開される OSS です。有償製品または有償サポート契約に相当する個別の導入、設定、操作、トラブル対応サポートは含まれません。

Reader-Wiki を使うかどうか、どの環境でどう運用するかは、利用者自身の裁量と責任で判断してください。重要なrepositoryを扱う場合は、tool、設定、依存関係、Local AI設定、provider write modeを変える前にbackupを用意してください。実行するcommand、登録するfolder、HTTP Deliveryで開くfile、AIへ送る情報、AI APIまたはLocal AIのwrite runで適用されたすべてのfile変更を確認する責任は利用者にあります。このbuildではCodex CLIとClaude Code CLIはfileを編集しません。

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

- 選択したモデル名が AI 事業者またはローカル実行環境と完全に一致するか確認する。
- LM Studio または Ollama では、Reader-Wiki で確認する前に実行環境とモデルを起動する。
- 明示的なループバック HTTP 接続先には **Local AI** を使う。遠隔の **AI API** 接続先には HTTPS が必要。
- ページの再読み込み後は認証情報が残らないため、再入力する。
- 接続情報を変更した後は、**Check readiness** をもう一度実行する。

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

Reader-Wiki は、通常閲覧でファイルをオンラインサービスへ渡さず、1つ以上のフォルダを読むためのローカルなブラウザ作業領域です。macOS または Windows の手順から始め、フォルダの絶対パスを登録し、この README の全機能の節を操作説明書として使ってください。AI Chat は任意であり、自動提案されたルートのルールを含め、取り外せるチップに表示された情報だけを受け取ります。
