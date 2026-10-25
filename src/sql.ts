/**
 * 移行の SQL を 1 文ずつに切る(2026-10-26)。
 *
 * D1 の `exec()` は**改行ごとに 1 文**として流し、失敗した所で止まる(それより前の文は残る)。
 * 複数行にまたがる文(`CREATE INDEX … ON …` の次の行の `WHERE`・`CREATE TRIGGER … BEGIN … END`)が
 * 壊れ、移行が途中まで当たったまま記録されない(Billing 0.0.9 の 0008 で起きた)。
 * そこで文に切って `prepare()` し、`batch()` で 1 つのトランザクションとして送る。
 *
 * 文字列('…')・名前("…"・`…`・[…])と注釈(-- と /* *\/)の中の `;` は区切りにしない。
 * トリガーは本体の中の `;` で切らず、`END;` で閉じる。
 */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  const push = () => {
    const s = cur.trim();
    if (s) out.push(s);
    cur = "";
  };
  while (i < sql.length) {
    const c = sql[i]!;
    const n = sql[i + 1];
    // 文の頭の注釈は落とし、中の注釈は残す(SQLite は書いたとおりの文を控えるので、wrangler で当てた形と揃える)。
    if (c === "-" && n === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end < 0 ? sql.length : end;
      if (cur.trim()) cur += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === "/" && n === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) throw new Error("migration has an unterminated comment");
      if (cur.trim()) cur += sql.slice(i, end + 2);
      i = end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) throw new Error("migration has an unterminated quote");
        if (sql[j] === close) {
          // '' と "" は中の 1 文字(閉じではない)。
          if (close !== "]" && sql[j + 1] === close) { j += 2; continue; }
          break;
        }
        j++;
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === ";") {
      if (/^\s*CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(cur) && !/\bEND\s*$/i.test(cur)) {
        cur += c;
      } else {
        push();
      }
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  push();
  return out;
}

/** `ALTER TABLE t ADD [COLUMN] c …` の表と列。名前の引用は外す。 */
export function addColumnTarget(stmt: string): { table: string; column: string } | null {
  const m = /^ALTER\s+TABLE\s+([`"[]?[\w.]+[`"\]]?)\s+ADD\s+(?:COLUMN\s+)?([`"[]?\w+[`"\]]?)/i.exec(stmt);
  return m ? { table: unquote(m[1]!), column: unquote(m[2]!) } : null;
}

/** `CREATE [UNIQUE] INDEX name …`(IF NOT EXISTS の無いもの)の索引の名前。 */
export function createIndexName(stmt: string): string | null {
  if (/^CREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\b/i.test(stmt)) return null;
  const m = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+([`"[]?\w+[`"\]]?)/i.exec(stmt);
  return m ? unquote(m[1]!) : null;
}

function unquote(s: string): string {
  return s.replace(/^[`"[]|[`"\]]$/g, "");
}
