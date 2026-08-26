# bot-2509 エンジン移植計画（Rust）

作成: 2026-08-27 / 状態: 計画（ユーザー決定「エンジンはbot-2509を移植。Rustにしてもいい」を受けて）

## 移植元の実測

bot-2509 `services/backtest_v2` の構成（実測LOC）:

- **Rustコア `backtest_engine_rs`（約3,300行）**: シミュレーション本体。`process_signals`（ABI v6、約50引数）が、ポジション状態・リバランス・手数料/スリッページ・sqrtコストモデル（JP板寄せ/クリプト別パラメタ）・funding・ADVキャップ・ロットサイズ・cash flow・資本サイジングまでを1回の呼び出しで処理する。pyo3 cdylib（Python拡張）として実装。`#![forbid(unsafe_code)]`。依存は error-contract（116行）と indexmap のみ。
- **Python層（コア約6,500行＋周辺）**: シグナル処理（rebalance格子）、メトリクス（133行）、timeseries（465行）、結果書き込み、ClickHouseデータロード、検証。

## 移植方針

**Phase A — Rustコアの独立化（本命・約3,300行の機械的移植）**

1. `backtest_engine_rs` をtradecoreへfork（`engine-rs/`）。engine/exec_cost/position_state/price_lookup/adv_lookup/config/types はほぼそのまま。
2. pyo3境界を除去し、serdeで `ProcessSignalsRequest`（ABI v6のミラー）を定義。**stdin JSON → stdout JSON のCLIバイナリ**にする（WASM化は後続オプション）。
3. error-contract（116行）はvendor。credential・インフラ依存はもともと無い（純計算）。
4. **golden parity**: bot-2509側で合成入力のpayload+結果ペアをdumpしてfixtureとしてtradecoreにコミット。CIで移植バイナリが同一出力を再現することを常時検証。「結果は一致するか？」に fixtures で YES と答えられる状態を作る。

**Phase B — 薄いオーケストレーション**

- 公開データ（Binance/HL）から signals + price_data payload を組むJS層。メトリクス（133行）とtimeseriesの必要部分を移植。
- チャットエージェントの `ls:` 評価のspread側をエンジン実行に置き換え（IC計算はラウンド採点なのでJS側に残す）。

**非移植（bot-2509に残すもの）**: ClickHouseローダ、config registry、result writer、戦略register群、公式run ID発行系。公開されるのは計算コアのみ。

## 留意

- 公開リポジトリへの移植＝計算コアのOSS化（ユーザー決定済み）。堀は生成器＝ネットワークと評価インフラ（fable-concept §6）。
- ABI v6は今後もbot-2509側で進む。fork時点のABIバージョンをfixtureに固定し、追随は必要になった時に判断（無条件追随はしない）。
- 見積り: Phase A 1〜2セッション、Phase B 1セッション。

## 暫定エンジンの扱い

`src/ls-eval.mjs`（JS製クロスセクション評価・固定ファクターテンプレ）は**内部デモ**（パイプライン疎通確認用）に格下げ済み（fable-concept §6）。公開の看板にはしない。本命は論文コードのサンドボックス実行＋本移植エンジンでの採点。
