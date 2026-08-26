// ag-e-0001 の分析コード（実証・観察型論文の「方法」）。
// 入力: HL公開APIから取得した日次OHLCV CSV（ハッシュで釘付け済み）。
// 出力: 決定的なJSON1個。時刻・パス・環境に依存する値を一切含めない。
// 実行: node examples/papers/ag-e-0001-volume-return-coupling.mjs data/hl-BTC-1d.csv ...
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const round = (value, digits = 6) => {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
};

function spearman(left, right) {
  const rank = (values) => {
    const ordered = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
    const ranks = Array(values.length);
    for (let start = 0; start < ordered.length;) {
      let end = start + 1;
      while (end < ordered.length && ordered[end].value === ordered[start].value) end += 1;
      const average = (start + end - 1) / 2;
      for (let cursor = start; cursor < end; cursor += 1) ranks[ordered[cursor].index] = average;
      start = end;
    }
    return ranks;
  };
  const a = rank(left);
  const b = rank(right);
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const meanA = mean(a);
  const meanB = mean(b);
  let numerator = 0;
  let sumA = 0;
  let sumB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const da = a[index] - meanA;
    const db = b[index] - meanB;
    numerator += da * db;
    sumA += da * da;
    sumB += db * db;
  }
  const denominator = Math.sqrt(sumA * sumB);
  return denominator === 0 ? 0 : numerator / denominator;
}

function parseCsv(text) {
  const lines = text.trim().split("\n");
  const header = lines[0].split(",");
  const index = Object.fromEntries(header.map((name, position) => [name.trim(), position]));
  for (const column of ["timestamp", "close", "volume"]) {
    if (index[column] === undefined) throw new Error(`CSV is missing the ${column} column.`);
  }
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    return {
      timestamp: Date.parse(cells[index.timestamp]),
      close: Number(cells[index.close]),
      volume: Number(cells[index.volume]),
    };
  });
}

// 観察1: |日次リターン| と 出来高 の同時順位相関
// 観察2: 出来高の順位が上位20%の日と下位20%の日で |リターン| の中央値がどれだけ違うか
function analyzeSeries(rows) {
  const absReturn = [];
  const volume = [];
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1].close;
    if (!(previous > 0)) continue;
    absReturn.push(Math.abs(rows[index].close / previous - 1));
    volume.push(rows[index].volume);
  }
  const paired = absReturn.map((value, index) => ({ absReturn: value, volume: volume[index] }))
    .sort((a, b) => a.volume - b.volume);
  const cut = Math.max(1, Math.floor(paired.length * 0.2));
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const low = median(paired.slice(0, cut).map((entry) => entry.absReturn));
  const high = median(paired.slice(-cut).map((entry) => entry.absReturn));
  return {
    observations: absReturn.length,
    spearmanAbsReturnVolume: round(spearman(absReturn, volume)),
    medianAbsReturnLowVolumeQuintile: round(low),
    medianAbsReturnHighVolumeQuintile: round(high),
    highOverLowRatio: round(low === 0 ? null : high / low),
  };
}

const paths = process.argv.slice(2);
if (!paths.length) throw new Error("Pass one or more OHLCV CSV paths.");
const series = {};
for (const path of paths) {
  // ファイル名は結果に入れるが、パスは入れない（再現者は別ディレクトリに置く）。
  series[basename(path).replace(/\.csv$/, "")] = analyzeSeries(parseCsv(await readFile(path, "utf8")));
}
const keys = Object.keys(series).sort();
const output = {
  schema: "alphagraph-observation-v1",
  paper: "ag-e-0001",
  method: "daily |return| vs volume, same-day Spearman rank correlation and volume-quintile split",
  series: Object.fromEntries(keys.map((key) => [key, series[key]])),
  summary: {
    seriesCount: keys.length,
    allPositive: keys.every((key) => series[key].spearmanAbsReturnVolume > 0),
    minSpearman: round(Math.min(...keys.map((key) => series[key].spearmanAbsReturnVolume))),
    maxSpearman: round(Math.max(...keys.map((key) => series[key].spearmanAbsReturnVolume))),
  },
};
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
