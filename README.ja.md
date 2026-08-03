# Local Reader App

言語: [English](README.md) | [日本語](README.ja.md)

このREADMEは、package version `0.1.0`にある現在のdefault-branch sourceを説明します。

Local Reader App は、Mac または Windows PC 上のフォルダを、ブラウザで読むための個人用閲覧領域に変えるアプリです。文書、ソースコード、テキスト、画像、PDF、ローカルの Git 変更を、別サービスへ移さずに閲覧できます。

製品紹介サイト: [Local Reader App](https://local-reader-app.freedom-build.com)

最新版の入手と開始: [GitHub Releases](https://github.com/freedombuild-official/local-reader-app/releases/latest)

ほとんどの表示方法は、登録したフォルダ内のファイルを編集しません。HTML自身が保存を実装している場合、HTML **Run**は同じリポジトリ内の既存UTF-8 text fileだけを置換でき、対応するAI Chatの**Current repo write**は選択したCurrent repoを編集できます。Local Reader App は自分のコンピュータ上の `http://127.0.0.1:5173/` で動作します。AI Chat を有効にしない限り、リポジトリの内容を AI サービスへ送信しません。AIへの送信前にはCurrent repoから選んだcontextを取り外せるchipで表示し、Current repo rootのrule fileを自動提案する場合もあります。

現在の Local Reader App は、GitHub からソースファイルを入手して動かします。`.dmg`、`.exe`、App Store 用パッケージ、オンラインアカウント、ワンクリックのインストーラーはありません。以下の手順に沿って、ソースファイルのダウンロードから最初のフォルダを開くところまで進められます。

## プロジェクトと作者

Local Reader App は **[Ryusei Komada](https://github.com/freedombuild-official)** が制作し、**FreedomBuild** の屋号で公開するプロジェクトです。公式ソースは [`freedombuild-official/local-reader-app`](https://github.com/freedombuild-official/local-reader-app) です。

Ryusei Komada および各 contributor は、それぞれの成果物について著作権を保持します。Apache License 2.0 が許諾する内容は [LICENSE](LICENSE) に定められており、作者表示を消したり、改変版を FreedomBuild の公式版として表示したりする権利を与えるものではありません。プロジェクトの識別表示と帰属の詳細は、[AUTHORS.md](AUTHORS.md)、[NOTICE](NOTICE)、[TRADEMARKS.md](TRADEMARKS.md)を参照してください。

## 目次

- [プロジェクトと作者](#プロジェクトと作者)
- [できること](#できること)
- [macOSへのインストールと起動](#macosへのインストールと起動)
- [Windowsへのインストールと起動](#windowsへのインストールと起動)
- [閲覧するフォルダを設定する](#閲覧するフォルダを設定する)
- [画面の構成を理解する](#画面の構成を理解する)
- [任意のAI Chatを設定する](#任意のai-chatを設定する)
- [安全性とプライバシー](#安全性とプライバシー)
- [セキュリティ報告](#セキュリティ報告)
- [サポートと責任範囲](#サポートと責任範囲)
- [Local Reader Appを更新する](#local-reader-appを更新する)
- [Local Reader Appをアンインストールする](#local-reader-appをアンインストールする)
- [トラブルシューティング](#トラブルシューティング)
- [技術概要と公開インターフェース](#技術概要と公開インターフェース)
- [開発に参加する人向け](#開発に参加する人向け)
- [ライセンス、帰属表示、商標](#ライセンス帰属表示商標)

## できること

- 1つ以上のローカルフォルダを登録し、切り替える。
- ローカルの Git 状態を示す印と安全なパス制御を備えたファイルツリーを閲覧する。
- 登録フォルダごとに、Preview、Fixed、Pinned のファイルタブを最大5つ保持する。
- Markdownを表示し、同じリポジトリ内のCSSとJavaScriptを使うHTMLを隔離領域で実行し、ソースやコードを行番号付きで確認し、画像、PDF、対応するMarkdown-in-DOCXファイルをプレビューする。
- ファイル本文、パス、メッセージ、個別の Markdown コードブロックをコピーする。
- ファイル情報、Git 状態、クリックできる Markdown の見出し一覧を確認する。
- 一時的な Markdown メモを書き、必要ならダウンロードする。
- 選択したファイルを HTTP Delivery で一時的に別のブラウザタブへ開く。
- 文字サイズ、Light/Dark 表示、作業領域の幅を調整する。
- 任意で、明示的に選んだファイルやフォルダについて AI サービスへ質問する。

Local Reader App は閲覧を主目的とするアプリであり、汎用のファイル編集ソフト、ターミナル、Git クライアント、遠隔ファイルサーバーではありません。HTML **Run**はread-only表示の明示的な例外であり、HTML自身が保存を実装している場合は、同じ登録リポジトリ内にある既存の許可済みUTF-8 text fileを置換できます。対応する任意のAI Chat **Current repo write**は、もう1つのrepository write例外であり、準備確認の成功後に、そのrunで選択したCurrent repoだけを編集できます。Repository Settings の保存で更新するのは Local Reader App 自身の設定だけで、Memo のダウンロードは利用者が明示的に指示したブラウザからの保存です。一覧から項目を削除しても、登録したフォルダは削除しません。

## インストール前の準備

必要なものは次のとおりです。

- macOS または Windows
- [Node.js](https://nodejs.org/en/download) `>=22.13.0 <27`
- pnpm `10.27.0`
- 現行のデスクトップ向けウェブブラウザ
- 登録するフォルダを読み取れる権限

[Git](https://git-scm.com/downloads) は推奨ですが、ZIP を使った基本閲覧には必須ではありません。Git で複製または更新する場合や、変更を示す印、削除済みの追跡対象ファイル、変更行を表示する場合に必要です。

AI ソフトウェアと API キーは任意です。AI 以外の閲覧機能は、どれも AI なしで使えます。

`0.1.0`でsupported end-user installation pathとして説明するのはmacOSとnative Windowsです。LinuxとWSL2はsource-level CIの対象ですが、end-user向けinstall/lifecycle guideを実機検証していないため、supported user platformとは主張しません。後段のLinux/WSL2への言及はClaude Code CLIのsecurity classificationだけを説明します。文書化済みsetupにはmacOSまたはnative Windowsを使ってください。

## GitHubからLocal Reader Appを入手する

次のどちらかを選びます。

1. 最も簡単な方法は、[最新のGitHub Release](https://github.com/freedombuild-official/local-reader-app/releases/latest)を開き、**Assets**の**Source code (zip)**を選ぶ方法です。ZIPを展開し、そのフォルダの場所を覚えておきます。Release本文には、この版の概要、制限、macOSとWindowsの開始手順へのリンクがあります。
2. Git をすでに使っている場合は、**Code** からこの GitHub ページに表示された HTTPS URL をコピーし、その URL からリポジトリを複製します。

以下のコマンドでは、例として `/path/to/local-reader-app` または `C:\path\to\local-reader-app` を使います。ダウンロードまたは複製したフォルダの実際の場所に置き換えてください。

## macOSへのインストールと起動

### 必要なツールをインストールする

1. 公式ダウンロードページから、対応するバージョンの Node.js をインストールします。
2. **Terminal** を開きます。
3. Node.js と npm を確認し、Local Reader App が使うバージョンの pnpm をインストールします。

   ```bash
   node --version
   npm --version
   npm install --global pnpm@10.27.0
   pnpm --version
   ```

pnpm のシステム全体へのインストールで権限エラーが出た場合は、ファイルシステムの権限をむやみに広げず、公式の [pnpm インストールガイド](https://pnpm.io/10.x/installation) を使ってください。

### Local Reader Appをインストールする

1. ダウンロードした Local Reader App フォルダへ移動します。最も簡単な方法は、Terminal で末尾に半角空白を付けて `cd ` と入力し、Finder から Local Reader App フォルダを Terminal へドラッグして `Return` を押すことです。パスを直接入力することもできます。

   ```bash
   cd "/path/to/local-reader-app"
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

5. Local Reader App をビルドします。

   ```bash
   pnpm build
   ```

6. 起動します。

   ```bash
   pnpm start
   ```

7. Terminal を開いたままにして、ブラウザで [http://127.0.0.1:5173/](http://127.0.0.1:5173/) を開きます。Terminal には正確な URL と設定ファイルのパスも表示されます。

8. Local Reader App を停止するときは、その Terminal ウィンドウに戻り、`Control+C` を押します。

## Windowsへのインストールと起動

この節のコマンドは、Command Prompt ではなく **PowerShell** で実行します。

### 必要なツールをインストールする

1. 公式の Windows 用インストーラーで、対応するバージョンの Node.js をインストールします。
2. **PowerShell** を開きます。
3. Node.js と npm を確認し、Local Reader App が使うバージョンの pnpm をインストールします。

   ```powershell
   node --version
   npm --version
   npm install --global pnpm@10.27.0
   pnpm --version
   ```

PowerShell で実行ポリシーにより `pnpm.ps1` を実行できないと表示された場合、ポリシーを弱めないでください。以降のコマンドでは、たとえば `pnpm.cmd --version` のように、`pnpm` の代わりに `pnpm.cmd` を使います。

### Local Reader Appをインストールする

1. 展開または複製した Local Reader App フォルダへ移動します。エクスプローラーでそのフォルダを選び、`Shift` を押しながら右クリックして **パスのコピー** を選びます。PowerShell で末尾に半角空白を付けて `Set-Location ` と入力し、コピーしたパスを貼り付けて `Enter` を押します。パスを直接入力することもできます。

   ```powershell
   Set-Location 'C:\path\to\local-reader-app'
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

5. Local Reader App をビルドします。

   ```powershell
   pnpm build
   ```

6. 起動します。

   ```powershell
   pnpm start
   ```

7. PowerShell を開いたままにして、ブラウザで [http://127.0.0.1:5173/](http://127.0.0.1:5173/) を開きます。PowerShell には正確な URL と設定ファイルのパスも表示されます。

8. Local Reader App を停止するときは、その PowerShell ウィンドウに戻り、`Ctrl+C` を押します。

## Local Reader Appを再び起動する

最初のビルド後は、通常起動に Local Reader App フォルダと `pnpm start` だけが必要です。

macOS:

```bash
cd "/path/to/local-reader-app"
pnpm start
```

Windows PowerShell:

```powershell
Set-Location 'C:\path\to\local-reader-app'
pnpm start
```

`pnpm start` は依存関係のインストールや、更新されたソースの再ビルドを行いません。新しいバージョンをダウンロードした後は、この README の更新手順を実行してください。

## 閲覧するフォルダを設定する

Local Reader App では登録した各フォルダを「リポジトリ」と呼びますが、Git で管理されていない文書フォルダも登録できます。

既定の設定ファイルは、Local Reader App フォルダ内の `repositories.yaml` です。このファイルには自分のコンピュータの絶対パスが含まれ、Git の対象から意図的に除外されるため、非公開にしてください。

各項目には次の設定値があります。

| 設定値 | 必須 | 意味 |
| --- | --- | --- |
| `id` | はい | Local Reader App 内で使う一意の名前。 |
| `label` | はい | リポジトリの選択欄に表示する名前。 |
| `root` | はい | 実在し、読み取れるフォルダの絶対パス。 |
| `defaultPath` | いいえ | リポジトリ選択時に開く、`root` 内のファイル。例: `README.md`。 |
| `excludes` | いいえ | 非表示にする、リポジトリからの相対パスで表したファイルまたはフォルダ。どの OS でも、入れ子の相対パスには `/` を使う。 |

リポジトリ ID は重複しないようにします。2つの項目が同じフォルダを指すこと、文字の大小または Unicode 正規化だけが異なること、ルートフォルダが親子関係になることは許可されません。これは、表示範囲と AI へ渡す情報の範囲が重なることを防ぐためです。

`.git` は常に非表示です。古い設定に `fetchRemote: true` が残っていても、Local Reader App は Git のリモートリポジトリから情報を取得しません。

`excludes` の各行では、次の簡単な指定方法を使えます。

- `node_modules` のようなフォルダ名またはファイル名。パス内の同名部分を除外する。
- `private/exports` のような正確な相対パス。その中にある項目も除外する。
- `'*.pem'` のような拡張子の指定。
- `'secret*'` のように、末尾を `*` にした名前の先頭一致。

先頭が `*` の項目を引用符なしで書くと YAML では別の意味になるため、例のとおり引用符で囲んでください。それ以外のワイルドカード記法には対応しません。exclude matchingはcase-sensitiveなので、実際のpathと同じletter caseを使います。自動で除外するのは `.git` だけです。`.env`、鍵ファイル、書き出しデータなどをtree、Local Reader Appが作るAI context候補、直接のHTTP Delivery対象へ出したくない場合は、自分で機密pathを追加してください。

**`excludes`はnative CLIのaccess boundaryではありません。** Codex CLIとClaude Code CLIは、それぞれのruntime policyに従い、native toolを使うとCurrent repo内のexcluded pathも確認または変更できます。context chipを取り除いても、Local Reader Appが作るinitial contextから外れるだけであり、CLIが後から同じfileやruleを見つけることは防げません。CLIに絶対に触れさせたくないsecretを含むrepositoryでは、CLI Entryを有効にしないでください。

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

Settingsを開くと、現在のHTML Run sessionは停止します。別のbrowserがHTML Run sessionを保持している間は、repository設定を保存できません。Settings を読み込んだ後に別のプログラムが設定を変更した場合、Local Reader App は新しいファイルの上書きを拒否します。閲覧画面へ戻り、Settings を開き直してからやり直してください。

Repository Settingsのsave、HTML Run session、AI runは同時に実行できません。別のbrowserにHTMLが残っている場合やAI Chat実行中のためsaveが拒否された場合は、そのRun sessionを閉じるかAI runの完了を待つ、またはcancelしてから、もう一度validateしてsaveします。config save中にHTML Run開始またはAI requestが拒否された場合は、save完了後に再試行します。

### 別の場所にある設定ファイルを使う

macOS:

```bash
LOCAL_READER_APP_CONFIG="<absolute-path-to-repositories.yaml>" pnpm start
```

Windows PowerShell:

```powershell
$env:LOCAL_READER_APP_CONFIG = '<absolute-path-to-repositories.yaml>'
pnpm start
```

Settings は選択された設定ファイルへ保存します。画面からリポジトリ一覧を編集する場合は、そのファイルが書き込み可能である必要があります。

`READER_WIKI_CONFIG` は後方互換用のフォールバックとしてだけ残しています。新しい設定と文書では `LOCAL_READER_APP_CONFIG` を使ってください。

## 画面の構成を理解する

メイン画面は3つの領域で構成されます。

1. 左サイドバーでリポジトリとファイルを選びます。
2. 中央で開いているファイルをタブ表示します。
3. 右パネルで **Outline**、**Memo**、**AI Chat** を切り替えます。

ブラウザの幅が狭いと、右パネルは閲覧領域の下へ移動し、さらに狭くなると1列表示になります。

### リポジトリの選択欄とファイルツリー

- **Repository** は、登録済みのルートフォルダを切り替えます。各リポジトリは、現在のページを開いている間、独立したファイルタブを保持します。
- **Reload repository** は、ローカルディスクからファイルツリーと開いているすべてのタブを再読み込みします。別の編集ソフトやプログラムがファイルを変更した後に使います。Local Reader App はファイルシステムを常時監視しません。
- **HTTP Delivery** は、一時配信中のファイル数、URL、各セッションの停止ボタンを表示します。
- **Collapse all folders** は、ルート以外の展開済みフォルダをすべて閉じます。ファイルタブは閉じません。
- 長いツリーは横スクロールに対応し、上位フォルダが画面上部に残ります。上部に固定された上位フォルダを選ぶと、元の位置へ移動します。
- Git の印は、`new`、`changed`、`deleted`、バイナリファイルの変更を示します。変更されたテキスト行もソース表示で示します。
- Git から取得できる場合、削除済みの追跡対象テキストファイルは、最後の `HEAD` の内容も表示できます。
- 非常に大きなツリーは、安全な上限で読み込みを止め、コンピュータの処理能力を使い切る代わりに一部のみ読み込んだという警告を表示することがあります。

ファイルまたはフォルダを右クリックすると、次の操作を使えます。

- **Copy Absolute Path**
- **Copy Relative Path**
- ファイルの **Open in New Tab**。ブラウザの別タブではなく、Local Reader App 内に別のファイルタブを開く。
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

Local Reader App は、ファイル名、内容、サイズから安全な表示方法を選びます。

| ファイル | 利用できる表示方法 |
| --- | --- |
| Markdown | **Rendered** または **Source**。Rendered では YAML フロントマターを隠し、表、読み取り専用のタスクリスト、コードブロックのコピーと折り返しに対応する。 |
| HTML | **Run**または**Source**。ファイルを開くとRunを開始し、inlineまたは同じリポジトリ内のCSSとJavaScriptを実行する。 |
| ソースコード、JSON、YAML、設定ファイル、テキスト | 行番号、横スクロール、ローカル Git の変更を示す印が付いた **Raw**。 |
| PNG、JPEG、GIF、WebP、SVG | 画像のプレビュー。 |
| PDF | ブラウザ内の PDF プレビュー。 |
| Markdown ソースを含む `.docx` | Markdown として表示する。通常の Word のページレイアウトは再現しない。 |
| バイナリ、未対応、削除済みバイナリ、サイズ超過のファイル | 安全でない、または大きすぎる本文を読み込まず、ファイル情報だけを表示する。 |

上部の操作欄から、テキスト系ファイルの全文をコピーできます。Rendered Markdown のコードブロックには、そのブロックだけをコピーするボタンと、長い行の折り返しを切り替えるボタンがあります。

**Source** は長い行を折り返して読みやすく表示します。**Raw** は行の構造を維持し、横スクロールを使います。

Rendered Markdownは、文書内で明示的に参照されたHTTPS画像resourceを読み込むことがあります。HTML Runはpreview用Content Security Policyにより、同一origin以外のscript、style、image、font、media、frame、Worker、cross-originの`fetch`/WebSocket/form送信先を拒否し、同じリポジトリ内のresourceと同一originのsave requestを利用できます。

### HTMLをRunする

HTMLファイルを選ぶと、直ちに**Run**を開始します。**Run**から**Source**へ切り替えても同じiframeを非表示にするだけで、停止や再読込は行いません。**Run**へ戻ると同じiframeを再表示し、未保存のform入力、DOM、timer、JavaScript stateを維持します。Sourceの表示中も、Run buttonには稼働中の印が残ります。sourceを再取得した場合はSource表示を更新しますが、実行中のHTML documentは再読込しません。

Runごとに、serverが所有する非永続sessionと専用のloopback origin / portを使います。repository rootをそのoriginのURL rootとして扱うため、`../styles/app.css`のようなrelative参照と`/data/state.yaml`のようなroot-relative参照は、どちらも同じ登録repository内で解決します。許可されたHTML、CSS、JavaScript、ES Modules、JSON、YAML、text、image、font、media、WebAssembly、iframe、Worker assetを読み取れます。exclude path、symlink component、directory、未対応asset、登録root外のpathは拒否します。したがってHTMLは、entry documentの隣だけでなく、その登録repository内にある除外されていない許可済みassetを読み取れます。自分で作成していないHTMLをRunする前に、`excludes`を設定してください。

tabを閉じる、別fileまたは別repositoryを選ぶ、Settingsを開く、pageから移動またはreloadする、serverを停止する、heartbeat leaseが切れる、のいずれかでRunは終了します。page終了通知を受信できない場合もserver leaseで回収します。browser client全体で最大5sessionを利用できます。

HTMLから保存するには、同じoriginへ`PUT`を送り、既存の許可済みUTF-8 text fileを指定します。requestには次を含めます。

- `X-Local-Reader-Preview-Write: replace`
- 対象を読み取ったときの現在のETagを指定する`If-Match`
- UTF-8 textの`Content-Type`
- 5 MiB以下のbody

同一originの`fetch()`でHTML targetを読み取ると、保存済みsourceとETagを返します。navigation gateを追加するのはdocumentまたはiframeのresponseだけなので、自己保存HTMLが注入gateを自分のfileへ書き戻すことはありません。

既存targetも5 MiB以下である必要があります。Local Reader AppはpathとETagを再検証し、同じdirectoryのtemporary fileへ書き、file modeを維持してtargetを原子的に置換します。新規file作成、削除、rename、directory、binaryまたは未知のtarget、古いETag、exclude path、symlink、repository外への移動は拒否します。app独自のsave buttonや承認dialogは追加しません。この性質を持つHTMLを使うかどうかは利用者が判断し、form、確認、成功、errorのUIはHTML自身が所有します。そのHTMLが置換できるfileは事前にbackupしてください。

Runは任意JavaScript、form、modal、same-originのHTML popupを許可します。別windowを作るprogrammatic popup、link、form targetは、same-originの`.html`または`.htm`文書だけに限定し、`about:blank`、`blob:`、非HTML、外部originのpopup targetは注入gateで拒否します。専用preview originにより、そのdocumentはLocal Reader App本体のDOM、storage、保護APIへのaccessとoriginを共有しません。CSP、iframe sandbox、注入するnavigation gateは、外部subresourceを拒否し、一般的な外部link、form、refresh、popup openを抑止します。ただし通常のbrowserは、悪意あるdocumentまたはsame-origin popupが後から行うすべての`location`変更を確実にinterceptできないため、不正または欠陥のあるHTMLが外部へのnavigation requestを発生させる可能性は残ります。**RunはHTML sanitizerでも、敵対的なactive contentを安全に調べる方法でもありません。** HTMLを選んだ時点でRunが始まるため、Sourceは実行前の安全確認gateではありません。信頼できないHTMLは、ここで選ぶ前に別のplain-text editorで確認してください。

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

- plain textとMarkdownを、常に編集できる1つの面へ入力します。対応するMarkdownは入力中に即時整形され、Raw / Renderの切り替えはありません。
- YAML風frontmatterはmetadataとして解釈・描画せず、literalかつ編集可能なsource textのまま表示します。
- 見出し、強調、code、引用、list、task、link、horizontal rule、tableをlive編集できます。raw HTMLは実行せず、remote imageは読み込まず、安全でないlinkは開きません。
- コピーボタンでメモ全体をコピーする。
- ダウンロードボタンで、ブラウザから `local-reader-app-memo.md` を明示的に保存する。
- 削除ボタンで直ちに消去する。

editor codeはMemoを初めて開いたときに読み込みます。右パネル内を切り替えても、現在のページではeditor、source、編集履歴を維持します。

production buildでは、JavaScriptを1 chunkあたり500,000 bytes以下、全chunk合計900,000 bytes以下に制限します。現在のlive editor build実測は合計約842 kBで、うちMemo専用の遅延chunkは約348 kBです。

Memo はリポジトリ内のファイルを作成・編集せず、browser storageにも保存しません。ページを再読み込みまたは閉じる前に、残したい内容をダウンロードしてください。

## HTTP Deliveryを使う

HTTP Delivery は、選択したファイルに同じローカル Local Reader App サーバー上の一時 URL を与え、別のタブで開きます。中央の閲覧領域上部またはファイルタブのメニューから開始します。リポジトリ選択欄の横にある電波塔のボタンで、使用中の URL を開き直すか停止できます。

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

## SettingsでLocal Reader Appを調整する

歯車ボタンを選んで Settings を開きます。ページを再読み込みせず閲覧画面へ戻れば、現在のタブ、Memo、AI との会話は維持されます。

### Basic

- **Reader text scale**: Markdown、テキスト、コード、文書の閲覧領域を `×1`、`×1.5`、`×2` から選ぶ。HTML RunはHTML document自身のstyleを使う。
- **AI Chat text scale**: 送信済みのユーザーメッセージとAI回答の本文、Markdown見出し、コードを `×1`、`×1.5`、`×2` から選ぶ。指示入力欄とプレースホルダー、役割チップ、メッセージとコードのコピー操作、モデル選択、操作ボタン、空表示、エラー表示には適用しない。
- **Appearance**: LightまたはDark。
- **Workspace density**: Compact、Comfortable、Focused。

この4つはブラウザに保存され、ページを再読み込みした後も残ります。

### Repositories

リポジトリ一覧の項目を追加、編集、検証、プレビュー、保存、削除します。通常の Settings 項目でディスクへファイルを書き込むのは、ここだけです。

### AI Chat

1つのAI Entryを選び、必要な接続情報だけを入力して、準備確認を実行します。CLI Entryでは、**Authentication and model**からCLI自身が管理するsign-inを確認し、CLIの通常の認証flowを開始または取消し、現在そのCLIが提示するmodel、model別reasoning effort、対応inference speedを読み込めます。Local Reader Appはactive CLI Entry、catalogへ結合済みのmodel/effort/speed selection、readiness表示、repository別の会話stateをtab単位のbrowser session storageへ保持し、同じtabのreload後に復元します。CLI credential、一時的な認証値、HTTP session token、executable情報、server readiness attestationは保存しません。tab session storageが利用不能、不正、またはbounded limit超過の場合は保存payloadを破棄し、現在のpage memoryで継続しながら、reloadでstateが消える可能性を警告します。CLIのpersistent sign-inはLocal Reader Appの外にある各CLI自身のstorageへ残ります。AI APIとLocal AIの値は、既存どおり現在のpageだけに保持します。

## 保存されるものを理解する

| 項目 | 保存場所 | ページ再読み込み後 |
| --- | --- | --- |
| リポジトリ一覧 | `repositories.yaml`または`LOCAL_READER_APP_CONFIG`で選んだファイル | 残る |
| 文字サイズ、テーマ、配置 | このローカルサイト用のブラウザ保存領域 | 残る |
| 開いているファイルタブ | 現在のページのメモリ | 消える |
| Memo | ダウンロードするまで現在のページのメモリ | 消える |
| CLI AI Chatの会話と下書き | repository IDごとに分離したtab単位のbrowser session storage | 同じtabでは残る。実行中だったrequestは中断済みとして復元し、添付fileは消える |
| active CLI Entry、CLI model/effort/speed selection、readiness表示 | tab単位のbrowser session storage。live setup/catalogでselectionを検証できた場合だけ復元 | 同じtabでは残る |
| AI APIまたはLocal AIでLocal Reader Appへ入力したcredential値 | 現在のpage memoryのみ | 消える |
| Codex CLIまたはClaude Code CLIのpersistent sign-in | 各CLIが外部で管理するstorage | Local Reader Appでは消えない |
| 音声入力のaudioとtranscript | browserまたはOSのspeech recognition。外部speech serviceがaudioを処理する場合があり、Local Reader Appはtranscriptを受け取る | browser/providerによる |
| HTTP Delivery セッション | 現在の Local Reader App サーバープロセス | サーバー停止時に消える |
| HTML Run session | 現在のpageとLocal Reader App server process | file、repository、pageの変更、server停止、lease切れで消える |
| 登録リポジトリ内のファイル | ほとんどのviewerは読み取るだけ。HTML Runは既存の許可済みUTF-8 text fileを置換でき、対応CLIへのAI Chat依頼はCurrent repoを編集できる | HTML自身のsaveまたはCLI編集依頼後に変更される場合がある |

Local Reader Appにはrepositoryの組み込みbackup/restore機能がありません。HTML RunのsaveまたはCLI writeの前に、通常利用しているGitまたはfile copyの手順で検証済みbackupを作ります。Local Reader Appのrepository一覧をbackupする場合は、**Settings** > **Repositories** > **Config details**に表示される実際のYAML fileをcopyします。server停止中にそのfileを戻してからappを起動するとrestoreできます。browser appearance設定にexportはなく、site dataを消去した場合は設定し直します。

## 任意のAI Chatを設定する

AI Chatは任意です。このREADMEでいう「MVP」と「this build」は、説明対象の`0.1.0` sourceを指します。MVPで対応するのは、install済みの**Codex CLI**と**Claude Code CLI**です。Local Reader Appは、選択したCLI自身の認証flowを確認または開始し、認証後のCLI catalogを利用できますが、Local Reader App accountを作ったりcredentialの管理主体になったりはしません。Current repo境界を強制できるruntimeでは、どちらのCLIもnative toolを使ってCurrent repoを操作できます。**AI API**と**Local AI**は将来用の項目として表示を残しますが、actionはdisabledな**Coming soon**となり、通常UIからactiveにできません。既存のconnection fieldとModel behaviorは変更しません。4つのcardとも通常の`pnpm start`を入口とし、AI専用の別起動commandはありません。

AI Chat で使う AI アカウント、API キー、ローカル実行環境、モデル、接続先、認証情報は、利用者自身が用意して管理します。事業者の契約料金、API 利用料、token や quota の上限、ネットワーク利用、ローカルモデルのダウンロード、モデルのライセンス、ストレージ、メモリ、計算資源、電力、更新、モデル選択は利用者の責任と負担です。Local Reader App は AI 利用料を負担せず、事業者への支払いの返金、quota の増加、モデル選定の代行、事業者別の個別サポートを提供しません。

### AI APIとLocal AI

AI APIとLocal AIの実装は、provider設定やguarded edit protocolを含め、将来の開発用としてsourceに残します。ただしMVPのsupported public interfaceではありません。4項目の設計を示すためcardは表示しますが、**Set active**はdisabledな**Coming soon**に置き換えるため、通常UIからprovider requestを送ったりlocal runtimeを起動したりできません。将来項目用のinternal loopback API codeは残っており、supported interfaceまたは無効化済みsecurity boundaryとして扱ってはいけません。

### CLIの項目

Codex CLIとClaude Code CLIは、Local Reader Appで選択中のCurrent repoにあるfileをnative toolで編集できます。Local Reader Appは、binary、認証、選択したcatalog model/effort/speedの組、必要な非対話flag、workspaceのreadinessが成功した場合だけ、登録済みrepository rootを作業directoryとして選択CLIを起動します。

1. Codex CLIまたはClaude Code CLIを、各CLIの公式手順に従って別途インストールします。
2. Local Reader Appを通常どおり`pnpm start`で起動します。
3. **Settings** > **AI Chat**を開き、インストール済みCLIの**Set active**を選びます。Local Reader Appはsetupを再検査し、初回有効化ではcatalogが明示したdefault model/effortとStandard inference speedを結合して、**CLI Readiness**まで自動実行します。すでにactiveな場合は、**Authentication and model**の**Check again**で同じ一連処理を再実行します。
4. sign-inが必要な場合は**Sign in**を選び、CLIが管理するURL/device-code flowを完了します。Local Reader Appが表示するのはCLIから返された一時的な認証URLまたはcodeだけで、認証後のcredentialはCLI自身のstorageへ残ります。自分のterminalで認証しても構いません。Codexはpersistent sign-inを使い、Local Reader Appは`OPENAI_API_KEY`と`CODEX_API_KEY`をCodexへ意図的に渡しません。Claude Codeはpersistent sign-inまたはlauncherの対応環境変数`ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`CLAUDE_CODE_OAUTH_TOKEN`、`CLAUDE_CONFIG_DIR`を利用できます。Local Reader Appはそれらの値を表示または永続保存しません。
5. 選択されたmodel、reasoning effort、inference speedを確認します。既定は**Standard**です。**Fast**はcurrent modelが対応を明示した場合だけ表示され、provider usageの消費率が高くなる場合があります。別modelを選ぶと、未対応の組を持ち越さず、そのmodelが宣言したeffortとspeedのdefaultへ結合します。catalogの明示default modelを使うのはprior selectionが存在しない場合だけです。Local Reader Appは固定model fallbackを持たず、catalogまたはCLIの変更後にprior modelが消えた場合も黙って別候補へ置き換えません。
6. **CLI Readiness**が成功したことを確認し、AI Chatで依頼を送ります。同じfresh catalog内で有効な別model、reasoning effort、speedへ変更してもreadinessは維持し、serverは実行直前にselection全体をcurrent catalogへ再照合します。Current repoを切り替えてもbrowser上のreadiness表示とselectionは維持しますが、server readiness attestationを別repositoryへ流用しません。次の送信時に対象repositoryの有効なattestationを再利用するか、server側の確認を自動実行します。CLI identity、認証、catalog、setup generationが変わった場合は引き続きfail closedにし、**Check readiness**または**Check again**が必要になる場合があります。

setup確認と準備確認はrepository fileを編集しません。**Authentication and model**はCodex App ServerまたはClaude Agent SDKのaccount/catalog metadataを使い、このcardの確認ではchat model requestを送りません。Codexの**CLI Readiness**はmodel requestを送らず、installed CLI、persistent sign-in、選択済みcatalog pair、flag、Current repoの書込権限、project MCP isolationを確認します。Claude Codeの**CLI Readiness**は、期限切れまたは拒否されたcredentialをreadyと誤表示しないため、追加でtoolを渡さないmodel promptを1回送ります。Local Reader AppはCLI自身が管理する認証flowを開始できますが、CLIのinstall、model download、app内terminalの提供、認証後credentialの保存は行いません。

app内compatibility updateは、installed CLIに既知のcompatibility不足があり、Local Reader Appが再検証できるpackage layoutにexecutableが属する場合に提示します。compatibleなmanaged CLIには、明示的な**Check and apply latest**も表示します。この操作前に新versionが存在すると断定しません。CLI updaterは確認と適用が一体であり、serverが発行する短時間有効な確認とbrowser確認の後だけ実行します。updater完了後はsetupを再検査してreadinessを再実行し、versionが変化したと推測せずupdater結果を表示します。managed Codex packageではcanonicalなlauncher、package/platform metadata、native payload、runtime metadata、Node interpreterをfile identityとcontent digestで固定します。managed Claude layoutではexactなpackage manifestとlauncher/interpreter chain、または公式native version pathを固定します。固定した全memberをupdate command直前に再読込し、差替えまたは不一致があればupdateを停止します。custom executableまたはunmanaged executableは元のpackage managerで更新してください。Local Reader Appは**Set active**、**Check again**、起動時、polling、自動検証の一部としてCLIを更新せず、この仕組みをpackage真正性の暗号学的証明として扱いません。setup、authentication、readiness、AI Chatはserverが解決したexecution descriptorだけを使います。managed package memberとcustom launcher identityをcanonical path、regular-file identity、content digestで使用前とversion再検証後に再読込し、bounded custom scriptでは1段のnative shebang interpreterも固定します。browserからbinaryやpathを受け取らず、検査済みdescriptorをoperation中固定します。

Claude Agent SDKは`0.3.211`へexact pinしています。catalog discoveryは、macOSとLinuxでLocal Reader Appが所有する固定worker process group内だけで実行し、再検証済みのmanaged native packageまたはmanaged Node/npm launcher chainに対応します。serverがworkerへ渡すのはserver-resolved execution descriptor、つまりcanonical native binaryと最大1件のcanonical launcher prefixだけです。SDKにはそのbinaryとprefixをexecutable / executable argumentsとして指定し、launcherのshebangや`PATH`を再解決させません。browserからworker commandやpathを受け取らず、catalog結果を受理する前にgroup全体の停止を確認します。安定したprocess-tree ownershipを利用できるまで、native Windowsでは両CLIのsetup inspection、authentication、catalog discovery、update、readiness probe、AI Chat turnを起動前にfail closedにします。通常のLocal Reader App viewerはnative Windowsでも引き続きsupportedです。この制限はCodex CLIとClaude Code CLIのentryだけに適用し、AI APIとLocal AIは変更せずdisabledの**Coming soon**のままです。

inference speedはrequest単位で適用し、利用者のCLI configを変更しません。Codexの**Standard**は通常の`flex` service tier、**Fast**は提示済み`fast` service tierへ写像し、session引数でFast featureを有効にします。Claudeで**Fast**を表示するのはAgent SDK metadataの`supportsFastMode`がtrueの場合だけです。Local Reader Appはapp-owned session settings内の`fastMode`を渡し、**Standard**では`false`を渡します。speedとreasoning effortは独立した選択です。

このreleaseのClaude Code setupはfoundation-onlyです。production adapterとStandard/Fast正規化を含むLocal HTTP contractは実装し、fake/static testで確認していますが、maintainerはClaude subscriptionを使った認証、catalog読込、readiness、speed mode、model requestのlive検証を行っていません。対象accountで検証するまではClaudeのlive compatibilityを未確認として扱ってください。この変更ではCodexのsetup、catalog選択、通常送信をlive validation gateとします。

CLIを利用できるruntimeでは、Codex CLIはCurrent repoを`-C`に指定し、そのworkspaceだけを書き込み可能にするrunごとに固有のpermission profileを使って非対話で起動します。runでは利用者configを読み込まず、無関係な組み込みintegrationを無効にしますが、既存のexec-policy ruleは迂回しません。Claude Code CLIはCurrent repoを作業directoryにし、user / project / localのsetting sourceと追加directoryを読み込まず、nativeな`Bash`、`Glob`、`Grep`、`Read`、`Edit`、`Write` toolを`acceptEdits` modeで使います。macOSとLinux runtimeではnative Bash sandboxの起動成功を必須にし、sandbox外でのcommand再実行を許可しません。native Windowsでは同等の完全なprocess-tree境界を強制・検証できないため、どちらのCLI entryも起動しません。WSL2はこの確認ではLinux runtimeとして分類しますが、その分類はWSL2をsupported Local Reader App user platformにするものではありません。

Local Reader AppはCLI responseをLocal Reader Appのguarded provider edit protocolへ変換せず、そのprotocolにあるfile個数、directory、read round、operation種別の上限をCLI runへ課しません。依頼の完了に必要であれば、CLIはCurrent repo内の追加fileを確認・変更できます。選択context chipと設定済み`excludes`は、編集pathまたはnative tool accessの上限ではありません。残す内容はresponseと実際のworking-tree diffを確認して判断してください。

### 送る情報を選んでメッセージを送る

1. 使用中の AI 接続設定で準備確認を完了します。
2. リポジトリ固有の質問をする場合は、ファイルツリーでファイルまたはフォルダを右クリックし、**Send a path to AI Chat** を選びます。
3. メッセージ欄の上にあるcontext chipを確認します。chipを取り除くとLocal Reader Appが作るinitial contextから外れますが、CLI Entryがnative toolで後から同じpathを見つけることは防げません。
4. メッセージを入力して送信します。

pathの選択は任意です。一般的な質問、添付fileだけの質問、initial path hintを必要としないrepo-wide編集依頼では手順2を省けます。directoryや複数fileを選んだcontextも有効です。自動提案されたroot ruleは送信前に確認します。取り除いてもinitial contextから外れるだけで、CLIがCurrent repo内からそのruleを見つけない保証にはなりません。

開いているファイルは自動送信されません。選択したファイルはテキストを渡せます。選択したフォルダが渡すのは直下の項目一覧だけで、入れ子にあるすべてのファイル本文ではありません。ルートに `AGENTS.md` または `CLAUDE.md` がある場合は、内容を確認して取り除くこともできる規則チップとして表示します。

ツリーで選んだパスとアップロードした添付ファイルは、1回の送信だけで使う情報です。送信後に入力欄から消えます。再試行で再利用するのは前のメッセージ本文だけで、一度限りのパスや添付ファイルを黙って復元することはありません。

AI へ送る情報には、主要項目12件、規則項目2件、合計64 KiB、1ファイルあたり最大16,000文字という上限があります。画像、PDF、バイナリ、未対応、サイズ超過のファイルは、本文ではなくファイル情報を渡します。

### 会話の操作

- AI Chat専用headerの**New chat**を選び、使用中のAI Entry、readiness表示、ほかのrepositoryの会話を保ったまま、現在のrepositoryのtranscript、下書き、再試行状態、添付file、1回限りのcontextだけを消去する。
- repositoryを切り替えても、使用中のAI Entryとreadiness表示を保持する。repositoryごとに独立したtranscriptと下書きを持ち、元のrepositoryへ戻るとその会話を復元する。
- 同じbrowser tabでreloadすると、active CLI Entry、検証済みselection、readiness表示、完了済みまたは中断済みのrepository別会話、下書きを復元する。upload済み添付fileと実行中requestのhandleは復元しない。
- 選択したCLI runが完了すると、応答を会話へ追加する。
- 利用者または AI のメッセージをコピーする。
- 実行中の送信をキャンセルする。
- 最後に失敗した送信を再試行する。
- AI の応答内で Markdown の表、タスクリスト、コードブロックのコピーと折り返しを使う。
- `Enter`で送信する。`Shift+Enter`または`Ctrl/Command+Enter`で改行する。
- ブラウザが対応する音声認識機能を提供する場合、音声入力を使う。
- 最大5ファイルをアップロードする。認識できる64 KiB以下のテキストファイルは本文の候補になりますが、AI 事業者への指示で使うのは添付ファイル1件につき最大12,000文字です。それ以外の添付ファイルは名前、種類、サイズの情報だけを送る。
- AI へ送る要求全体は約140 KiBが上限です。そのため、大きめのテキストファイルを複数添付すると拒否される場合があります。その場合は、数またはサイズを減らしてください。
- 使用中のCodex CLIまたはClaude Code CLIが提示するmodel、model別reasoning effort、Standardまたは対応済みFast inference speedを選ぶ。selection全体はcomposer付近にも表示し、CLIのrequest単位引数またはapp-owned session settingsとして送る。

同じrepositoryで同時に実行できるAI処理は1件、server全体では最大4件です。CLI readiness leaseは、選択したrepository/revision、Entry、CLI version、catalog revision、server所有のsetup generation、検査済みexecution descriptorに紐付きます。model、effort、speedはlease keyに含めません。同じcatalog generation内で有効な組へ切り替える場合はreadinessを維持し、serverがlease再利用前と実行直前にrequested selectionを再検証します。catalog refresh、authentication変更、update遷移、provider invalidationのたびにgenerationが進み、同じcatalog revisionとselectionが再登場しても新しいreadiness結果が必要です。repositoryを切り替えてもleaseを流用しません。対象repositoryの有効なleaseを再利用するか、送信時に対象固有の確認を自動実行してからCLIを開始します。古いsetup responseは新しいterminal stateを上書きできず、setup identityの変更を検知した実行中browser requestもcancelします。更新に失敗した場合やselectionが古い場合はCLI runの前に停止します。同じtabのreloadで復元するのは上限付きのbrowser表示stateと会話stateだけであり、保存したselectionをlive setup/catalogへ再結合します。credential、execution descriptor、実行中operation、server leaseは復元しません。server restartは古いbrowser sessionと全leaseを無効にします。新serverが表示した正確なURLをreloadまたは開き直して新しいsessionを取得します。同じtabの会話stateは残る場合がありますが、次の送信は新serverの検証に成功する必要があります。

AI ChatにはAI Entryが返した利用者向けの自然言語応答だけを表示します。Local Reader Appのbest-effort change auditとwarningは、会話へ追記せずrepository refreshとretry制御に使う内部run metadataとして保持します。実行に失敗した場合もraw CLI outputではなく、短い説明と次のactionを表示します。AIは助言を行うだけであり、人間が応答、repository、実際のworking-tree diffを確認して残す内容を判断します。

## 安全性とプライバシー

- Local Reader Appの`HOST`に指定できるのは、`127.0.0.1`、`localhost`、`::1`の3値だけです。`0.0.0.0`、そのほかのloopback address、network interfaceは拒否します。
- server起動ごとに新しいserver-side session tokenを作ります。そのserverが表示した正確なURLを開くかreloadして、新しいbrowser sessionを受け取ります。古いtabのAPI callは、server restart後にreloadするまで失敗します。このtokenをtab単位のAI workspace stateへserializeしません。設定保存などのwrite操作には、正確なlocal originとrequest形式も必要です。
- 要求するパスは登録したルート内に留まる必要があります。絶対パスの入力、`..` による上位移動、除外パスを拒否します。ファイル本文の読み取りと HTTP Delivery では、パス途中のシンボリックリンクもすべて拒否します。ツリー表示では、ルート外へ解決されるリンクを拒否します。
- `.git` はファイル閲覧から常に除外します。Git コマンドはローカルの状態と差分情報だけに使い、Local Reader App は Git のリモートリポジトリへ接続しません。
- Rendered Markdownは、明示的に参照されたHTTPS画像hostへ接続する場合があります。HTML Runは専用loopback originを使い、外部subresourceを拒否しますが、任意HTML JavaScriptとsame-origin popupを許可するため、悪意ある後続navigationをbrowserがすべてinterceptできるとは保証できません。HTMLは選択時にRunを開始するため、信頼できないHTMLは別のplain-text editorで確認してください。
- 音声入力はbrowserのspeech-recognition機能を使います。browserとOSによっては音声を外部speech serviceで処理する場合があり、Local Reader Appはそのserviceの選択、確認、保存を制御できません。許容できない場合は文字入力を使ってください。
- HTML Runは、通常viewerのうち登録repositoryへ書き込める唯一の表示方法です。同一originとETagで保護された、既存の許可済みUTF-8 text fileの置換だけを受け付け、5 MiBを超えるtargetは扱いません。fileの作成、削除、renameはできません。
- そのほかの通常表示はリポジトリ内のファイルを編集しません。Repository Settings が書き込むのは、選択された Local Reader App の設定ファイルだけです。
- AI APIとLocal AIは通常UIでdisabledな**Coming soon**項目であり、通常UIからrepository contextや編集依頼を送信できません。将来用のinternal loopback API実装は、supported interfaceまたはaccess-controlの保証ではありません。
- Codex CLIとClaude Code CLIは、CLIを利用できるruntimeでAI Chatによる明示的なwriteを行う項目です。会話と画面上のcontextを受け取り、native toolでCurrent repo内の追加fileを確認し、Local Reader Appのprovider編集上限を受けずに複数fileやnested directoryを作成・更新・rename・削除できます。Local Reader Appは追加workspace rootを渡しません。完全なprocess-tree ownershipをまだ強制・検証できないため、このMVPではnative Windows上でどちらのCLI entryも起動しません。
- HTTP Delivery は一時的で制限されたローカル URL を使い、Local Reader App を公開サーバーにはしません。

信頼できない Local Reader App のソースを実行せず、ポートをトンネルやネットワーク規則で外部公開しないでください。セキュリティ上の問題を非公開で報告するには、[SECURITY.md](SECURITY.md)に従ってください。

## セキュリティ報告

未修正の脆弱性を public issue、discussion、pull request、AI prompt、スクリーンショット、ログへ投稿しないでください。このリポジトリで **Security** > **Advisories** > **Report a vulnerability** が表示される場合は、その非公開導線を使います。表示されない場合は、件名を `[Security] Local Reader App` として [`info.freedombuild@gmail.com`](mailto:info.freedombuild@gmail.com) へメールしてください。

影響を受けるrevision、OS、再現条件、想定する影響、安全な最小限のproof of conceptを含めてください。認証情報、個人情報、非公開path、機密repositoryの内容は取り除きます。報告方針の全文は [SECURITY.md](SECURITY.md) を参照してください。

## サポートと責任範囲

Local Reader App は Apache License 2.0 のもとで無償公開される OSS です。有償製品または有償サポート契約に相当する個別の導入、設定、操作、トラブル対応サポートは含まれません。

Local Reader App を使うかどうか、どの環境でどう運用するかは、利用者自身の裁量と責任で判断してください。重要なrepositoryを扱う場合は、tool、設定、依存関係を変えたりactive HTMLをRunしたりCLI Entryを有効にしたりする前にbackupを用意してください。実行するcommand、登録するfolder、RunするHTML、そのHTML自身のsaveが置換できるfile、HTTP Deliveryで開くfile、AIへ送る情報、HTML Run、Codex CLI、Claude Code CLIが行ったすべてのfile変更を確認する責任は利用者にあります。

repository公開後は、再現できるbugと範囲を絞ったfeature proposalを[GitHub Issues](https://github.com/freedombuild-official/local-reader-app/issues)へ投稿します。source versionまたはrevision、OS、手順、期待した挙動、実際の挙動、機密情報を除いた正確なerrorを含めてください。issueは個別返信、修正、公開時期、SLAを約束するものではありません。セキュリティ報告は別です。[SECURITY.md](SECURITY.md)に従い、未修正の脆弱性の詳細をissue、discussion、AIへの相談、スクリーンショット、ログへ投稿しないでください。

## Local Reader Appを更新する

更新前に、実行中のサーバーを `Control+C` または `Ctrl+C` で停止します。

### Gitで複製した場合

Local Reader App フォルダで実行します。

```bash
git pull --ff-only
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

PowerShell でも同じコマンドを使います。実行ポリシーが `pnpm.ps1` を拒否する場合は、`pnpm.cmd` に置き換えます。

### ZIPをダウンロードした場合

1. 新しい ZIP をダウンロードし、新しいフォルダに展開します。
2. 古い Local Reader App フォルダの非公開ファイル `repositories.yaml` を、新しいフォルダへコピーします。
3. 新しいフォルダで `pnpm install --frozen-lockfile`、`pnpm build`、`pnpm start` を実行します。
4. 古い Local Reader App フォルダを削除する前に、リポジトリと設定を確認します。

## Local Reader Appをアンインストールする

1. サーバーを `Control+C` または `Ctrl+C` で停止します。
2. リポジトリ一覧を残したい場合は、`repositories.yaml` を別の場所へコピーします。
3. Local Reader App のフォルダを削除します。
4. 保存された文字倍率、テーマ、配置も削除したい場合は、実際に使ったlocal origin（既定は`http://127.0.0.1:5173`）のsite dataをbrowserで消去します。

Local Reader App をアンインストールしても、登録済みのリポジトリフォルダは削除しません。

## トラブルシューティング

困ったときは、この README ファイルを AI アシスタントへ添付し、現在の手順を一緒に確認してもらうこともできます。使用している OS、分かる場合は Local Reader App のバージョンまたはソースの revision、今いる手順、実行した正確なコマンドまたはクリック、表示された正確なエラーを伝えてください。API キー、パスワード、トークン、cookie、`.env` の内容、個人情報、非公開のパス、機密リポジトリの内容は送る前に取り除きます。AI の提案は誤ることがあるため、コマンドと影響を確認してから実行してください。AI に相談できることは、maintainer による個別サポートを意味しません。

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

Local Reader App 自身のフォルダから起動したか、`repositories.yaml` を作成したか確認します。`LOCAL_READER_APP_CONFIG` を使う場合は、その絶対パスが正しいか確認します。

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

**Reload repository** を選びます。Local Reader App は登録フォルダを常時監視しません。

### Gitの変更を示す印が表示されない

Git がインストール済みか、登録フォルダが Git の作業ツリーか、そこで `git status` が動くか確認します。Git 情報を取得できなくても、基本的なファイル閲覧は継続します。

### AIの準備確認が失敗する

- native Windowsでは、安定した完全なprocess-tree ownershipを実装するまで、CLI setup、readiness、AI Chatを意図的に利用不可にしています。通常のrepository閲覧は引き続き利用できます。
- Codex CLIまたはClaude Code CLIがインストール済みで、自分のterminalから動くか確認する。
- **Set active**を選ぶか、active entryの**Authentication and model**で**Check again**を選ぶ。Local Reader Appはsetupを再検査し、利用可能なcatalog selectionを安全に結合してreadinessを実行する。必要なら**Sign in**を完了し、prior selectionが消えた場合は現在提示されるmodel、reasoning effort、speedを明示的に選ぶ。
- 自分のterminalでCLI自身の認証status commandを実行し、そこでsign-inを完了してもよい。
- Codex CLIはpersistent sign-inを使う。Local Reader Appは`OPENAI_API_KEY`と`CODEX_API_KEY`をCodexへ渡さない。
- Claude Code CLIはpersistent sign-in、またはLocal Reader Appを起動したprocessから継承する対応Claude authentication environmentを利用できる。
- Claude Codeでは、古いまたは拒否された`ANTHROPIC_API_KEY`がpersistent sign-inより優先される場合がある。その変数を削除または更新し、必要なら`claude auth login`を完了してから、修正したterminalでLocal Reader Appを起動する。
- catalogが変わった場合は、有効なmodel/effort/speedの組を選び直す。Local Reader Appは古いselectionを別modelへ意図的に置換しない。
- 選択中のCurrent repoが存在し、利用者accountで書き込み可能か確認する。
- repository切替では、手動の再activationやreadiness checkは不要です。次の送信時に選択repositoryを検証し、そのrepository固有のserver attestationだけを作成または再利用します。CLI identity、認証、catalog、setup generationの変更後にUIが求めた場合は、**Check readiness**をもう一度選びます。同じfresh catalog内のmodel/effort/speed変更では再確認は不要です。AI APIとLocal AIは、このbuildではdisabledな**Coming soon**項目のままです。

### CLIが停止したことをLocal Reader Appで確認できない

CLI process treeがまだ実行中の可能性があるため、serverはそのCurrent repoのlockを意図的に保持します。CLIを閉じるだけではlockを解除しません。

1. CLI processと、そのCLIが起動したchild processを閉じる。
2. Current repoを確認し、途中まで行われた変更をどう扱うか判断する。
3. `Control+C`または`Ctrl+C`でLocal Reader App serverを停止し、もう一度`pnpm start`を実行する。
4. 新serverが表示した正確なURLをreloadまたは開き直し、復元したselectionを新serverで検証するか、求められた場合はreadinessを再実行してからretryする。同じtabのreloadでは上限付きの会話と下書きを保持しますが、古いserver leaseや実行中runは復元しません。

### 音声入力が利用できない

マイクボタンは、ブラウザが対応する音声認識 API を提供する場合だけ有効になります。文字入力による AI Chat は利用できます。

### HTML Runでfileを読み込めない、または保存できない

HTML entryと参照する全assetが、同じ登録repository内にある既存regular fileであり、exclude対象ではなく、symlinkを経由していないことを確認します。外部subresourceは意図的に拒否します。保存では、対象を最初に読み取り、現在のETagを`If-Match`へ指定し、`X-Local-Reader-Preview-Write: replace`を含め、UTF-8 textのcontent typeを使い、既存targetとrequest bodyをそれぞれ5 MiB以下にします。新規作成、削除、rename、directoryへのwrite、binary targetは扱いません。

pageのsleepやserver restartでRun sessionが失効した場合は、**Run**をもう一度選んで新しいsessionを作成します。別fileを選んでからHTML fileを開き直しても新しいsessionを作成できます。Sourceの変更だけでは、実行中documentを意図的に再読込しません。

### HTTP Deliveryがファイルを拒否する

HTML、HTM、SVG にはメインの閲覧画面を使います。Markdown のローカル付属ファイルは、文書が `../` を使わず明示的に参照しているか、Markdown ファイルと同じフォルダまたは下位フォルダにあるか、除外対象やシンボリックリンク経由ではないかを確認します。配信する Markdown の上限は2 MiB、そのほかの配信ファイルと付属ファイルの上限は25 MiBです。

## 技術概要と公開インターフェース

Local Reader App は React/Vite のブラウザクライアントと、ローカルの Express サーバーで構成されます。サーバーは設定済みYAMLを読み、各registered rootを検証し、保護されたfilesystem操作とlocal Git操作を実行し、clientとloopback APIを1つのprocessで配信します。任意のCodex CLIとClaude Code CLIは、readinessとCurrent repoの確認に成功した場合だけ、別のchild processとして実行します。hosted backend、account system、組み込みtelemetry serviceはありません。

利用者向けに対応する公開インターフェースは次のとおりです。

| インターフェース | 用途と互換性 |
| --- | --- |
| `pnpm start` | 最後に作成したproduction buildを起動する。install後またはupdate後は先に`pnpm build`を実行する。 |
| `pnpm dev` | source変更を自動反映するdevelopment serverを起動する。Local Reader App自体の開発時だけ使う。 |
| `http://127.0.0.1:5173/` | 既定のlocal URL。`PORT`でportを変更できる。`HOST`に指定できるのは`127.0.0.1`、`localhost`、`::1`だけ。 |
| `repositories.yaml` | 既定の非公開repository一覧。`example.repositories.yaml`から作り、実際のpathはcommitしない。 |
| `LOCAL_READER_APP_CONFIG` | 別のrepository設定fileを選ぶ。`READER_WIKI_CONFIG`は旧版との互換用fallback。 |
| `LOCAL_READER_APP_AI_CHAT_SYSTEM_PROMPT` | `version` frontmatterを含む独自Markdown system promptを選ぶ。`READER_WIKI_AI_CHAT_SYSTEM_PROMPT`は旧版との互換用fallback。 |
| `VITE_HMR_PORT` | 必要な場合に、開発時だけ使うbrowser hot-reload portを上書きする。 |

内部の`ReaderWiki*`型、`reader_wiki_*` protocol値、cookie、local-storage key、loopback JSON endpoint、`X-Reader-Wiki-*` headerは互換実装の詳細であり、安定した外部APIとして約束するものではありません。将来のreleaseでは、対応するclientとserverを同時に変更する場合があります。

## 開発に参加する人向け

contributionは標準的なApache-2.0のinbound-equals-outbound方式です。CLAや著作権譲渡は要求せず、contributorは自身の成果物の著作権を保持したまま、提出したcontributionをApache-2.0で許諾します。

1. 公式repositoryをforkして自分のforkをcloneし、範囲を絞ったbranchを作る。
2. locked dependencyをinstallし、1つのまとまった変更を行い、挙動を変える場合はtestとREADME日英を追加または更新する。
3. 下記のverification commandをすべて実行する。
4. branchをpushし、公式`main` branchへpull requestを開く。問題、選んだ変更、利用者または安全性への影響、検証結果を説明する。

credential、token、private repository content、個人path、customer data、無関係なgenerated fileを含めないでください。脆弱性はpublic issueやpull requestではなく[SECURITY.md](SECURITY.md)から報告します。完全なcontribution policyは[CONTRIBUTING.md](CONTRIBUTING.md)を参照してください。

Local Reader App 自体を変更するときだけ、自動更新される開発用サーバーを使います。

```bash
pnpm install --frozen-lockfile
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

挙動、command、上限、warning、公開identityを変える場合は、[README.md](README.md)と[README.ja.md](README.ja.md)を同期してください。GitHub ActionsはUbuntu、Windows、macOSで、固定された依存関係のinstall、型の確認、test、production build、公開sourceのscanを実行します。

## ライセンス、帰属表示、商標

Local Reader App は [Apache License 2.0](LICENSE) で提供します。Copyright 2026 Ryusei Komada。各contributorは、それぞれのcontributionについて著作権を保持します。[NOTICE](NOTICE)は元のプロジェクトへの帰属を記録し、[AUTHORS.md](AUTHORS.md)は原作者とmaintainerを示します。

Apache-2.0は、その条件に従う利用、改変、再配布を認めますが、FreedomBuildの屋号、Local Reader Appのプロジェクトidentity、将来の公式logoを利用する権利は与えません。[TRADEMARKS.md](TRADEMARKS.md)に従って識別表示を正確に使い、forkや改変版を公式releaseと区別してください。

プロジェクトを引用する場合は [CITATION.cff](CITATION.cff)、contributionを行う場合は [CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。

## まとめ

Local Reader App は、通常閲覧でファイルをオンラインサービスへ渡さず、1つ以上のフォルダを読むためのローカルなブラウザ作業領域です。macOS または Windows の手順から始め、フォルダの絶対パスを登録し、この README の全機能の節を操作説明書として使ってください。AI Chatは任意です。取り外せるchipは初期contextを示しますが、対応CLI Entryは依頼に必要な場合、Current repo内の追加fileを確認できます。
