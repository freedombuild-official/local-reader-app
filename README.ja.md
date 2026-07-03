---
date_created: 2026-06-29
date_modified: 2026-07-01
description: 'ローカルリポジトリ内のファイルを wiki として閲覧する local HTTP read-only viewer。'
version: 1.0.0
---
# Reader-Wiki

言語: [English](README.md) | [日本語](README.ja.md)

Reader-Wiki は、ローカルリポジトリ内のファイルを閲覧するための local HTTP app です。localhost 上で Express サーバーを起動し、ブラウザ上の React UI で表示します。リポジトリ内容に対して read-only であり、ファイル編集、利用者の代わりの任意 shell command 実行、プラグインのインストール、AI サービスへの接続は行いません。既定では Git remote に接続しません。リポジトリごとに remote fetch を明示的に有効化した場合だけ fetch-only Git sync を実行し、pull、checkout、merge、reset、working tree の変更は行いません。

## クイックスタート

1. 依存関係をインストールします。

   ```bash
   pnpm install
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

## 設定

Reader-Wiki は既定で `repositories.yaml` を読み込みます。別のファイルを指定することもできます。

```bash
READER_WIKI_CONFIG=/absolute/path/to/repositories.yaml pnpm dev
```

リポジトリ設定の entry は次の形です。

```yaml
repositories:
  - id: docs
    label: Docs
    root: /absolute/path/to/your/repo
    defaultPath: README.md
    # fetchRemote: true
    excludes:
      - .git
      - node_modules
      - dist
```

`root` には絶対パスを指定する必要があります。`defaultPath` は任意で、アプリ起動時またはリポジトリ選択時に自動で開かれます。`fetchRemote` は任意で、既定値は `false` です。リポジトリを開くと、Reader-Wiki はリポジトリ全体の表示用 tree metadata を更新します。ファイル本文、画像、PDF、巨大 binary は、従来どおりファイルを開いた時だけ読み込みます。

## 表示できるもの

Reader-Wiki は、登録済みリポジトリ root 内にある Markdown、HTML、YAML、コード、テキスト、画像、PDF ファイルを表示できます。Markdown はサニタイズ済み HTML としてレンダリングされます。HTML ファイルは sandboxed iframe でレンダリングでき、ソースとして表示することもできます。

## ワークスペース

ブラウザ UI は、リポジトリツリー、中央ビューア、サイドパネルで構成されています。ファイルを開くと file tab が作成されます。各リポジトリで同時に保持できる tab は最大5つです。`Preview` tab は次にツリーからファイルを選ぶと置き換わりますが、active tab を素早く2回クリックまたはタップすると `Fixed` tab として開いたままにできます。`Pinned` tab は先頭に表示され、自動では置き換えられません。`Pin` と `Unpin` は、右クリックまたは2本指タップで開く file tab context menu からだけ操作できます。中央 header は、開いているファイルのリポジトリ相対パスだけを表示します。

Markdown と HTML ファイルは `Rendered` と `Source` を切り替えられます。`Source` は読みやすいように長い行を折り返します。コード、YAML、テキストファイルは、行番号と横スクロール付きの `Raw` code viewer で表示します。Rendered Markdown はカード枠で囲まず、本文として表示します。codeblock は高コントラストで横スクロールできる style にしています。

サイドパネルには `Outline` と `Memo` があります。`Outline` は `Table of Contents` として Markdown heading を表示し、項目をクリックすると中央 viewer の該当 heading へスクロールします。`Memo` はブラウザ UI 内の session-only scratchpad であり、リポジトリ内のファイルを保存・編集しません。Memo は `Raw` 編集、`Render` markdown preview、copy、download、delete の icon button に対応します。

## 安全境界

サーバーは、要求されたすべてのパスを path guard で解決します。リポジトリ相対パスだけを受け付け、絶対パス、`..` による traversal、登録済み root の外へ出る symlink、除外対象のパスを拒否します。既定の除外リストでは、常に `.git` をブロックします。

Reader-Wiki は、リポジトリを開いた時点の current local working tree を読みます。remote Git fetch は既定で無効です。`fetchRemote: true` を設定した場合だけ Git sync は fetch-only になります。fetch に認証が必要な場合や失敗した場合でも、Reader-Wiki は現在の local state を表示し続け、UI には warning だけを表示します。

## 対象外

この edition は、ブラウザベースの local viewer に限定しています。native desktop shell、bundled runtime state、AI chat surface、terminal UI、signing flow、update service、packaged release artifact は、最初の public scope から意図的に外しています。

## 検証

変更を共有する前に、次のコマンドを実行します。

```bash
pnpm typecheck
pnpm test
pnpm build
```

公開前には、local-only path、credential、generated artifact が tree に含まれていないことも scan してください。public repository の外に置くべき内容が scan で報告されない状態にします。
