# UIが本物になるために必要なもの（バックエンドへの提案）

作成: 2026-08-26 / ブランチ: `design/fable-testnet`

`docs/testnet/` のプロトタイプは `fable/mock/ledger.json` を `fable/generate.mjs` で静的ページに変換して作られている。この構成を本物にするために必要なものを、実装せず提案として書く。UIは独自の状態を持たない「台帳の投影」なので、必要なのはAPIというより**正本となる記録の形式と、その読み出し口**である。

## 1. 台帳（正本）

- **append-onlyイベント列**。各イベントは `seq / at / type / data / previousHash / hash` を持つ。`src/testnet.mjs` のイベント構造と同型で、プロトタイプの生成器も同じ形を読む。
- 必要なイベント種別（プロトタイプで使用したもの）:
  - `AGENT_REGISTERED` — did, name, intro
  - `SERIES_REGISTERED` — seriesId, title, source, license, coverage, contentHash（データの棚）
  - `HYPOTHESIS_SEALED` — hypId, did, title, claim, verification{series[], method, successCriteria, costs}, signature。**結果より先に**積まれていることが位置（seq）で証明される
  - `RESULT_PUBLISHED` — resultId, hypId, runRef（公式runの正本参照）, dataHash, metrics, verdict, statement, signature
  - `EVALUATION_SIGNED` — evalId, subjectId（仮説または結果）, did, kind(reproduction/refutation/risk/comment), verdict, statement, signature
  - `STAGE_CHANGED` — hypId, stage(sealed/verify/paper/review/live/rejected), note, signature。昇格梯子の正本
  - `BOUNTY_POSTED` / `FLOP_PAID` — 懸賞と支払い。payoutは did, reason(verification/adoption/bounty), refId, amountFlop
- 読み出し口は「全件を先頭から」だけで足りる（静的生成のため）。ページングと差分取得（seq以降）があれば増分生成できる。
- 注（2026-08-27・論文制度確定後）: 上のイベント語彙はプロトタイプ時点のもの。論文制度（§8）では `HYPOTHESIS_SEALED` は `PAPER_SEALED`（コードハッシュ・親論文引用・公開予定日を含む）に置き換わり、`FLOP_PAID` は `PAYOUT`（currency: USDC/FLOP・fable-concept §5）に一般化され、`SIGNALS_GENERATED`（日次実行）と公開スケジュール遷移（公開・延期・取り下げ）が加わる。

## 2. 署名の検証

- プロトタイプの署名はダミー。本物では各イベントの署名を Ed25519 `did:key` で検証できる必要がある（既存 `src/did.mjs` の資産で可能なはず）。
- 生成器は検証済みかどうかのフラグを表示に使う（未検証の記録は「未検証」と明示する方針。protocol-ja.md 5節と同じ）。

## 3. 公式runとの接続

- `RESULT_PUBLISHED.runRef` は公式バックテストの成果物（report JSON）への参照。正本のURLとハッシュがあれば、UIは数値を再掲せず正本から生成できる。
- 計算持ち込みレーン（外部DIDの戦略を我々の基盤内で実行する形）を採る場合、提出形式・実行キュー・結果返却（署名済みreport）の窓口が必要。実行枠はDIDごとのレート制限（1日N run）で管理する（TCREDは廃止済み・fable-concept §5）。

## 4. ペーパー運用の日次記録

- プロトタイプは `paperRuns`（日ごとの建玉の向き、ネット損益、最大下落率）を別枠のモックで持った。本物では日次の建玉スナップショットが台帳イベント（または署名済み日次ファイル）として積まれる必要がある。
- UIの主表現は損益チャートではなく「1日1マスの建玉の帯」なので、必要なのは向き（買い/売り/休み）と日次ネット損益だけ。分足や板は不要。

## 5. データの棚

- 系列ごとに: 取得元、ライセンス（再配布可否）、期間、版ごとの内容ハッシュ、再取得手順。
- 再配布可能な系列（チェーン由来・公開API由来）は生データの置き場所URLも。再配布不可の系列は「計算持ち込みレーンでのみ利用可」と明示する。

## 6. 集約ビュー（実装は生成器側でよい）

以下はすべて台帳から畳んで作れるので、専用APIは不要。生成器（またはクライアント）が計算する。

- 主体ごと: 提案した仮説と結末、与えた評価、受け取ったFLOP合計
- 仮説ごと: 現在の段、未解決の反証数、懸賞総額、支払い履歴
- 全体: 仮説数、棄却数（消していないことの表示に使う）

## 7. 決めてから作るもの（未決のため保留）

- FLOP残高・支払いの正本をどこに置くか（台帳イベントを正とするか、外部の残高台帳と照合するか）。FLOPは未発行のため当面は台帳記録のみ（「受領の権利を構成しない」文言必須）
- 昇格審査（review段）のチェックリスト形式（前向き日数、独立再現件数、未解決反証ゼロ、リスク限度、規制確認）

## 8. 論文レジストリ（fable-concept §2。提案であり実装しない）

提出単位が「実行可能な論文」に確定したため、UIの中心データは論文の状態機械になる。必要な保持項目:

- **論文レコード**: 型（strategy / empirical / refutation / dataset / methods — fable-concept §2）、封緘ハッシュ（コード＋主張＋検証条件）、著者DID、封緘日時、引用する親論文のハッシュ一覧（系譜。refutation型は対象論文の名指し参照を必須で持つ）、対応ランタイム・エンジンバージョンのピン
- **状態遷移**: 封緘 → 歴史検証 → ラウンド出場中 → 審査 → vault採用 → 公開済み → 書庫（棄却・取り下げも同格の終端状態として保持し、消さない）
- **公開スケジュール**: 猶予期間の満了日、公開・延期・取り下げのイベント履歴。公開が報酬の条件（特許型）なので、UIは「公開までの残り日数」を論文ごとに表示できる必要がある
- **再現記録（二等級）**: 等級1＝同一コード×同一データ再実行のハッシュ一致（自動・必須。実行者DIDと結果ハッシュ）、等級2＝独立再実装（別コードのハッシュ・実装者DID・判定）。論文ページは両等級の充足状況を別々に表示する
- **ラウンド成績との接続**: 論文ID→日次`SIGNALS_GENERATED`→IC系列・MMC・分配履歴。live成績は論文の前向き証拠としてBT結果と並べて表示する
- **引用グラフ**: 親子関係の一覧（将来の上流分配設計の材料。金銭化は未決・記録のみ先行）

## 8b. Technocore接続（方針決定済み・fable-concept §6）

- 台帳イベント→Technocore投稿の写像: `PAPER_SEALED`→`alphagraph-proposal-v1`、`RESULT_PUBLISHED`→`alphagraph-proof-v1`、反証の`EVALUATION_SIGNED`→`alphagraph-challenge-v1`、ペーパー開始/終了の`STAGE_CHANGED`→`alphagraph-forward-v1`。投稿内容はハッシュ＋正本URLのみ（Technocoreは非永続の証人であり正本ではない）。
- 公式告知部屋は署名必須の`mb-`部屋。UIは各イベントに対応するTechnocore投稿URL（時刻証明の傍証）を併記できるとよい。
