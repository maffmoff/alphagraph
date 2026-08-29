# データ基盤のテナント復活設計 — ClickHouse外部接続（ドラフト）

作成: 2026-08-27 / 状態: Phase 1 のリポジトリ側実装済み（§8）。インフラ実施（Warehouse新設・予算アラート）は人間承認事項として未了

ユーザー決定「ClickHouseを公開して接続できるようにしたい。テナント機能を復活」を受けた設計。
bot-2509 の停止中テナント機構の実測調査（2026-08-27）に基づく。

## 1. 前提: 何が実在し、なぜ止まっているか

bot-2509 には外部ユーザー向けClickHouse提供の**完全な実装が存在する**（`infrastructure/clickhouse/manage_users.py` 2,121行・`permissions.py` 1,522行・`admin_provision.py`）。ただし:

- **2026-07-31** に credential 配布を停止、**2026-08-12** に「current phase では公開しない」で正式クローズ（bot-2509 HiveFi-Labs/bot-2509#1811）
- 外部用 secondary サービスは **CI設定ミスで月$1,670を溶かして廃止**（HiveFi-Labs/bot-2509#3812）。旧host・secret・CI変数の再利用は複数文書で明示的に禁止
- 再開条件は #1811 の公開前チェックを満たす**独立レビューでの新規構築**

つまり「復活」は設定を戻す作業ではなく、**#1811 のゲートを通す新規構築**である。

## 2. AlphaGraphでの位置付け

fable-concept §6「データ=二レーン」の**計算持ち込みレーンの実体**がこれになる。

- **生データ公開レーン**（現行 `src/data-source.mjs`）: HL/Binance公開API。誰でも無認証で同一バイト列を取得でき、等級1再現が完全に成立する。**このレーンはテナント不要のまま維持**
- **計算持ち込みレーン**（本設計）: ライセンス上再配布できない系列（株式系等）と、当社が整備した派生データ。データは外に出さず、テナントは読み取り接続で計算し、署名済み結果を台帳に返す

境界（§8）との整合: 参加者の秘密鍵・取引所キーは**引き続き要求しない**。逆方向——当社が読み取りcredentialを**発行する**——であり、境界に抵触しない。

## 3. 再利用できるもの / 作り直すもの（調査結果）

| 資産 | 判定 |
|---|---|
| denylist方式のGRANT・BLOCKED_TABLES | **再利用**。認証方式に依存しない |
| owner列 + RESTRICTIVE ROW POLICY（`owner = currentUser()`・owner列は書込不可） | **転用**。ただし目的が変わる——秘匿（他人の行を見せない）ではなく**改ざん防止（他人を騙って書けない）**。DID署名の完全性保証と相性が良い |
| QUOTA / READONLY付きSETTINGS PROFILE（8GB/query・120s・60q/min 等） | **再利用**。数値はdry-run後に絞る二段階運用の設計思想ごと |
| TIMESERIES_CUTOFF（RESTRICTIVE ROW POLICYで最新データを構造的に遮断） | **転用**。ラウンドの「materialize済みデータのみ」契約のDB版 |
| メール一意・API key/パスワード配布・stdout一回表示の払い出し | **作り直し**。匿名エージェント前提と両立しない。DID署名によるself-service onboardingへ |
| 認証（sha256_password） | **作り直し**。#1811でも未対応指摘（saltなし）。bcrypt化 or 外部検証層＋短命credential |

## 4. AlphaGraph版の設計骨子

**原則: credentialの発行そのものを台帳イベントにする。**

1. **申込＝封緘と同じ経路**: 参加者DIDが署名済みリクエストを台帳取込口に出す → `TENANT_GRANTED` イベント（DID・ロール・QUOTA階級・有効期限）が積まれる → ClickHouse側に `t_<did短縮>` ユーザーが作られる
2. **短命credential**: パスワードは長期配布せず、`VALID UNTIL` つきで発行し、更新も署名済みリクエスト（#1811 §5.3の未対応項目を最初から満たす）
3. **読み取り専用＋結果は台帳へ**: テナントは SELECT のみ。計算結果は署名して論文/再現として台帳に返す（ClickHouseへの書き戻しは当面させない——bot-2509のwriter分離の複雑さ（#1884/#1899）を丸ごと回避）
4. **DIDごとのQUOTA＝レート制限**: fable-concept §5「計算枠はDIDごとのレート制限」の実装がそのままこれ。未決11（封緘のレート制限）とも同じ機構で解ける
5. **監査は公開**: `system.query_log` の集計（誰が・何量）を日次で台帳に積む。「防止でなく検出」をDB利用にも適用

## 5. #1811ゲートのAlphaGraph版チェックリスト（着工前に潰す）

- [ ] `system.*` テーブルのREVOKE（他テナントのクエリ文字列＝**研究仮説そのもの**が漏れる。AlphaGraphでは致命的）
- [ ] 外部テーブル関数（`url()`/`s3()`/`remote()`）+ INTROSPECTION のREVOKE（QUOTA外のデータ持ち出し経路）
- [ ] **compute分離**: 本体運用（bot-2509本番）と外部負荷を同居させない。専用serviceを新設（Warehouse or 別インスタンス）。旧secondaryの轍: **接続先変数の用途分離をIaCレベルで明示**し、idle停止の発動をコストアラートで監視
- [ ] 月額予算上限＋per-DID異常検知→自動suspend
- [ ] **primary サービスの network allowlist が閉じていること**（方式Aの帰結。ユーザー/権限は
  Warehouse内の全サービスで共有される＝テナントの資格情報は primary のエンドポイントでも
  認証が通る。RBAC/QUOTAは継承されるが、primary の計算資源を燃やす経路はネットワーク層で
  塞ぐしかない——公式 warehouses docs の network access control が該当機構）
- [ ] 利用規約・SLA（bot-2509のドラフトを流用可）と、規制確認（既存の人間承認事項に追加）
- [ ] 段階ロールアウト: 自分のDID→招待制α→一般

## 6. 段階計画

- **Phase 0（今すぐ・費用ゼロ）**: 本設計の合意。台帳イベント語彙に `TENANT_GRANTED` / `TENANT_REVOKED` / `USAGE_REPORTED` を追加
- **Phase 1**: 専用ClickHouseサービス新設（小構成・idle停止・予算アラート）。データはまず**当社整備の派生データ**（HL日次スナップショット等の再配布可能なもの）だけ載せ、機構を自分のDIDで一周させる — **リポジトリ側は実装済み（§8）。Warehouse新設は人間作業**
- **Phase 2**: DID self-service onboarding の取込口実装（署名検証→ユーザー作成→台帳記録）。招待制で数DID
- **Phase 3**: 株式系など再配布不可データの搭載（ライセンス棚卸し=未決6が前提）と一般開放

## 7. 人間承認・人間作業（このリポジトリの外）

1. ClickHouse Cloud での新サービス作成と予算上限（費用が発生する）
   — **作成自体は `tenant-provision` でAPI化済み（§8）**。残る人間作業は
   (a) テナント用organizationのOpenAPI key発行（コンソール・一回だけ）と
   (b) 課金通知しきい値の設定（Billing通知はAPIに無いためコンソール。日次の実測は
   `tenant-cost` が代替線）、(c) `--confirm CREATE` 実行の承認
2. bot-2509 側の #1811 再開レビュー（「独立issue/PRで再評価」が再開条件のため、bot-2509にissueを立てる）
3. 規制確認への追記（外部への計算資源提供の性質）

## 8. Phase 1 実装（2026-08-27・このリポジトリ）

実装: `src/tenant.mjs`（DDL・credential・台帳イベントの純ロジック）と `src/tenant-admin.mjs`（管理接続）。
CLIは `tenant-init` / `tenant-grant` / `tenant-revoke` / `tenant-load-hl` / `tenant-usage` / `tenant-verify` の6コマンド。

**接続の用途分離（§5 チェック3・旧secondary #3812 の教訓）**: 管理接続が読む環境変数は
`ALPHAGRAPH_TENANT_ADMIN_URL` / `_USER` / `_PASSWORD` の3つだけで、`CLICKHOUSE_*` や bot-2509
変数へのフォールバック経路はコード上に存在しない。この不在自体をテストが検査する
（`test/tenant-admin.test.mjs` が env 読み出しを実測して3変数以外を拒否）。https必須・URL userinfo
禁止・生データ公開レーンのホストへの資格情報送信は構造的に拒否。

**秘密の扱い（§4 原則の具体化）**: `TENANT_GRANTED` はDID・ユーザー名・ロール・QUOTA階級・
`VALID UNTIL`・DDL全文ハッシュを載せるが、パスワード・salt・パスワードハッシュは載せない
（公開台帳はオフライン攻撃の材料になるため）。credentialはmode 600のローカルファイルに一回だけ
書かれ、配布はout-of-band。認証は `sha256_hash + SALT`（クライアント側でsalt付きハッシュ化して
から渡すので、平文パスワードはDDLにも管理側query_logにも現れない——#1811のsaltなし指摘を解消）。

**ゲートのDDL化（§5 チェック1-2）**: GRANTは `alphagraph_data.*` へのSELECTのみ。`system.*` と
外部テーブル関数（URL/REMOTE/S3等）・`CREATE TEMPORARY TABLE` は明示REVOKEで意図を固定。
SETTINGS PROFILEは `readonly=1 CONST`・`allow_ddl=0 CONST`・8GB/query・120s、QUOTAは
`KEYED BY user_name` で 60q/min・500GB read/day（DIDごとのレート制限＝fable-concept §5）。
RESTRICTIVE ROW POLICY `day < today()` が TIMESERIES_CUTOFF の転用。

**コントロールプレーン（サービス新設のAPI化）**: `src/tenant-cloud.mjs` が
api.clickhouse.cloud を叩く。環境変数は `ALPHAGRAPH_TENANT_CLOUD_KEY_ID` / `_KEY_SECRET` /
`_ORG_ID`（任意）のみで、admin接続と同じくフォールバック経路の不在をテストが検査する。
`tenant-provision` は費用が発生するため `--confirm CREATE` を要求し、小構成（8GB×1replica）・
`idleScaling: true`・`idleTimeoutMinutes`（既定15分）で作成した上で、**応答の実効値で
idleScaling が有効になったことを検証**する（#3812 は「頼んだ」と「付いた」の乖離に誰も
気付かなかった事故）。ingressは `--ip` で明示必須（全開は `anywhere` と書いた時だけ）。
`--warehouse-id` を渡すと既存Warehouseの secondary（方式A）として立つ（既定 read-only、
`--writable` でRW）。管理パスワードは一度しか返らないため stdout に出さず mode 600 の
ファイルにのみ書く。`tenant-cost` は usageCost API の日次コスト（CHC建て）を集計する
監視線で、cron 候補。`tenant-services` が primary の warehouse ID / region / provider の
発見、`tenant-service-state` が start/stop（ロード用RWサービスの明示停止）。

**方式Aレイアウト（2026-08-27 決定・公式 warehouses docs で裏取り済み）**:

- **テナント向け = read-only secondary**。RO サービスは遅延なく idle し、ユーザー管理
  （CREATE/DROP USER）もRO上で可能なので、`ALPHAGRAPH_TENANT_ADMIN_URL` はこの secondary を
  指せばよい（grant/revoke/usage が完結。bot-2509 primary を指す必要はない）
- **派生データのロード（CREATE TABLE / INSERT）だけは書き込みが要る**。選択肢は
  (a) `--writable` の RW secondary をもう一つ立て、ロード後に `tenant-service-state --command stop`
  で明示停止（RW は他サービスの merge 肩代わりで idle しないことがある＝#3812型の罠。
  idle任せにしない）、(b) bot-2509 側の既存ETLに任せる。Phase 1 は (a)
- **ユーザー共有の裏返し**（§5 最終チェック項目）: テナント資格情報は primary エンドポイント
  でも通るため、primary の network allowlist 確認が着工前提

**自分のDIDで一周（runbook・方式A版）**:

1. （人間）primary の属する organization で専用 OpenAPI key をコンソールで発行し
   `ALPHAGRAPH_TENANT_CLOUD_KEY_ID/_KEY_SECRET` を設定、課金通知しきい値を設定。
   primary の network allowlist が閉じていることを確認（§5 最終項目）
   → `tenant-services` で primary の `dataWarehouseId` / provider / region を確認
   → `tenant-provision --warehouse-id <ID> --provider <同> --region <同> --ip <自分のIP>/32 --confirm CREATE`
     （テナント向け read-only secondary）
   → `tenant-provision --warehouse-id <ID> ... --writable --name alphagraph-loader --confirm CREATE`
     （ロード用RW。手順2-3が終わったら `tenant-service-state --command stop` で明示停止）
   → 手順2-3 は RW の credential から、手順4以降は RO の credential から
     `ALPHAGRAPH_TENANT_ADMIN_*` を設定
2. `alphagraph tenant-init --execute` — 土台DDL（DB・派生テーブル・ロール・PROFILE・QUOTA・ROW POLICY）
3. `alphagraph tenant-load-hl --coin BTC --start ... --end ... --execute` — 生データ公開レーンから
   HL日次スナップショットを取得し搭載。来歴は `dataset_provenance` にも入り csv_sha256 で突き合う
4. `alphagraph tenant-grant --did <自分のDID> --identity <PEM> --execute` — 実行→台帳記録の順
   （台帳が「発行済み」と言うのにDBにユーザーがいない状態を作らない）。同一DIDの未失効grantが
   台帳にあれば拒否
5. `alphagraph tenant-verify --credentials artifacts/tenant/<user>.credential.json` — テナント資格情報で
   実サービスに当たり、SELECT可・INSERT不可・DDL不可・query_log不可・url()/remote()不可・cutoff有効を
   実測。全通過の報告書は attest 可能な成果物
6. `alphagraph tenant-usage --identity <PEM>` — `system.query_log` の日次集計を `USAGE_REPORTED` に積む
   （ゼロ件の日もゼロとして記録＝沈黙も監査可能）
7. 失効・撤収は `alphagraph tenant-revoke --did ... --execute` → `TENANT_REVOKED`

未了（Phase 1完了の条件）: 手順1の人間作業と、実Warehouseに対する手順2-6の実走。
Phase 2（DID self-service取込口）は §6 のとおり別途。
