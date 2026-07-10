---
date_created: 2026-06-29
date_modified: 2026-07-10
description: 'ローカルリポジトリ閲覧、HTTP Delivery、context-only AI Chatを提供するsource-only HTTP viewer。'
version: 1.3.1
---
# Reader-Wiki

言語: [English](README.md) | [日本語](README.ja.md)

Reader-Wiki は、ローカルリポジトリ内のファイルを閲覧するための source-only local HTTP app です。既定では `127.0.0.1` にだけ待受し、ブラウザ上の React UI で表示します。通常の viewer と memo workflow は、リポジトリ内ファイルの編集、任意 shell command の実行、プラグインのインストールを行いません。任意の `AI API` と `Local AI` entry は既定で context-only です。明示的に選択されpath guardを通ったcontextに加え、画面に表示され取り外せるrootの`AGENTS.md`または`CLAUDE.md` rule contextだけを受け取り、リポジトリを編集できません。CLI経由のrepository writeはpublic configurationで無効です。

Git remote には接続しません。公開版は、repository-controlled remote helper / credential helper によるローカル実行を避けるため、legacy `fetchRemote: true` も実行しません。AI Chat は commit、push、pull、fetch、checkout、merge、reset、rebase、tag、branch 作成、remote operation を実行しません。

## 必要環境

- Node.js `>=22.13.0 <27`
- pnpm `10.27.0`
- local repository metadataだけに使うGit

## クイックスタート

1. 依存関係をインストールします。

   ```bash
   pnpm install --frozen-lockfile
   ```

2. ローカルリポジトリ設定を作成します。

   ```bash
   cp example.repositories.yaml repositories.yaml
   ```

3. `repositories.yaml` を編集し、`/absolute/path/to/your/repo` を自分のマシン上の絶対パスに置き換えます。

4. 開発サーバーを起動します。

   ```bash
   pnpm dev
   ```

5. 表示された localhost URL をブラウザで開きます。

PowerShellでは次のようにlocal configを作成します。

```powershell
Copy-Item example.repositories.yaml repositories.yaml
```

## 本番起動

production serverを起動する前にbuildします。

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

`pnpm start` はbuild済みのbrowser/server outputを配信します。依存関係のinstallやrebuildは自動実行しません。

## 設定

Reader-Wiki は既定で `repositories.yaml` を読み込みます。別のファイルを指定することもできます。

```bash
READER_WIKI_CONFIG=/absolute/path/to/repositories.yaml pnpm dev
```

PowerShellからproduction startする場合は次のように指定します。

```powershell
$env:READER_WIKI_CONFIG = 'C:\path\to\repositories.yaml'
pnpm start
```

リポジトリ設定の entry は次の形です。

```yaml
repositories:
  - id: docs
    label: Docs
    root: /absolute/path/to/your/repo
    defaultPath: README.md
    # legacy fetchRemote値は公開版では無視されます。
    excludes:
      - .git
      - node_modules
      - dist
```

`root` には絶対パスを指定する必要があります。`defaultPath` は任意で、アプリ起動時またはリポジトリ選択時に自動で開かれます。legacy `fetchRemote` 値はconfig互換性のため読み取りますが、公開版では実行しません。リポジトリを開くと、Reader-Wiki はリポジトリ全体のlocal tree metadataを更新します。ファイル本文、画像、PDF、巨大 binary は、従来どおりファイルを開いた時だけ読み込みます。

Windowsのrootは、`root: 'C:\path\to\your\repo'` のようにquoteした絶対パスで指定できます。

## 表示できるもの

Reader-Wiki は、登録済みリポジトリ root 内にある Markdown、HTML、YAML、コード、テキスト、画像、PDF ファイルを表示できます。Markdown はサニタイズ済み HTML としてレンダリングされます。HTML ファイルは sandboxed iframe でレンダリングでき、ソースとして表示することもできます。

## Serverとsessionの境界

既定のlistenerは`127.0.0.1`です。serverを起動するたびにrandom API session tokenを生成します。app shellを読み込むと、そのtokenを`HttpOnly`、`SameSite=Strict` cookieとして受け取ります。すべての`/api` requestがsessionを必要とし、mutationはさらにexact local Host/Origin、JSON content、Reader-Wiki request headerを必要とします。利用者がtokenを手作業でcopyまたは保存する必要はありません。

Reader-Wikiはloopback専用です。`0.0.0.0`などのnon-loopback値は常に拒否し、公開server用のopt-inは用意しません。router、tunnel、permissive reverse proxy、firewall ruleでportを公開しないでください。

## HTTP Delivery

HTTP Deliveryは、選択fileを同じloopback server上の別tabで開きます。public版の安全方針はmain viewerより意図的に狭くしています。

- HTML、HTM、SVG targetはHTTP 415で拒否し、Delivery経由では実行しません。
- Markdownは制限されたCSPを持つsanitized Delivery pipelineでrenderします。
- そのMarkdown本文が明示参照する同一repository内のPNG、JPEG、GIF、WebP、PDFだけをDelivery sessionから取得できます。
- dotfile、credential候補、active content、exclude path、traversal、未参照sibling fileは配信しません。

## ワークスペース

ブラウザ UI は、リポジトリツリー、中央ビューア、サイドパネルで構成されています。ファイルを開くと file tab が作成されます。各リポジトリで同時に保持できる tab は最大5つです。`Preview` tab は次にツリーからファイルを選ぶと置き換わりますが、active tab を素早く2回クリックまたはタップすると `Fixed` tab として開いたままにできます。`Pinned` tab は先頭に表示され、自動では置き換えられません。`Pin` と `Unpin` は、右クリックまたは2本指タップで開く file tab context menu からだけ操作できます。中央 header は、開いているファイルのリポジトリ相対パスだけを表示します。

Markdown と HTML ファイルは `Rendered` と `Source` を切り替えられます。`Source` は読みやすいように長い行を折り返します。コード、YAML、テキストファイルは、行番号と横スクロール付きの `Raw` code viewer で表示します。Rendered Markdown はカード枠で囲まず、本文として表示します。codeblock は高コントラストで横スクロールできる style にしています。

サイドパネルには `Outline`、`Memo`、`AI Chat` があります。`Outline` は `Table of Contents` として Markdown heading を表示し、項目をクリックすると中央 viewer の該当 heading へスクロールします。`Memo` はブラウザ UI 内だけの scratchpad であり、リポジトリ内のファイルを保存・編集しません。Memo は `Raw` 編集、`Render` markdown preview、copy、download、delete の icon button に対応します。

## AI ChatとLM Studio

`AI Chat`は任意機能で、`prompts/ai-chat-system.md`のversion付きsystem promptを正本にします。fileやdirectoryは、file tree context menuの`Send a path to AI Chat`などで明示した場合だけ送信します。rootの`AGENTS.md`または`CLAUDE.md`は、取り外せるrule contextとして表示できます。

public execution policyは次のcontext-only entryを提供します。

- `AI API`は、明示設定したremote HTTPS providerへ直接接続します。
- `Local AI`は、portを含む明示的なloopback OllamaまたはLM Studio endpointへ直接接続します。

どちらも、server-sideのendpoint/model readiness確認に成功するまで送信できません。materialize済みReader-Wiki contextだけを受け取り、changed pathのないread-only run summaryを返します。Reader-Wikiはproviderへrepository toolを与えず、raw provider credentialをrepository configやbrowser persistent storageへ保存しません。

規定されたLM Studio経路は次の手順で確認します。

1. LM Studioを別途起動し、`openai/gpt-oss-20b`をloadします。
2. 通常`http://127.0.0.1:1234/v1`となるOpenAI-compatible local serverを有効にします。
3. Reader-Wiki Settingsで`Local AI`と`LM Studio`を選び、modelを`openai/gpt-oss-20b`に設定してreadiness確認を実行します。
4. 明示的に選択したcontext fileとともにpromptを送り、run summaryがchanged pathなしのread-onlyであることを確認します。

Reader-WikiはLM Studioの起動、model load、model downloadを行いません。remote `AI API` endpointはHTTPS必須です。明示的なloopback HTTP endpointを受け付けるのはLocal AIだけです。

`Codex CLI`と`Claude Code CLI`によるrepository writeは既定で無効です。`READER_WIKI_EXPERIMENTAL_AI_WRITE=1`は、隔離したdevelopment testに限って従来のwrite-capable経路を有効にしますが、public security boundaryには含まれません。PowerShellでは対象processに`$env:READER_WIKI_EXPERIMENTAL_AI_WRITE = '1'`を設定します。publicまたはshared listenerでは有効にしないでください。

## 安全境界

サーバーは、要求されたすべてのパスを path guard で解決します。リポジトリ相対パスだけを受け付け、絶対パス、`..` による traversal、登録済み root の外へ出る symlink、除外対象のパスを拒否します。既定の除外リストでは、常に `.git` をブロックします。AI Chat は prompt や UI response にローカル絶対パスを出しません。duplicate postflight checkはwarning-onlyであり、選択fileを自動で書き換えません。

Reader-Wiki は、リポジトリを開いた時点の current local working tree を読みます。公開版では、legacy configに`fetchRemote: true`があってもremote Git fetchを実行しません。

## Source-only配布と公開gate

このpackageは意図的に`private: true`です。GitHub sourceとして配布し、npm publish surfaceにはしません。検証済みpublic GitHub namespaceが存在するまで、`repository`、`homepage`、`bugs`は意図的に未設定です。

初回public pushの前に、maintainerは次を実施する必要があります。

1. GitHub owner/repository namespaceを選択・検証し、そのnamespaceから導出したURLだけを追加する。
2. clean snapshot、squash、または別途承認したhistory rewriteのどれで公開するかを決める。
3. full-historyのauthor/committer metadataを確認し、public emailをGitHub noreply identityへ変更するか判断する。
4. `pnpm run scan:history`と、gitleaksまたはtrufflehog等の専用scannerを実行する。
5. `SECURITY.md`に従い、GitHub private vulnerability reportingを有効化して実在を確認する。

現行sourceは、これらの人間専用判断を代行しません。完了するまでpublicationは**HOLD**です。

## 対象外

この edition は、ブラウザベースの local viewer に限定しています。native desktop shell、bundled runtime state、terminal UI、signing flow、update service、packaged release artifact は public scope から意図的に外しています。

## 検証

変更を共有する前に、次のコマンドを実行します。

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm audit --prod
pnpm run scan:public
```

`scan:public`はpublic sourceの問題をfailureにし、未解決のnamespace/history判断をhuman gateとして報告します。`scan:history`はmaintainer判断が必要で、選択したhistory公開方式を適用するまでnonzeroになり得るため、通常CIから意図的に分離しています。

GitHub ActionsはUbuntu、Windows、macOSで、frozen install、typecheck、test、production build、public source scanを実行します。Node.js 22のminimum compatibilityとNode.js 26のcurrent compatibilityを確認し、Ubuntu / Node.js 22 jobではproduction dependency auditも実行します。

## License

Reader-Wiki sourceはMIT Licenseです。`LICENSE`を参照してください。

## まとめ

Reader-Wikiは、session-protected API、制限付きHTTP Delivery、既定context-onlyのAI provider accessを持つloopback限定・source配布のrepository viewerです。public releaseには、GitHub namespace、history方式、email metadata、private security-reporting導線に対する明示的な人間承認が残ります。
