# BlueGarden 仕様書

## SNS生態系テラリウム

---

## 1. プロジェクト概要

### 1.1 プロジェクト名

**BlueGarden**

### 1.2 コンセプト

BlueGardenは、Bluesky上を流れる投稿をリアルタイムまたは準リアルタイムで取得し、それらを「植物」「光」「雨」「天候」などの自然環境として可視化するデスクトップGUIアプリケーションである。

通常のSNSクライアントのように投稿本文を読むことを目的とせず、SNS上の活動量や投稿の雰囲気を、

- 植物
- 花
- 棘
- 光
- 雨
- 成長速度
- 植物密度

などへ変換し、「SNSの空気感」を環境アートとして楽しむことを目的とする。

---

# 2. 初期開発方針

BlueGardenは長時間起動するデスクトップアプリケーションを想定する。

そのため、初期実装では以下を優先する。

1. 軽量であること
2. 長時間動作してもメモリ使用量が増え続けないこと
3. Bluesky APIと描画処理を分離すること
4. 将来的にJetstreamや3D描画へ拡張できること
5. SNS投稿そのものを必要以上に保持しないこと

---

# 3. 技術スタック

## 3.1 採用技術

| 分類 | 技術 |
|---|---|
| デスクトップフレームワーク | Tauri 2 |
| UI | React |
| 言語 | TypeScript |
| ビルド | Vite |
| 2D描画 | PixiJS |
| Bluesky API | Bluesky / AT Protocol TypeScript SDK |
| 通常フィード取得 | `app.bsky.feed.getTimeline` |
| カスタムフィード取得 | `app.bsky.feed.getFeed` |
| キーワード検索 | `app.bsky.feed.searchPosts` |
| リアルタイムストリーム | Jetstream |
| 認証 | 初期版: App Password |
| 将来の認証 | OAuth |
| 秘密情報保存 | OSの資格情報ストア (Windows資格情報マネージャー等。Tauri Strongholdは代替) |

---

# 4. 技術選定理由

## 4.1 Tauri

ElectronではなくTauriを採用する。

BlueGardenは環境映像のように長時間起動するアプリケーションであるため、Chromiumをアプリケーションごとに持つElectronよりも、OSのWebViewを利用するTauriの方が適している。

主な理由は以下である。

- メモリ使用量を抑えやすい
- アプリケーションサイズを小さくできる
- React / TypeScriptを利用できる
- Rust側へ処理を移行する余地がある
- デスクトップアプリケーションとして配布可能
- セキュアストレージを利用可能

---

## 4.2 React + TypeScript

UI部分にはReactを使用する。

主に以下を担当する。

- ログイン画面
- 設定画面
- フィード切り替え
- エラー表示
- PixiJSキャンバスの管理

描画処理そのものはReactコンポーネントとして大量に生成せず、PixiJS側で管理する。

---

## 4.3 PixiJS

初期バージョンではThree.jsではなくPixiJSを使用する。

BlueGardenで初期段階に必要となる表現は、

- 植物
- 花
- 草
- 棘
- 光粒子
- 雨
- 揺れ
- フェード
- スケールアニメーション

などであり、2D GPUレンダリングで十分実現可能である。

3D表現は将来的な拡張として検討する。

---

# 5. システムアーキテクチャ

```text
Bluesky
   |
   v
Bluesky Data Source
   |
   |-- Timeline
   |-- Custom Feed
   |-- Search
   `-- Jetstream
   |
   v
GardenPost
   |
   v
Post Mapping Layer
   |
   |-- sentiment
   |-- engagement
   `-- flow rate
   |
   v
PlantSeed
   |
   v
TerrariumEngine
   |
   v
PixiJS
   |
   v
BlueGarden GUI
```

---

# 6. レイヤー構造

BlueGardenではBluesky APIのレスポンスを直接描画エンジンへ渡さない。

以下の変換を行う。

```text
Bluesky Post
     |
     v
GardenPost
     |
     v
PlantSeed
     |
     v
PlantObject
```

これによりBluesky APIと描画エンジンを疎結合にする。

---

# 7. ディレクトリ構成

```text
bluegarden/
|
|-- src/
|   |
|   |-- components/
|   |   |-- LoginPanel.tsx
|   |   `-- SettingsPanel.tsx
|   |
|   |-- domain/
|   |   |-- models.ts
|   |   `-- postMapping.ts
|   |
|   |-- services/
|   |   `-- bluesky/
|   |       |-- BlueskyFeedClient.ts
|   |       |-- JetstreamSource.ts
|   |       `-- polling.ts
|   |
|   |-- rendering/
|   |   `-- TerrariumEngine.ts
|   |
|   |-- App.tsx
|   |-- main.tsx
|   `-- styles.css
|
|-- src-tauri/
|   |-- src/
|   |   `-- lib.rs
|   |
|   |-- capabilities/
|   `-- tauri.conf.json
|
|-- package.json
|-- tsconfig.json
|-- vite.config.ts
`-- README.md
```

---

# 8. ドメインモデル

## 8.1 GardenPost

Blueskyから取得した投稿をBlueGarden内部用に変換したモデル。

```ts
interface GardenPost {
  uri: string;
  text: string;
  createdAt: string;

  likeCount: number;
  repostCount: number;
}
```

Bluesky固有の巨大なレスポンスオブジェクトをアプリケーション全体で保持しない。

---

## 8.2 Mood

投稿の簡易的な感情分類。

```ts
type Mood =
  | "positive"
  | "negative"
  | "neutral";
```

---

## 8.3 PlantSeed

投稿から生成される植物情報。

```ts
interface PlantSeed {
  id: string;

  mood: Mood;

  color: number;

  scale: number;

  growthDurationMs: number;

  thorny: boolean;
}
```

---

## 8.4 FeedTarget

描画対象フィードを表す。

```ts
type FeedTarget =
  | {
      kind: "timeline";
    }
  | {
      kind: "custom";
      feedUri: string;
    }
  | {
      kind: "keyword";
      query: string;
    }
  | {
      kind: "global";
    };
```

`global` はJetstreamによるGlobal Garden Mode (§13) を表す。

---

# 9. 認証

## 9.1 初期バージョン

初期バージョンでは以下を入力する。

- Blueskyハンドル
- App Password

例:

```text
example.bsky.social
xxxx-xxxx-xxxx-xxxx
```

通常のBlueskyアカウントパスワードは使用せず、App Passwordの使用を前提とする。

---

## 9.2 パスワード管理

初期実装ではApp Passwordを永続保存しない。

ログイン成功後はReact stateなどから可能な限り削除する。

```text
App Password
     |
     v
Login
     |
     v
Session
     |
     v
Password state clear
```

将来的にログイン情報を保存する場合は、

```text
OSの資格情報ストア
(Windows資格情報マネージャー / macOS Keychain / Secret Service)
```

などのセキュアストレージを利用する (Tauri Strongholdは代替)。
App Password自体は保存せず、保存するのはログインセッションのみとする。

平文JSONやlocalStorageへの保存は禁止する。

---

## 9.3 将来

正式版ではOAuthへの移行を検討する。

```text
MVP
App Password

↓

Production
OAuth
```

---

# 10. フィード取得

初期版ではリアルタイムJetstreamではなく、通常のBluesky APIによるPollingを基本とする。

---

## 10.1 Timeline

ログインユーザーのタイムラインを取得する。

使用API:

```text
app.bsky.feed.getTimeline
```

---

## 10.2 Custom Feed

カスタムフィードを取得する。

使用API:

```text
app.bsky.feed.getFeed
```

---

## 10.3 Keyword

指定されたキーワードによる投稿を取得する。

使用API:

```text
app.bsky.feed.searchPosts
```

---

# 11. Polling

初期設定では15秒間隔とする。

```text
15 seconds
    |
    v
fetch
    |
    v
new posts
    |
    v
plant generation
```

基本値:

```ts
const POLLING_INTERVAL = 15_000;
```

---

## 11.1 エラー時バックオフ

API通信に失敗した場合、連続して高頻度アクセスしない。

```text
15 sec
 ↓
30 sec
 ↓
60 sec
```

最大60秒程度とする。

通信成功後は通常の15秒へ戻す。

---

# 12. 投稿重複防止

Pollingでは同じ投稿を複数回取得する可能性がある。

そのため投稿URIを使用して重複を排除する。

```ts
Set<string>
```

を使用する。

ただしSet自体が永久に成長しないよう、

```text
maxSeen = 5000
```

などの上限を設定する。

古いURIから削除する。

---

# 13. Jetstream

Jetstreamは初期MVPの必須機能とはしない。

将来的に、

**Global Garden Mode**

として導入する。

---

## 13.1 Timelineとの違い

Timeline:

```text
自分がフォローしているユーザー
        |
        v
自分向けSNS Garden
```

Jetstream:

```text
Bluesky全体
     |
     v
Global Garden
```

という用途とする。

---

## 13.2 Jetstreamの注意点

投稿作成イベントを受信した時点では、

- Like数
- Repost数

などは存在しない。

そのため初期状態では、

```ts
likeCount = 0;
repostCount = 0;
```

とする。

---

## 13.3 将来の成長処理

Jetstreamから投稿を取得後、

```text
Post created
     |
     v
small plant
     |
     v
30 sec
     |
     v
fetch engagement
     |
     v
likes / reposts
     |
     v
additional growth
```

のような処理を実装できる。

---

# 14. 投稿 → 植物変換

BlueGardenの中心となる処理。

```text
Post
 |
 |-- Text
 |-- Likes
 `-- Reposts
      |
      v
 PlantSeed
```

---

# 15. 感情分析

初期バージョンでは簡易キーワード方式を使用する。

---

## 15.1 Positive

例:

```text
最高
嬉しい
うれしい
好き
楽しい
笑

happy
love
great
awesome
```

---

## 15.2 Negative

例:

```text
疲れた
最悪
悲しい
怒
つらい
嫌い

sad
angry
hate
tired
```

---

## 15.3 Neutral

Positive / Negativeのどちらにも該当しない投稿。

---

# 16. 感情と植物の対応

## Positive

```text
Pink
Orange
Flower
Round leaves
```

イメージ:

```text
   🌸
    |
  \ | /
```

---

## Neutral

```text
Green
Leaf
Normal plant
```

---

## Negative

```text
Blue
Dark green
Dark purple
Thorns
Sharp leaves
```

---

# 17. Engagementと植物サイズ

以下を基準値とする。

```text
engagement =
    likeCount
    +
    repostCount * 2
```

RepostをLikeより強く評価する。

---

## 17.1 サイズ

単純な比例にはしない。

例えば、

```text
1 like
100 likes
10000 likes
```

に対して植物サイズが10000倍にならないよう、

```ts
Math.log1p(engagement)
```

を利用する。

---

## 17.2 初期式

```ts
scale =
  0.75 +
  Math.log1p(engagement) * 0.16;
```

範囲:

```text
0.75
～
2.4
```

程度へClampする。

---

# 18. 成長速度

人気の投稿ほど植物の成長速度を速くする。

基本成長時間:

```text
2500 ms
```

エンゲージメントに応じて短縮する。

ただし極端な速度にならないよう上限を設定する。

---

# 19. 植物ライフサイクル

植物は永久に残さない。

基本ライフサイクル:

```text
Post received
     |
     v
Seed
     |
     v
Growth
     |
     v
Mature
     |
     v
Fade out
     |
     v
Destroy
```

---

## 19.1 推奨初期値

```text
Growth:

約 1～3 sec


Lifetime:

約 180 sec


Fade:

最後の 20 sec
```

---

# 20. 植物数制限

画面内植物数には上限を設定する。

初期値:

```text
MAX_PLANTS = 300
```

300本を超えた場合、

```text
oldest plant
     |
     v
destroy
```

する。

これにより長時間起動時のメモリ増加を防ぐ。

---

# 21. PixiJS描画

描画エンジンは以下のクラスとして実装する。

```text
TerrariumEngine
```

主な責務:

```text
PixiJS initialization

plant creation

growth animation

wind animation

fade animation

particle generation

object destruction
```

---

# 22. PlantObject

内部では以下のような情報を保持する。

```ts
interface PlantObject {
  view: Container;

  ageMs: number;

  lifeMs: number;

  growthDurationMs: number;

  targetScale: number;

  swayPhase: number;
}
```

投稿本文などは保持しない。

---

# 23. 植物アニメーション

## Growth

生成直後:

```text
scale = 0.01
```

から開始する。

数秒かけて、

```text
targetScale
```

まで成長する。

---

## Wind

植物をわずかに左右へ揺らす。

例:

```ts
rotation =
  Math.sin(time + phase)
  * 0.018;
```

各植物ごとにphaseを変えることで、同じ動きをしないようにする。

---

## Fade

寿命が近づいた植物は徐々に透明にする。

```text
alpha

1.0
 ↓
0.0
```

---

# 24. Environment Layer

BlueGardenでは投稿単体だけでなくSNS全体の状態も環境へ反映する。

概念として以下の3層とする。

```text
Post
 |
 v
Plant


Short-term activity
 |
 v
Weather


Long-term activity
 |
 v
Season
```

---

# 25. 投稿流速

直近60秒間の投稿数を計測する。

```text
postsPerMinute
```

として管理する。

例:

```text
5 posts/min
   ↓
Calm


30 posts/min
   ↓
Active


100 posts/min
   ↓
Very Active
```

---

# 26. 光粒子

投稿流速が一定以上の場合、

```text
Light Particle
```

を発生させる。

例えば、

```text
postsPerMinute > 25
```

の場合、光粒子の生成確率を増加させる。

---

# 27. 将来的な天候

以下を追加可能とする。

```text
High traffic
     |
     +-- Light particles
     |
     +-- Rain
     |
     +-- Wind
     |
     `-- Fireflies
```

---

# 28. プライバシー設計

BlueGardenでは投稿本文を表示することを目的としない。

可能な限り、

```text
Bluesky Post
     |
     v
Analysis
     |
     v
PlantSeed
     |
     v
Discard text
```

とする。

描画エンジンでは以下だけを保持する。

```text
Mood

Color

Scale

Growth speed

Shape
```

投稿本文を描画オブジェクトへ保持しない。

---

# 29. ReactとPixiJSの役割分担

React:

```text
Login

Settings

Feed selector

Error UI

Terrarium canvas lifecycle
```

PixiJS:

```text
Plants

Particles

Rain

Animation

Rendering
```

大量の植物をReact DOMで管理しない。

---

# 30. Settings UI

将来的に設定画面から以下を変更可能とする。

## Feed

```text
Timeline

Custom Feed

Keyword

Global / Jetstream
```

---

## Rendering

```text
Max Plants

Plant Lifetime

Animation Speed

Particle Intensity

Rain

Wind

Bloom Effects
```

---

# 31. 初期UI

起動時にはGardenを背景にログインパネルを中央表示する。

イメージ:

```text
+--------------------------------------+
|                                      |
|            BlueGarden                |
|                                      |
|    SNSの流れを、静かな庭として眺める。 |
|                                      |
|    [ handle.bsky.social          ]    |
|                                      |
|    [ App Password                ]    |
|                                      |
|          [ Enter Garden ]             |
|                                      |
+--------------------------------------+
```

背景では薄暗いGardenを表示する。

---

# 32. Garden画面

ログイン後はUIを最小化する。

基本画面:

```text
+--------------------------------------+
|                             Settings |
|                                      |
|              *                       |
|      plant         plant             |
|                  *                   |
|  plant        plant         plant    |
|                                      |
|______________________________________|
```

UIを操作していないときは環境映像として楽しめることを重視する。

---

# 33. セットアップ

## 必要環境

推奨:

```text
Node.js 22+

npm

Rust stable

Tauri dependencies
```

---

## プロジェクト作成

```bash
npm create tauri-app@latest bluegarden
```

選択:

```text
TypeScript / JavaScript

npm

React

TypeScript
```

---

## ディレクトリ移動

```bash
cd bluegarden
```

---

## インストール

```bash
npm install
```

---

## PixiJS

```bash
npm install pixi.js
```

---

## Bluesky / AT Protocol SDK

利用するSDKの最新版に合わせて必要パッケージを導入する。

例:

```bash
npm install @bsky/sdk
npm install @atproto/lex
npm install @atproto/lex-password-session
```

---

## Jetstream

Jetstream機能を追加する場合:

```bash
npm install @bsky/jetstream
```

---

## Secure Storage

必要になった段階で、Rust側から `keyring` crate などでOSの資格情報ストアを利用する。
(Tauri Strongholdを使う場合は `npm run tauri add stronghold`)

---

## 開発起動

```bash
npm run tauri dev
```

---

# 34. MVP

初期バージョンでは以下のみを実装する。

```text
Bluesky Login

        ↓

Timeline polling

        ↓

GardenPost

        ↓

Simple sentiment

        ↓

PlantSeed

        ↓

PixiJS Plant

        ↓

Growth animation

        ↓

Fade out

        ↓

Destroy
```

---

# 35. MVP必須機能

- [ ] Tauriアプリケーション起動
- [ ] React UI表示
- [ ] PixiJS Canvas表示
- [ ] Bluesky App Passwordログイン
- [ ] Timeline取得
- [ ] 15秒Polling
- [ ] 投稿重複排除
- [ ] GardenPost変換
- [ ] Positive判定
- [ ] Negative判定
- [ ] Neutral判定
- [ ] Engagement計算
- [ ] PlantSeed生成
- [ ] 植物描画
- [ ] 植物成長アニメーション
- [ ] 植物の揺れ
- [ ] Fade out
- [ ] PixiJSオブジェクトDestroy
- [ ] 最大植物数制限
- [ ] 投稿流速計測
- [ ] 高流量時Light Particle生成

---

# 36. Phase 2

MVP完成後に実装する。

- [ ] Custom Feed
- [ ] Keyword Feed
- [ ] Settings画面
- [ ] Rain
- [ ] Wind intensity
- [ ] Fireflies
- [ ] Particle intensity
- [ ] Garden theme
- [ ] Feed selector
- [ ] エフェクトON/OFF
- [ ] Plant lifetime変更

---

# 37. Phase 3

Blueskyリアルタイム連携を強化する。

- [ ] Jetstream
- [ ] Global Garden Mode
- [ ] Jetstream reconnect
- [ ] Cursor restore
- [ ] Likeによる後成長
- [ ] Repostによる後成長
- [ ] OAuth
- [ ] セキュアストレージ (OSの資格情報ストア。Tauri Strongholdは代替)
- [ ] System Tray
- [ ] Fullscreen Mode
- [ ] Screensaver Mode (アプリ内の全画面アンビエントモード。UIとカーソルを隠し、入力で解除する。OSのスクリーンセーバー連携は対象外)

---

# 38. Phase 4

高度なビジュアル表現を実装する。

候補:

```text
Three.js

3D plants

Procedural vegetation

Bloom

Depth of field

Dynamic lighting

Day / Night cycle

Weather

Seasons
```

---

# 39. 将来的な世界表現

BlueGardenではSNSの情報を3階層で自然環境へ変換する。

## Micro

一つの投稿。

```text
Post
 ↓
Plant
```

---

## Meso

数十秒～数分間のSNS活動。

```text
Activity
 ↓
Weather
```

例:

```text
投稿量増加
 ↓
雨

ポジティブ投稿増加
 ↓
光

ネガティブ投稿増加
 ↓
霧
```

---

## Macro

数時間単位のSNS状態。

```text
Long-term trend
 ↓
Season / Environment
```

将来的には、

```text
Morning

Evening

Rainy Garden

Blooming Garden

Dark Forest
```

などへ反映する。

---

# 40. 非機能要件

## Performance

- 60 FPSを目標とする
- 描画オブジェクト数に上限を設定する
- 古いオブジェクトは必ずDestroyする
- 大量DOM要素を生成しない

---

## Memory

以下に上限を設定する。

```text
Plants

Seen Post IDs

Particles

Feed history
```

投稿履歴を無制限に保存しない。

---

## Network

- Polling間隔を最低数秒以上にする
- 標準値は15秒
- APIエラー時はバックオフ
- 同一投稿を再処理しない

---

## Security

以下は禁止する。

```text
App Password in source code

App Password in git

App Password in localStorage

Plain text credential file
```

---

# 41. エラー処理

以下のケースを想定する。

```text
Invalid Handle

Invalid App Password

Network Error

API Error

Rate Limit

Feed Not Found

WebSocket Disconnect
```

通信エラーによってGarden描画自体が停止しないようにする。

---

# 42. ロギング

開発中は以下をログへ出力する。

```text
Login

Feed fetch

Posts received

Posts ignored

Plant generated

API error

Reconnect
```

ただしApp Passwordは絶対にログへ出力しない。

投稿本文のログ出力についても必要最低限とする。

---

# 43. 初期受け入れ条件

MVP完成条件を以下とする。

1. BlueGardenをデスクトップアプリとして起動できる。
2. Bluesky App Passwordでログインできる。
3. Timelineから投稿を定期取得できる。
4. 取得した新しい投稿1件につき植物1本が生成される (1回の取得範囲を超えた投稿、ウィンドウ非表示中の投稿は対象外。Global Garden Modeでは投稿量が多いため、一部を抽出して植物化し、全体量は流速として反映する)。
5. Positive / Negative / Neutralによって植物の見た目が変化する。
6. Like / Repost数によって植物サイズまたは成長速度が変化する。
7. 投稿量が増えると光粒子が増える。
8. 古い植物がFade outする。
9. Fade終了後にPixiJSオブジェクトが破棄される。
10. 数時間実行しても植物数や保持投稿IDが無制限に増加しない。

---

# 44. 初期実装優先順位

以下の順番で実装する。

```text
1. Tauri + React setup

2. PixiJS canvas

3. Test plant generation

4. Plant animation

5. Bluesky authentication

6. Timeline API

7. GardenPost normalization

8. Post -> PlantSeed mapping

9. API + Garden integration

10. Lifetime / Garbage Collection

11. Flow rate

12. Particles
```

Bluesky API接続より先にPixiJS側をダミーデータで完成させてもよい。

例えば、

```ts
setInterval(() => {
  createRandomPlant();
}, 1000);
```

のようなMockを利用し、描画エンジンとAPI通信を独立して開発する。

---

# 45. 設計上の基本原則

BlueGardenでは以下を基本原則とする。

```text
APIとRenderingを分離する

PostとPlantを分離する

SNSテキストを必要以上に保持しない

描画オブジェクトを永久に保持しない

リアルタイム性より安定性を優先する

MVPでは2Dを採用する

将来的なJetstream / 3D化を阻害しない
```

---

# 46. BlueGardenの最終的なコンセプト

BlueGardenは単なるBluesky可視化ツールではなく、

```text
SNS
 ↓
Signals
 ↓
Ecosystem
```

へ変換する環境アートアプリケーションを目指す。

基本対応関係は以下とする。

```text
Post
    =
Plant


Sentiment
    =
Plant appearance


Engagement
    =
Plant growth


Post frequency
    =
Weather


Long-term SNS activity
    =
Environment / Season
```

ユーザーが投稿本文を読まなくても、

> 「今日はSNSが賑やかだ」

> 「今日は穏やかだ」

> 「今日は少し暗い雰囲気だ」

と感じられることをBlueGardenの主要なUX目標とする。