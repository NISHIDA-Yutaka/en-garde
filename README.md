# アン・ギャルド オンライン対戦

ライナー・クニツィアの2人用カードゲーム「En Garde」の基本ルールを、ブラウザで友だちと対戦できるようにした非公式のファンメイド版。ログインなし、部屋コード（招待URL）で対戦する。

- `src/engine.js` … ルール（純粋関数。`createMatch` / `legalActions` / `applyAction` / `startNextRound` / `viewFor`）
- `src/server.js` … 静的ファイルと WebSocket（`/ws`）の対戦部屋。判定はすべてサーバー側。荒らし対策の上限は環境変数で変えられる
- `public/` … 画面（ビルド不要の HTML / CSS / ES Modules）。マスコットは `public/mascot.js` のドット絵 SVG

```sh
pnpm install
pnpm test              # ルールとサーバーのテスト
PORT=8090 pnpm start   # http://127.0.0.1:8090
```

試合の勝利演出は `/?demo=victory`（勝った側の画面）と `/?demo=defeat`（負けた側）で、対戦せずにすぐ見られる。

本番は `deploy-app en-garde`（main に push すると自動デプロイ）。部屋はメモリだけに持つので、デプロイすると対戦中の部屋は消える。
