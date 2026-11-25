#!/usr/bin/env node
/**
 * @summary Builds an Aghanim catalog import file (xlsx) from a fresh catalog export and a JSON spec of new
 *          offers. Every new offer is a copy of an existing bundle or lootbox: the "copy_of" row gives images,
 *          categories, regional price template and card layout; the spec gives sku, name, composition, field
 *          overrides, translations. Rows are appended to Item / NestedItem / Translations; existing rows are
 *          never rewritten and the source file is never touched. The written file is read back and compared
 *          with the spec. After the operator imports it, --check --against compares a fresh export with the
 *          same spec. Zero dependencies: own zip reader/writer and a regex reader for the xlsx parts Aghanim
 *          exports. Discounts are not part of the import format: the spec carries them only to print the
 *          price the operator sets in Aghanim by hand. The catalog comes either from an export named in
 *          the spec ("source") or from the skill's own snapshot ("catalog": catalog/<env>.json, filled
 *          by --learn); in snapshot mode the import file holds only the new rows.
 * @route --catalog <live или sandbox> [--find <id или текст>] — только чтение: что скилл помнит о каталоге без выгрузки — из каких выгрузок, сколько позиций, бандлы с составом; `--find` ищет по id ресурса или названию
 * @route --learn <abs.xlsx> --env <live или sandbox> [--full] — запоминает выгрузку в каталог скилла: позиции всех типов, состав, настройки лутбоксов, переводы, категории, шаблоны цен; `--learn` можно повторить для нескольких файлов; `--full` — эти файлы вместе и есть весь каталог, прежняя память заменяется
 * @route --hub <live или https://адрес> [--shot <abs.png>] — только чтение: открывает страницу хаба в Chrome без входа в аккаунт и печатает, что сейчас на витрине: разделы, офферы, цены, скидки, остатки, условия; снимок страницы кладёт в файл
 * @route --sales <abs.csv> [--from ГГГГ-ММ-ДД] [--to ГГГГ-ММ-ДД] [--top N] — только чтение: аналитика по выгрузке платежей Aghanim: выручка в USD, покупки, покупатели, конверсия оплаты, топ офферов, типы позиций, страны
 * @route --audit <live или https://адрес> [--page <https://страница>] [--expect <abs.spec.json>] — только чтение: проверка настройки хаба глазами гостя — обходит страницы меню и карты сайта, находит страницу программы прогрессии и печатает, что настроено, что нет и что гостем не проверить; `--page` добавляет страницу, которой нет в карте сайта, `--expect` проверяет, что офферы из spec стоят на витрине
 * @route --icons <abs.spec.json> [--repo <abs путь к клиенту>] — находит в репозитории клиента иконки пушек из spec и кладёт их в папку `art/weapons` рядом со spec под именами SKU; загрузка в Aghanim остаётся ручной
 * @route --inspect <abs.xlsx> [--find <id или текст>] — только чтение: листы выгрузки, бандлы и лутбоксы с составом; `--find` ищет предметы каталога по id ресурса или названию
 * @route --plan <abs.spec.json> — только чтение: все проверки и список «что добавится», файл не пишется
 * @route --build <abs.spec.json> — проверки, запись файла импорта (выгрузка и память скилла не меняются), обратное чтение и сверка со spec; для новых пушек из spec кладёт иконки из клиента в `art/weapons` рядом со spec
 * @route --check <abs.spec.json> [--against <abs.xlsx>] — сверка: без `--against` — собранный файл против spec и исходника; с `--against` — свежая выгрузка после импорта против spec
 * @route --describe — описание работы скилла, формы spec и всех отказов (печать)
 * @route --sync-docs — перезаписывает сгенерированное описание и таблицу команд в SKILL.md
 * @route --selftest — самопроверка на синтетическом каталоге (офлайн)
 * @verdict "Done: …" exit 0 | "Rejected: defects_found — …" exit 1 (each defect: what / why / how to fix; nothing is written) |
 *          "Blocked: missing_input — …" exit 2 (bad arguments, unreadable file)
 * @example node <workspace>/.claude/skills/aghanim-offer-building/scripts/build-aghanim-import.mjs --build <workspace>/docs/aghanim-conversion/black-friday-2026/bf-offers-spec.json
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const SKILL_DIR = path.dirname(path.dirname(SELF));
const SKILL_MD = path.join(SKILL_DIR, 'SKILL.md');
const DOC_PATH = path.join(SKILL_DIR, 'references', 'how-it-works.generated.md');
const CMD = 'node <workspace>/.claude/skills/aghanim-offer-building/scripts/build-aghanim-import.mjs';
const OPS_OPEN = '<!-- OPSINDEX:auto из @route build-aghanim-import.mjs -->';
const OPS_CLOSE = '<!-- /OPSINDEX -->';
const CATALOG_DIR = path.join(SKILL_DIR, 'catalog');
const ENVS = ['live', 'sandbox'];
const SNAP_SHEETS = ['Item', 'NestedItem', 'Categories', 'Translations', 'PriceTemplate'];
const KEY_OF = {
  Item: (v) => String(v.sku),
  Categories: (v) => String(v.slug),
  Translations: (v) => `${v.key}|${v.object_type}|${v.object_property}`,
  PriceTemplate: (v) => String(v.price_template_key),
};
const STALE_DAYS = 30;

class Blocked extends Error {}

// Every refusal the script can give: the text that judges is the text the operator reads.
const CHECKS = {
  spec_shape: {
    what: 'spec не той формы',
    why: 'файл собирается только из полей, которые скрипт понимает: лишнее или пропущенное поле означало бы молча потерянную правку',
    fix: 'форма spec — раздел «Форма spec» в `--describe`',
  },
  sheet_missing: {
    what: 'в выгрузке нет нужного листа или колонки',
    why: 'строки добавляются в листы Item, NestedItem и Translations по именам колонок первой строки; без них некуда писать',
    fix: 'выгрузите каталог из Aghanim заново кнопкой экспорта и укажите этот файл в "source"',
  },
  output_path: {
    what: 'нельзя писать по пути "output"',
    why: 'исходная выгрузка не перезаписывается никогда, а чужой файл по этому пути скрипт не затирает',
    fix: 'задайте "output" — абсолютный путь нового .xlsx — или уберите поле: файл ляжет рядом с выгрузкой',
  },
  sku_shape: {
    what: 'SKU не подходит по виду',
    why: 'SKU — ключ товара в Aghanim и в игре: пробел или кириллица в нём ломают выдачу награды',
    fix: 'латиница, цифры, точка, дефис, подчёркивание; начинается с буквы или цифры',
  },
  sku_exists: {
    what: 'такой SKU уже есть в каталоге',
    why: 'импорт Aghanim обновляет товар с совпавшим SKU: новый оффер перезаписал бы существующий',
    fix: 'дайте офферу новый "sku"',
  },
  sku_duplicate_in_spec: {
    what: 'один SKU встречается в spec дважды',
    why: 'вторая строка с тем же SKU перезапишет первую при импорте',
    fix: 'оставьте один оффер на SKU',
  },
  copy_of_missing: {
    what: 'оффера-образца нет в выгрузке',
    why: 'новая строка наследует от образца картинки, категории, цены по странам и оформление карточки; без образца их неоткуда взять',
    fix: 'проверьте "copy_of" по `--inspect`; если выгрузка отфильтрована — выгрузите каталог с образцом',
  },
  component_missing: {
    what: 'предмета из состава нет в выгрузке',
    why: 'бандл ссылается на предметы по SKU: предмета, которого нет в каталоге, игрок не получит',
    fix: 'найдите SKU через `--inspect <xlsx> --find <id>`; если предмета нет — заведите его в Aghanim и выгрузите каталог заново',
  },
  component_ambiguous: {
    what: 'по id ресурса подходит несколько предметов каталога',
    why: 'у одного ресурса в каталоге бывает несколько карточек с разными картинками и названиями; выбор между ними — решение человека',
    fix: 'укажите в "items" точный "sku" вместо "id"',
  },
  component_count: {
    what: 'количество в составе не положительное число',
    why: 'колонка count листа NestedItem — это сколько единиц получит игрок',
    fix: 'задайте "count" числом больше нуля',
  },
  component_repeated: {
    what: 'предмет повторяется в составе одного оффера',
    why: 'две строки одного SKU в одном бандле — почти всегда опечатка, а количество должно стоять в одной строке',
    fix: 'сложите количество в одну строку',
  },
  unknown_field: {
    what: 'в "fields" указана колонка, которой нет на листе Item',
    why: 'значение некуда записать, и правка потерялась бы молча',
    fix: 'имена колонок — первая строка листа Item, их печатает `--inspect`',
  },
  price_template_missing: {
    what: 'шаблона цен нет на листе PriceTemplate',
    why: 'шаблон задаёт цены по странам; ссылка на несуществующий шаблон оставит оффер без региональных цен',
    fix: 'возьмите ключ существующего шаблона (`--inspect`) или заведите шаблон в Aghanim и выгрузите каталог заново',
  },
  price_point_mismatch: {
    what: 'price_point оффера не совпадает с price_point шаблона цен',
    why: 'цена в долларах и цены по странам разойдутся: игроки в разных странах увидят несопоставимые цены',
    fix: 'поставьте "price_point" равным значению шаблона или смените "price_template_key"',
  },
  category_missing: {
    what: 'категории нет на листе Categories',
    why: 'оффер без существующей категории не появится на витрине',
    fix: 'возьмите slug существующей категории или заведите категорию в Aghanim и выгрузите каталог заново',
  },
  translation_required: {
    what: 'текст изменён, а переводы не заданы',
    why: 'строки переводов копируются с образца: на других языках игрок увидел бы старый текст',
    fix: 'добавьте "translations": {"name": {…по всем языкам листа Translations…}} или "drop", чтобы на всех языках показывался английский текст',
  },
  translation_langs: {
    what: 'набор языков перевода не совпадает с листом Translations',
    why: 'пропущенный язык остался бы пустым, лишний — некуда записать',
    fix: 'задайте перевод ровно для языков из шапки листа Translations (их печатает `--inspect`)',
  },
  lootbox_settings_shape: {
    what: 'настройки лутбокса не той формы',
    why: 'шансы считаются из весов групп и предметов; без положительных весов и состава сундук нельзя открыть',
    fix: 'groups — непустой список; у каждой группы weight > 0 и nested_items, у каждого предмета sku, weight > 0, count > 0',
  },
  lootbox_sku_missing: {
    what: 'награды лутбокса нет в выгрузке',
    why: 'лутбокс ссылается на награды по SKU: награду, которой нет в каталоге, игрок не получит',
    fix: 'заведите предмет в Aghanim и выгрузите каталог заново, либо уберите награду из настроек',
  },
  package_invalid: {
    what: 'собранный файл не является корректной книгой xlsx',
    why: 'Aghanim и Excel находят книгу по корневым связям и типам частей пакета: без них файл не загружается, хотя сам скрипт его читает',
    fix: 'пересоберите файл командой `--build`; если отказ повторяется — это дефект сборщика книги, а не spec',
  },
  source_rows_changed: {
    what: 'строки исходной выгрузки в собранном файле изменились',
    why: 'файл импорта обязан только добавлять: изменённая старая строка перезапишет живой товар',
    fix: 'пересоберите файл командой `--build`; руками собранный файл не правят',
  },
  offer_missing: {
    what: 'оффера нет в проверяемом файле',
    why: 'оффер не импортирован или выгрузка отфильтрована',
    fix: 'импортируйте файл и выгрузите каталог целиком',
  },
  readback_item: {
    what: 'строка оффера отличается от spec',
    why: 'то, что лежит в файле, — то, что получит магазин',
    fix: 'для собранного файла — пересоберите `--build`; для свежей выгрузки — поправьте оффер в Aghanim или spec, если правка сделана намеренно',
  },
  readback_nested: {
    what: 'состав оффера отличается от spec',
    why: 'состав в файле — то, что получит игрок',
    fix: 'для собранного файла — пересоберите `--build`; для свежей выгрузки — поправьте состав в Aghanim',
  },
  readback_translation: {
    what: 'перевод отличается от spec',
    why: 'игроки на этом языке увидят другой текст',
    fix: 'для собранного файла — пересоберите `--build`; для свежей выгрузки — поправьте перевод в Aghanim',
  },
};

const defect = (code, subject, detail = '') => {
  if (!CHECKS[code]) throw new Error(`unregistered check ${code}`);
  return { code, subject, detail };
};

// ---------- zip ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** @param {Buffer} buf @returns {number} */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {Buffer} buf @returns {{name:string,data:Buffer}[]} */
function readZip(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Blocked('файл не является xlsx (zip-подпись не найдена)');
  const count = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Blocked('повреждён каталог zip');
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lo = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    const raw = buf.subarray(start, start + csize);
    if (method !== 0 && method !== 8) throw new Blocked(`неподдерживаемое сжатие zip (${method}) в ${name}`);
    const data = method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw);
    if (crc32(data) !== crc) throw new Blocked(`контрольная сумма не сошлась: ${name}`);
    out.push({ name, data });
    p += 46 + nl + el + cl;
  }
  return out;
}

/** @param {{name:string,data:Buffer}[]} entries @returns {Buffer} */
function writeZip(entries) {
  const DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
  const local = [], central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nm = Buffer.from(name, 'utf8'), comp = zlib.deflateRawSync(data), crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(DATE, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(DATE, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28);
    ch.writeUInt32LE(offset, 42);
    local.push(lh, nm, comp);
    central.push(ch, nm);
    offset += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

// ---------- xlsx parts ----------

const decodeXml = (s) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e) => (
  e === 'amp' ? '&' : e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'quot' ? '"' : e === 'apos' ? "'"
    : String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))));
const encodeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;');
const attr = (attrs, name) => { const m = attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`)); return m ? m[1] : null; };
const textOf = (body) => [...body.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).join('');
const tXml = (s) => `<t${/^\s|\s$/.test(s) ? ' xml:space="preserve"' : ''}>${encodeXml(s)}</t>`;
const colNum = (c) => [...c].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const colName = (n) => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

/** @param {string} p @param {string} xml @param {string[]} sst @returns {object} */
function parseSheet(p, xml, sst) {
  const rows = [];
  const body = xml.match(/<sheetData>([\s\S]*?)<\/sheetData>/);
  for (const m of (body ? body[1] : '').matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const cells = new Map();
    for (const c of (m[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(c[1], 'r'), t = attr(c[1], 't'), inner = c[2] || '';
      if (!ref) throw new Blocked(`ячейка без адреса на листе ${p} — такой xlsx не поддерживается`);
      const v = inner.match(/<v[^>]*>([\s\S]*?)<\/v>/);
      let value;
      if (t === 'inlineStr') value = textOf(inner);
      else if (!v) value = undefined;
      else if (t === 's') value = sst[Number(v[1])];
      else if (t === 'b') value = v[1] === '1';
      else if (t === 'str' || t === 'e') value = decodeXml(v[1]);
      else value = Number(v[1]);
      cells.set(ref.replace(/\d+/g, ''), { s: attr(c[1], 's'), value });
    }
    rows.push({ n: Number(attr(m[1], 'r')), xml: m[0], cells });
  }
  const header = new Map();
  if (rows[0]) for (const [col, c] of rows[0].cells) if (typeof c.value === 'string' && c.value !== '') header.set(c.value, col);
  return { path: p, xml, rows, header };
}

const cellv = (sheet, row, name) => { const c = row.cells.get(sheet.header.get(name)); return c == null || c.value == null ? '' : c.value; };
const dataRows = (sheet) => sheet.rows.slice(1).filter((r) => [...r.cells.values()].some((c) => c.value !== undefined && c.value !== ''));

/** @param {string} file @returns {object} */
function loadCatalog(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { throw new Blocked(`файл не читается: ${file}`); }
  return parseWorkbook(buf, file);
}

/** @param {Buffer} buf @param {string} file @returns {object} */
function parseWorkbook(buf, file) {
  const entries = readZip(buf);
  const get = (n) => entries.find((e) => e.name === n);
  const wb = get('xl/workbook.xml'), rel = get('xl/_rels/workbook.xml.rels');
  if (!wb || !rel) throw new Blocked(`в файле нет книги xlsx: ${file}`);
  const rels = {};
  for (const m of rel.data.toString('utf8').matchAll(/<Relationship\b([^>]*?)\/?>/g)) rels[attr(m[1], 'Id')] = attr(m[1], 'Target');
  const sstEntry = get('xl/sharedStrings.xml');
  const sst = sstEntry
    ? [...sstEntry.data.toString('utf8').matchAll(/<si\s*\/>|<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1] || ''))
    : null;
  const sheets = {};
  for (const m of wb.data.toString('utf8').matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const target = rels[attr(m[1], 'r:id')];
    if (!target) continue;
    const p = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    const e = get(p);
    if (e) sheets[decodeXml(attr(m[1], 'name'))] = parseSheet(p, e.data.toString('utf8'), sst || []);
  }
  return { file, entries, sst, sheets };
}

/** @param {string} col @param {number} n @param {string|null} s @param {*} value @param {object} st @returns {string} */
function cellXml(col, n, s, value, st) {
  const head = `<c r="${col}${n}"${s != null ? ` s="${s}"` : ''}`;
  if (value === undefined || value === null) return s != null ? `${head}/>` : '';
  if (typeof value === 'number') return `${head}><v>${value}</v></c>`;
  if (typeof value === 'boolean') return `${head} t="b"><v>${value ? 1 : 0}</v></c>`;
  const str = String(value);
  if (!st.shared) return `${head} t="inlineStr"><is>${tXml(str)}</is></c>`;
  if (!st.index.has(str)) { st.index.set(str, st.base + st.added.length); st.added.push(str); }
  st.refs++;
  return `${head} t="s"><v>${st.index.get(str)}</v></c>`;
}

/** @param {string[]|null} sst @returns {object} */
function stringState(sst) {
  const index = new Map();
  (sst || []).forEach((s, i) => { if (!index.has(s)) index.set(s, i); });
  return { shared: sst !== null, index, base: (sst || []).length, added: [], refs: 0 };
}

// ---------- spec → plan ----------

const SPEC_EXAMPLE = {
  catalog: 'live',
  output: '<home>/Downloads/bf26-import.xlsx',
  offers: [
    {
      sku: 'bf26-dominators-kit',
      name: "Black Friday Dominator's Kit",
      copy_of: 'dominators-kit',
      items: [{ id: '6015', count: 2200 }, { sku: '502015.5', count: 5 }],
      fields: { comment: 'Black Friday 2026' },
      translations: { name: { ru: 'Чёрная пятница: Набор Доминатора', de: '…' }, description: 'drop' },
      store: { discount_pct: 91 },
    },
  ],
};
const OFFER_KEYS = ['sku', 'name', 'copy_of', 'items', 'fields', 'translations', 'store', 'note', 'icon'];
const SPEC_KEYS = ['catalog', 'source', 'output', 'offers', 'note'];
const TR_PROPS = ['name', 'description'];
const TR_KEYS = ['key', 'object_type', 'object_property'];

/** @param {object} spec @returns {object[]} */
function shapeDefects(spec) {
  const D = [];
  const bad = (subject, detail) => D.push(defect('spec_shape', subject, detail));
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) { bad('spec', 'ожидается объект'); return D; }
  for (const k of Object.keys(spec)) if (!SPEC_KEYS.includes(k)) bad(k, `неизвестное поле; допустимы: ${SPEC_KEYS.join(', ')}`);
  if ((spec.source === undefined) === (spec.catalog === undefined)) bad('catalog / source', `нужно ровно одно: "catalog" (${ENVS.join(' или ')}) — каталог из памяти скилла, либо "source" — путь к выгрузке`);
  else if (spec.catalog !== undefined && !ENVS.includes(spec.catalog)) bad('catalog', `допустимы: ${ENVS.join(', ')}`);
  else if (spec.source !== undefined && (typeof spec.source !== 'string' || !path.isAbsolute(spec.source))) bad('source', 'абсолютный путь к выгрузке каталога');
  if (spec.catalog !== undefined ? typeof spec.output !== 'string' : spec.output !== undefined && typeof spec.output !== 'string') bad('output', 'строка — абсолютный путь файла импорта');
  if (!Array.isArray(spec.offers) || !spec.offers.length) { bad('offers', 'непустой список офферов'); return D; }
  spec.offers.forEach((o, i) => {
    const tag = o && typeof o.sku === 'string' ? o.sku : `offers[${i}]`;
    if (!o || typeof o !== 'object') { bad(tag, 'ожидается объект'); return; }
    for (const k of Object.keys(o)) if (!OFFER_KEYS.includes(k)) bad(tag, `неизвестное поле "${k}"; допустимы: ${OFFER_KEYS.join(', ')}`);
    if (typeof o.sku !== 'string') bad(tag, '"sku" — строка');
    else if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(o.sku)) D.push(defect('sku_shape', o.sku));
    if (typeof o.name !== 'string' || !o.name.trim()) bad(tag, '"name" — непустая строка');
    if (typeof o.copy_of !== 'string' || !o.copy_of) bad(tag, '"copy_of" — SKU оффера-образца из выгрузки');
    if (o.items !== undefined) {
      if (!Array.isArray(o.items) || !o.items.length) bad(tag, '"items" — непустой список строк состава');
      else for (const it of o.items) {
        if (!it || typeof it !== 'object' || (typeof it.sku !== 'string' && it.id === undefined)) bad(tag, 'строка состава — {"sku": "…", "count": N} или {"id": "…", "count": N}');
      }
    }
    if (o.fields !== undefined) {
      if (!o.fields || typeof o.fields !== 'object' || Array.isArray(o.fields)) bad(tag, '"fields" — объект «колонка листа Item: значение»');
      else for (const k of ['sku', 'name']) if (k in o.fields) bad(tag, `"${k}" задаётся на верхнем уровне оффера, не в "fields"`);
    }
    if (o.translations !== undefined) {
      if (!o.translations || typeof o.translations !== 'object' || Array.isArray(o.translations)) bad(tag, '"translations" — объект с ключами name / description');
      else for (const [k, v] of Object.entries(o.translations)) {
        if (!TR_PROPS.includes(k)) bad(tag, `"translations.${k}": допустимы ${TR_PROPS.join(', ')}`);
        else if (v !== 'drop' && (!v || typeof v !== 'object' || Array.isArray(v))) bad(tag, `"translations.${k}" — объект «язык: текст» или "drop"`);
      }
    }
    if (o.icon !== undefined && (typeof o.icon !== 'string' || !o.icon.trim() || /[\\/]/.test(o.icon))) bad(tag, '"icon" — тег пушки, как в имени файла её иконки в клиенте');
    if (o.store !== undefined) {
      const d = o.store && o.store.discount_pct;
      if (!o.store || typeof o.store !== 'object' || Object.keys(o.store).some((k) => k !== 'discount_pct') || !(typeof d === 'number' && d >= 0 && d < 100)) {
        bad(tag, '"store" — {"discount_pct": число от 0 до 100}');
      }
    }
  });
  return D;
}

const defaultOutput = (source) => `${source.replace(/\.xlsx$/i, '')} + import.xlsx`;

/** @param {object} cat @param {object} spec @returns {{defects:object[],offers:object[],output:string}} */
function resolvePlan(cat, spec) {
  const D = shapeDefects(spec);
  const output = spec && typeof spec.output === 'string' ? spec.output : spec && typeof spec.source === 'string' ? defaultOutput(spec.source) : '';
  if (D.length) return { defects: D, offers: [], output };
  if (!path.isAbsolute(output) || !/\.xlsx$/i.test(output) || (spec.source && path.resolve(output) === path.resolve(spec.source))) D.push(defect('output_path', output));
  const item = cat.sheets.Item, nested = cat.sheets.NestedItem, tr = cat.sheets.Translations;
  const pt = cat.sheets.PriceTemplate, cats = cat.sheets.Categories;
  if (!item || !['sku', 'name'].every((h) => item.header.has(h))) { D.push(defect('sheet_missing', 'Item', 'нужны колонки sku и name')); return { defects: D, offers: [], output }; }
  if (nested && !['sku', 'count', 'parent_sku'].every((h) => nested.header.has(h))) D.push(defect('sheet_missing', 'NestedItem', 'нужны колонки sku, count, parent_sku'));
  if (tr && !TR_KEYS.every((h) => tr.header.has(h))) D.push(defect('sheet_missing', 'Translations', `нужны колонки ${TR_KEYS.join(', ')}`));
  if (D.length) return { defects: D, offers: [], output };

  const bySku = new Map(dataRows(item).map((r) => [String(cellv(item, r, 'sku')), r]));
  const langs = tr ? [...tr.header.keys()].filter((h) => !TR_KEYS.includes(h)) : [];
  const fresh = new Map(spec.offers.map((x) => [x.sku, x.name]));
  const known = (s) => bySku.has(s) || fresh.has(s);
  const nameOf = (s) => (bySku.has(s) ? String(cellv(item, bySku.get(s), 'name')) : fresh.get(s));
  const seen = new Set(), offers = [];
  for (const o of spec.offers) {
    const before = D.length;
    if (bySku.has(o.sku)) D.push(defect('sku_exists', o.sku));
    if (seen.has(o.sku)) D.push(defect('sku_duplicate_in_spec', o.sku));
    seen.add(o.sku);
    const tpl = bySku.get(o.copy_of);
    if (!tpl) { D.push(defect('copy_of_missing', o.sku, `"copy_of": ${o.copy_of}`)); continue; }
    const orig = new Map([...item.header.keys()].map((h) => [h, cellv(item, tpl, h)]));
    const overrides = { sku: o.sku, name: o.name };
    for (const [k, v] of Object.entries(o.fields || {})) {
      if (!item.header.has(k)) D.push(defect('unknown_field', o.sku, `"${k}"; колонки листа Item: ${[...item.header.keys()].join(', ')}`));
      else overrides[k] = v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : v;
    }
    const values = new Map([...orig, ...Object.entries(overrides)]);

    if (pt && ['price', 'price_point', 'price_template_key'].some((k) => k in (o.fields || {})) && values.get('price_template_key') !== '') {
      const row = dataRows(pt).find((r) => cellv(pt, r, 'price_template_key') === values.get('price_template_key'));
      if (!row) D.push(defect('price_template_missing', o.sku, String(values.get('price_template_key'))));
      else if (pt.header.has('price_point') && Number(cellv(pt, row, 'price_point')) !== Number(values.get('price_point'))) {
        D.push(defect('price_point_mismatch', o.sku, `оффер ${values.get('price_point')}, шаблон ${values.get('price_template_key')} — ${cellv(pt, row, 'price_point')}`));
      }
    }
    if (cats && cats.header.has('slug') && 'categories' in (o.fields || {})) {
      for (const slug of String(values.get('categories')).split(',').map((s) => s.trim()).filter(Boolean)) {
        if (!dataRows(cats).some((r) => cellv(cats, r, 'slug') === slug)) D.push(defect('category_missing', o.sku, slug));
      }
    }

    const extraOf = (r) => Object.fromEntries([...nested.header.keys()].filter((h) => !['sku', 'count', 'parent_sku'].includes(h)).map((h) => [h, cellv(nested, r, h)]).filter(([, v]) => v !== ''));
    const origNested = nested
      ? dataRows(nested).filter((r) => String(cellv(nested, r, 'parent_sku')) === o.copy_of).map((r) => ({ sku: String(cellv(nested, r, 'sku')), count: Number(cellv(nested, r, 'count')), extra: extraOf(r) }))
      : [];
    let comp = origNested;
    if (o.items) {
      comp = [];
      if (!nested) D.push(defect('sheet_missing', 'NestedItem', 'состав задан, а листа в выгрузке нет'));
      for (const it of o.items) {
        const label = it.sku ?? `id ${it.id}`;
        if (!(typeof it.count === 'number' && Number.isFinite(it.count) && it.count > 0)) { D.push(defect('component_count', o.sku, `${label}: ${JSON.stringify(it.count)}`)); continue; }
        let sku = it.sku;
        if (typeof sku !== 'string') {
          const id = String(it.id), hit = (s) => s === id || s.startsWith(`${id}.`);
          const inOrig = [...new Set(origNested.map((c) => c.sku).filter(hit))], inCat = [...new Set([...bySku.keys(), ...fresh.keys()])].filter((s) => s !== o.sku && hit(s));
          if (inOrig.length === 1) sku = inOrig[0];
          else if (!inOrig.length && inCat.length === 1) sku = inCat[0];
          else if (!inCat.length) { D.push(defect('component_missing', o.sku, label)); continue; }
          else {
            const cand = (inOrig.length ? inOrig : inCat).map((s) => `${s} «${nameOf(s)}»`).join('; ');
            D.push(defect('component_ambiguous', o.sku, `${label}: ${cand}`));
            continue;
          }
        } else if (!known(sku) || sku === o.sku) { D.push(defect('component_missing', o.sku, sku)); continue; }
        if (comp.some((c) => c.sku === sku)) { D.push(defect('component_repeated', o.sku, sku)); continue; }
        comp.push({ sku, count: it.count, extra: (origNested.find((c) => c.sku === sku) || { extra: {} }).extra });
      }
    }

    const trRows = [];
    if (!tr && o.translations) D.push(defect('sheet_missing', 'Translations', 'переводы заданы, а листа в выгрузке нет'));
    if (tr) {
      const rowObj = (r) => Object.fromEntries([...tr.header.keys()].map((h) => [h, cellv(tr, r, h)]));
      const origRows = dataRows(tr).filter((r) => String(cellv(tr, r, 'key')) === o.copy_of && cellv(tr, r, 'object_type') === 'Item');
      for (const r of origRows) {
        const prop = cellv(tr, r, 'object_property'), given = o.translations && o.translations[prop];
        if (given !== undefined) continue;
        if (TR_PROPS.includes(prop) && values.get(prop) !== orig.get(prop)) D.push(defect('translation_required', o.sku, `${prop}: «${orig.get(prop)}» → «${values.get(prop)}»`));
        else trRows.push({ prop, mode: 'copied', template: r, values: { ...rowObj(r), key: o.sku } });
      }
      for (const [prop, given] of Object.entries(o.translations || {})) {
        if (given === 'drop' || given === undefined) continue;
        const miss = langs.filter((l) => typeof given[l] !== 'string' || !given[l]), extra = Object.keys(given).filter((l) => !langs.includes(l));
        if (miss.length || extra.length) { D.push(defect('translation_langs', o.sku, `${prop}: ${miss.length ? `нет ${miss.join(', ')}` : ''}${miss.length && extra.length ? '; ' : ''}${extra.length ? `лишние ${extra.join(', ')}` : ''}`)); continue; }
        const src = origRows.find((r) => cellv(tr, r, 'object_property') === prop);
        trRows.push({ prop, mode: 'given', template: src || dataRows(tr)[0] || null, values: { ...(src ? rowObj(src) : {}), key: o.sku, object_type: 'Item', object_property: prop, ...given } });
      }
    }

    let lootbox = null, lootboxKept = [];
    if (values.get('type') === 'lootbox' && item.header.has('lootbox_settings')) {
      try { lootbox = JSON.parse(String(values.get('lootbox_settings'))); } catch { lootbox = null; }
      if (lootbox && o.fields && o.fields.lootbox_settings !== undefined) lootboxKept = keepSampleSettings(lootbox, String(orig.get('lootbox_settings')));
      const groups = lootbox && Array.isArray(lootbox.groups) ? lootbox.groups : [];
      const okGroup = (g) => g && g.weight > 0 && Array.isArray(g.nested_items) && g.nested_items.length && g.nested_items.every((n) => n && typeof n.sku === 'string' && n.weight > 0 && n.count > 0);
      const pity = lootbox && lootbox.pity && Array.isArray(lootbox.pity.steps) ? lootbox.pity.steps.flatMap((s) => s.guaranteed_groups || []) : [];
      if (!groups.length || ![...groups, ...pity].every(okGroup)) { D.push(defect('lootbox_settings_shape', o.sku)); lootbox = null; } else {
        // a copy must not share group ids with its template
        [...groups, ...pity].forEach((g, i) => { g.id = groupId(o.sku, i); });
        for (const g of [...groups, ...pity]) for (const n of g.nested_items) if (!known(n.sku)) D.push(defect('lootbox_sku_missing', o.sku, n.sku));
        overrides.lootbox_settings = JSON.stringify(lootbox);
        values.set('lootbox_settings', overrides.lootbox_settings);
      }
    }

    if (D.length === before) {
      offers.push({ sku: o.sku, name: o.name, copy_of: o.copy_of, template: tpl, overrides, values, orig, given: Object.keys(o.fields || {}), nested: comp, origNested, itemsGiven: !!o.items, tr: trRows, trDropped: Object.entries(o.translations || {}).filter(([, v]) => v === 'drop').map(([k]) => k), lootbox, lootboxKept, store: o.store || null });
    }
  }
  return { defects: D, offers, output, names: new Map([...fresh, ...[...bySku].map(([s, r]) => [s, String(cellv(item, r, 'name'))])]), twins: twinMap(item) };
}

/** @param {string} sku @param {number} i @returns {string} */
function groupId(sku, i) {
  const h = crypto.createHash('sha1').update(`${sku}#${i}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[parseInt(h[16], 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** @param {object} given @param {string} sampleText @returns {string[]} */
function keepSampleSettings(given, sampleText) {
  let sample;
  try { sample = JSON.parse(sampleText); } catch { return []; }
  const kept = Object.keys(sample || {}).filter((k) => !['groups', 'pity'].includes(k) && given[k] === undefined);
  for (const k of kept) given[k] = sample[k];
  return kept;
}

/** @param {{name:string,data:Buffer}[]} entries @returns {string[]} */
function packageDefects(entries) {
  const text = (n) => { const e = entries.find((x) => x.name === n); return e ? e.data.toString('utf8') : ''; };
  const types = text('[Content_Types].xml'), root = text('_rels/.rels');
  const miss = [];
  if (!/Target="\/?xl\/workbook\.xml"/.test(root)) miss.push('нет корневой связи _rels/.rels с xl/workbook.xml');
  if (!types.includes('spreadsheetml.sheet.main+xml')) miss.push('[Content_Types].xml не объявляет тип книги');
  for (const e of entries) if (/^xl\/worksheets\/sheet\d+\.xml$/.test(e.name) && !types.includes(`PartName="/${e.name}"`)) miss.push(`[Content_Types].xml не объявляет лист ${e.name}`);
  return miss;
}

// ---------- catalog snapshot ----------

/** @param {string} env @param {string} dir @returns {object|null} */
function readSnapshot(env, dir) {
  const file = path.join(dir, `${env}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

const writeSnapshot = (snap, dir) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${snap.env}.json`), `${JSON.stringify(snap, null, 1)}\n`);
};
const stampOf = (date) => date.toISOString().slice(0, 16);
const recordsOf = (slot) => Object.values(slot.rows).flatMap((r) => (Array.isArray(r.v) ? r.v : [r.v]));
const typeCounts = (snap) => {
  const n = {};
  for (const v of recordsOf(snap.sheets.Item)) n[v.type || '—'] = (n[v.type || '—'] || 0) + 1;
  return Object.entries(n).sort((a, b) => b[1] - a[1]).map(([t, c]) => `${t} ${c}`).join(' · ');
};

/** @param {object} snap @param {string[]} names @returns {object} */
function snapshotSheets(snap, names) {
  return Object.fromEntries(names.filter((n) => snap.sheets[n]).map((n) => {
    const slot = snap.sheets[n];
    return [n, [slot.header, ...recordsOf(slot).map((v) => slot.header.map((h) => v[h] ?? ''))]];
  }));
}

/** @param {object} cat @param {object} snap @param {string} seen @param {string|null} added @param {Set<string>|null} only */
function absorb(cat, snap, seen, added, only) {
  for (const name of SNAP_SHEETS) {
    const sh = cat.sheets[name];
    if (!sh || !sh.header.size) continue;
    const header = [...sh.header.keys()];
    const slot = snap.sheets[name] || (snap.sheets[name] = { header: [], rows: {} });
    slot.header = [...slot.header, ...header.filter((h) => !slot.header.includes(h))];
    const wanted = (key) => !only || only.has(name === 'Translations' ? key.split('|')[0] : key);
    const put = (key, v) => {
      if (wanted(key) && (!slot.rows[key] || slot.rows[key].seen <= seen)) slot.rows[key] = added ? { seen, added, v } : { seen, v };
    };
    const recs = dataRows(sh).map((r) => Object.fromEntries(header.map((h) => [h, cellv(sh, r, h)]).filter(([, v]) => v !== '')));
    if (name !== 'NestedItem') { for (const v of recs) put(KEY_OF[name](v), v); continue; }
    const groups = new Map();
    for (const v of recs) { const k = String(v.parent_sku); groups.set(k, [...(groups.get(k) || []), v]); }
    for (const r of dataRows(cat.sheets.Item)) {
      const k = String(cellv(cat.sheets.Item, r, 'sku'));
      if (!groups.has(k) && wanted(k) && slot.rows[k] && slot.rows[k].seen <= seen) delete slot.rows[k];
    }
    for (const [k, v] of groups) put(k, v);
  }
}

/** @param {string[]} files @param {string} env @param {boolean} full @param {string} dir @returns {{ok:boolean,text:string}} */
function learnExports(files, env, full, dir = CATALOG_DIR) {
  const cats = files.map((f) => ({ f, cat: loadCatalog(f) }));
  const bad = cats.filter(({ cat }) => !cat.sheets.Item || !cat.sheets.Item.header.has('sku'));
  if (bad.length) return { ok: false, text: refusal(bad.map(({ f }) => defect('sheet_missing', path.basename(f), 'нет листа Item с колонкой sku')), 'каталог не изменён') };
  const snap = (!full && readSnapshot(env, dir)) || { env, sources: [], sheets: {} };
  const lines = [];
  for (const { f, cat } of cats) {
    const exported = stampOf(fs.statSync(f).mtime), base = path.basename(f), items = dataRows(cat.sheets.Item).length;
    absorb(cat, snap, exported, null, null);
    snap.sources = [...snap.sources.filter((s) => !(s.file === base && s.exported === exported)), { file: base, exported, full: !!full, items }];
    lines.push(`  ${base} от ${exported.slice(0, 10)}: позиций ${items}`);
  }
  snap.sources.sort((a, b) => a.exported.localeCompare(b.exported));
  writeSnapshot(snap, dir);
  const how = full ? ' как весь каталог (прежняя память заменена)' : '';
  return { ok: true, text: `${lines.join('\n')}\nDone: каталог ${env} — запомнено выгрузок ${files.length}${how}; всего позиций ${Object.keys(snap.sheets.Item.rows).length}: ${typeCounts(snap)}` };
}

/** @param {object} spec @param {string} dir @param {string|null} specId @returns {{cat:object,snap:object|null,mine:Set<string>}} */
function openSource(spec, dir, specId) {
  if (spec.source) return { cat: loadCatalog(spec.source), snap: null, mine: new Set() };
  const snap = readSnapshot(spec.catalog, dir);
  if (!snap) throw new Blocked(`каталог «${spec.catalog}» пуст: скилл ещё не видел ни одной выгрузки этого окружения — дайте выгрузку один раз: --learn <abs.xlsx> --env ${spec.catalog}`);
  const mine = new Set();
  for (const [name, slot] of Object.entries(snap.sheets)) {
    for (const [k, r] of Object.entries(slot.rows)) {
      if (!specId || r.added !== specId) continue;
      if (name === 'Item') mine.add(k);
      delete slot.rows[k];
    }
  }
  return { cat: parseWorkbook(workbookBuffer(true, snapshotSheets(snap, SNAP_SHEETS)), `каталог ${spec.catalog}`), snap, mine };
}

/** @param {object} cat @param {object|null} snap @param {object} plan @returns {object} */
function baseFor(cat, snap, plan) {
  if (!snap) return cat;
  const used = (name, keep, rows) => [...cat.sheets[name].header.keys()].filter((h) => keep.includes(h) || rows.some((v) => v[h] !== undefined && v[h] !== ''));
  const out = { Item: [used('Item', ['sku', 'name'], plan.offers.map((o) => Object.fromEntries(o.values)))] };
  const nested = plan.offers.flatMap((o) => o.nested.map((c) => c.extra));
  if (nested.length) out.NestedItem = [used('NestedItem', ['sku', 'count', 'parent_sku'], nested)];
  if (plan.offers.some((o) => o.tr.length)) out.Translations = [[...cat.sheets.Translations.header.keys()]];
  return parseWorkbook(workbookBuffer(true, out), 'import');
}

/** @param {object} snap @param {string} dir @param {string} file @param {object} plan @param {string} specId */
function rememberAdditions(snap, dir, file, plan, specId) {
  absorb(loadCatalog(file), snap, stampOf(new Date()), specId, new Set(plan.offers.map((o) => o.sku)));
  writeSnapshot(snap, dir);
}

/** @param {object} item @returns {Map<string,string>} */
function twinMap(item) {
  const rows = dataRows(item).map((r) => ({ sku: String(cellv(item, r, 'sku')), name: cellv(item, r, 'name'), q: cellv(item, r, 'quantity') })).filter((x) => /^\d+\.\d+$/.test(x.sku));
  const out = new Map();
  for (const a of rows) {
    const b = rows.find((x) => x.sku !== a.sku && x.sku.startsWith(a.sku) && /^0+$/.test(x.sku.slice(a.sku.length)) && x.name === a.name && x.q === a.q);
    if (b) out.set(a.sku, b.sku);
  }
  return out;
}

// ---------- plan → file ----------

/** @param {object} base @param {object} plan @param {object} cat @returns {Buffer} */
function applyPlan(base, plan, cat) {
  const st = stringState(base.sst);
  const added = new Map(), last = new Map();
  const add = (name, template, valuesByHeader, keepTemplateValues) => {
    const sh = base.sheets[name], headerOf = new Map([...cat.sheets[name].header].map(([h, col]) => [col, h]));
    const n = (last.get(name) ?? sh.rows[sh.rows.length - 1].n) + 1;
    last.set(name, n);
    const cols = new Map();
    if (template) for (const [col, c] of template.cells) {
      const to = sh.header.get(headerOf.get(col));
      if (to) cols.set(to, { s: c.s, value: keepTemplateValues ? c.value : undefined });
    }
    for (const [h, v] of Object.entries(valuesByHeader)) {
      const col = sh.header.get(h);
      if (col) cols.set(col, { s: cols.get(col)?.s ?? null, value: v });
    }
    const cells = [...cols].sort((a, b) => colNum(a[0]) - colNum(b[0])).map(([col, c]) => cellXml(col, n, c.s, c.value, st)).join('');
    if (!added.has(name)) added.set(name, []);
    added.get(name).push(`<row r="${n}">${cells}</row>`);
  };
  for (const o of plan.offers) add('Item', o.template, o.overrides, true);
  for (const o of plan.offers) {
    for (const c of o.nested) {
      const from = cat.sheets.NestedItem;
      const twin = dataRows(from).find((r) => String(cellv(from, r, 'sku')) === c.sku);
      add('NestedItem', twin || dataRows(from)[0] || null, { ...c.extra, sku: c.sku, count: c.count, parent_sku: o.sku }, false);
    }
  }
  for (const o of plan.offers) for (const t of o.tr) add('Translations', t.template, t.values, false);

  const patched = new Map();
  for (const [name, rows] of added) {
    const sh = base.sheets[name];
    let xml = sh.xml.replace('</sheetData>', () => `${rows.join('')}</sheetData>`);
    xml = xml.replace(/(<dimension ref="[A-Z]+\d+:[A-Z]+)\d+"/, (_, a) => `${a}${last.get(name)}"`);
    patched.set(sh.path, Buffer.from(xml, 'utf8'));
  }
  if (st.shared && st.added.length) {
    const e = base.entries.find((x) => x.name === 'xl/sharedStrings.xml');
    const extra = st.added.map((s) => `<si>${tXml(s)}</si>`).join('');
    let xml = e.data.toString('utf8');
    xml = xml.includes('</sst>') ? xml.replace('</sst>', () => `${extra}</sst>`) : xml.replace(/<sst\b([^>]*?)\/>/, (_, a) => `<sst${a}>${extra}</sst>`);
    xml = xml.replace(/(<sst\b[^>]*?\buniqueCount=")\d+"/, (_, a) => `${a}${st.base + st.added.length}"`);
    xml = xml.replace(/(<sst\b[^>]*?\scount=")(\d+)"/, (_, a, n) => `${a}${Number(n) + st.refs}"`);
    patched.set(e.name, Buffer.from(xml, 'utf8'));
  }
  return writeZip(base.entries.map((e) => ({ name: e.name, data: patched.get(e.name) || e.data })));
}

// ---------- file ↔ plan ----------

const same = (a, b) => {
  const n = (v) => (v === true ? 1 : v === false ? 0 : v == null ? '' : v);
  a = n(a); b = n(b);
  if (a === b) return true;
  if (a !== '' && b !== '' && !Number.isNaN(Number(a)) && !Number.isNaN(Number(b))) return Number(a) === Number(b);
  return String(a) === String(b);
};
const lootboxView = (text) => {
  try {
    return JSON.stringify((JSON.parse(String(text)).groups || []).map((g) => ({
      name: g.name, weight: g.weight, items: g.nested_items.map((n) => [n.sku, n.count, n.weight]).sort(),
    })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  } catch { return `unparsed:${text}`; }
};
const slugSet = (v) => String(v).split(',').map((s) => s.trim()).filter(Boolean).sort().join();
const AGAINST_FIELDS = ['name', 'description', 'type', 'price', 'price_point', 'price_template_key', 'quantity', 'categories', 'lootbox_settings'];

/** @param {object} target @param {object} plan @param {object|null} source @returns {object[]} */
function verify(target, plan, source) {
  const D = [];
  if (source) {
    for (const m of packageDefects(target.entries)) D.push(defect('package_invalid', path.basename(String(target.file)), m));
    for (const [name, sh] of Object.entries(source.sheets)) {
      const t = target.sheets[name];
      if (!t || sh.rows.some((r, i) => !t.rows[i] || t.rows[i].xml !== r.xml)) D.push(defect('source_rows_changed', name));
    }
  }
  const item = target.sheets.Item, nested = target.sheets.NestedItem, tr = target.sheets.Translations;
  if (!item || !item.header.has('sku')) { D.push(defect('sheet_missing', 'Item')); return D; }
  for (const o of plan.offers) {
    const row = dataRows(item).find((r) => String(cellv(item, r, 'sku')) === o.sku);
    if (!row) { D.push(defect('offer_missing', o.sku)); continue; }
    for (const [h, want] of o.values) {
      if (!item.header.has(h) || (!source && !AGAINST_FIELDS.includes(h))) continue;
      const got = cellv(item, row, h);
      const ok = !source && h === 'categories' ? slugSet(got) === slugSet(want)
        : !source && h === 'lootbox_settings' && want !== '' ? lootboxView(got) === lootboxView(want)
          : same(got, want);
      if (!ok) D.push(defect('readback_item', o.sku, `${h}: в файле «${got}», в spec «${want}»`));
    }
    const got = nested ? dataRows(nested).filter((r) => String(cellv(nested, r, 'parent_sku')) === o.sku).map((r) => `${cellv(nested, r, 'sku')} ×${Number(cellv(nested, r, 'count'))}`) : [];
    const want = o.nested.map((c) => `${c.sku} ×${c.count}`);
    const line = (list) => (source ? list : [...list].sort()).join('; ');
    if (line(got) !== line(want)) D.push(defect('readback_nested', o.sku, `в файле [${got.join('; ')}], в spec [${want.join('; ')}]`));
    for (const t of o.tr) {
      const r = tr && dataRows(tr).find((x) => String(cellv(tr, x, 'key')) === o.sku && cellv(tr, x, 'object_property') === t.prop);
      if (!r) { D.push(defect('readback_translation', o.sku, `${t.prop}: строки нет`)); continue; }
      for (const [h, v] of Object.entries(t.values)) {
        if (TR_KEYS.includes(h) || !tr.header.has(h)) continue;
        if (!same(cellv(tr, r, h), v)) D.push(defect('readback_translation', o.sku, `${t.prop}/${h}: в файле «${cellv(tr, r, h)}», в spec «${v}»`));
      }
    }
    if (source && tr) for (const prop of o.trDropped) {
      if (dataRows(tr).some((x) => String(cellv(tr, x, 'key')) === o.sku && cellv(tr, x, 'object_property') === prop)) D.push(defect('readback_translation', o.sku, `${prop}: строка есть, а в spec "drop"`));
    }
  }
  return D;
}

// ---------- reports ----------

const money = (cents, cur) => `${(Number(cents) / 100).toFixed(2)}${cur ? ` ${cur}` : ''}`;

/** @param {object} plan @returns {string} */
function planReport(plan, snap) {
  const out = [];
  const seen = (sku) => (snap && snap.sheets.Item.rows[sku] ? snap.sheets.Item.rows[sku].seen : null);
  const old = (sku) => seen(sku) && Date.now() - Date.parse(`${seen(sku)}:00Z`) > STALE_DAYS * 864e5;
  if (snap) {
    const last = snap.sources[snap.sources.length - 1];
    out.push(`каталог ${snap.env}: позиций ${Object.keys(snap.sheets.Item.rows).length}, последняя выгрузка ${last.exported.slice(0, 10)} (${last.file})`);
  }
  for (const o of plan.offers) {
    const v = (h) => (o.values.has(h) ? o.values.get(h) : '');
    out.push(`+ ${o.sku} «${o.name}» — образец ${o.copy_of} «${o.orig.get('name')}», тип ${v('type') || '—'}`);
    out.push(`    цена каталога ${money(v('price'), v('currency'))} · шаблон цен ${v('price_template_key') || '—'} · категории ${v('categories') || '—'}`);
    if (o.store) out.push(`    скидка ${o.store.discount_pct}% → игроку ${money(Number(v('price')) * (1 - o.store.discount_pct / 100), v('currency'))} — выставляется в Aghanim вручную, в файле импорта скидки нет`);
    if (o.given.length) out.push(`    изменённые поля: ${o.given.join(', ')}`);
    if (o.nested.length) {
      const was = new Map(o.origNested.map((c) => [c.sku, c.count]));
      out.push(`    состав${o.itemsGiven ? '' : ' (как у образца)'}: ${o.nested.map((c) => `${plan.names.get(c.sku)} ×${c.count} (${c.sku}${!was.has(c.sku) ? ', новый в составе' : was.get(c.sku) !== c.count ? `, было ${was.get(c.sku)}` : ''})`).join(' · ')}`);
      const gone = o.origNested.filter((c) => !o.nested.some((x) => x.sku === c.sku));
      if (gone.length) out.push(`    убрано из состава образца: ${gone.map((c) => `${plan.names.get(c.sku)} ×${c.count} (${c.sku})`).join(' · ')}`);
    }
    if (o.lootbox) {
      const total = o.lootbox.groups.reduce((s, g) => s + g.weight, 0);
      for (const g of o.lootbox.groups) {
        const inner = g.nested_items.reduce((s, n) => s + n.weight, 0);
        out.push(`    группа «${g.name || '—'}» ${(100 * g.weight / total).toFixed(2)}%: ${g.nested_items.map((n) => `${plan.names.get(n.sku)} ×${n.count} — ${(100 * g.weight / total * n.weight / inner).toFixed(2)}%`).join(' · ')}`);
      }
      if (o.lootbox.pity) out.push(`    гарантия (как записано): ${JSON.stringify(o.lootbox.pity)}`);
      const steps = o.lootbox.price_step_up && Array.isArray(o.lootbox.price_step_up.steps) ? o.lootbox.price_step_up.steps : [];
      if (steps.length) out.push(`    цена открытия по шагам: ${steps.map((s) => `${s.prices.default.amount} ${s.prices.default.virtual_currency_sku || s.prices.default.type}`).join(' · ')}`);
      if (o.lootboxKept.length) out.push(`    с образца сохранены настройки: ${o.lootboxKept.join(', ')}`);
      out.push('    группам лутбокса выданы собственные идентификаторы, чтобы копия не делила их с образцом');
      out.push('    внимание: импорт Aghanim пропускает строки типа lootbox — из файла встанут только предметы-награды, а сам сундук заводят в дашборде вручную по настройкам выше');
    }
    const trLine = [...o.tr.map((t) => `${t.prop} — ${t.mode === 'given' ? 'заданы в spec' : 'скопированы с образца'}`), ...o.trDropped.map((p) => `${p} — без перевода (английский текст)`)];
    if (trLine.length) out.push(`    переводы: ${trLine.join(' · ')}`);
    const cut = o.nested.filter((c) => plan.twins.has(c.sku)).map((c) => `${c.sku} (полный ${plan.twins.get(c.sku)})`);
    if (cut.length) out.push(`    внимание: в составе SKU с обрезанными нулями — ${cut.join(', ')}; в Aghanim это отдельные позиции-двойники, так сейчас настроен образец`);
    const stale = [...new Set([o.copy_of, ...o.nested.map((c) => c.sku)])].filter(old);
    if (stale.length) out.push(`    внимание: эти позиции скилл видел только в выгрузках старше ${STALE_DAYS} дней — ${stale.map((s) => `${s} (${seen(s).slice(0, 10)})`).join(', ')}; если их меняли в Aghanim, нужна свежая выгрузка`);
  }
  return out.join('\n');
}

/** @param {object[]} defects @param {string} head @returns {string} */
function refusal(defects, head = 'файл не записан') {
  const lines = [`Rejected: defects_found — отказов: ${defects.length}, ${head}`];
  defects.forEach((d, i) => {
    const c = CHECKS[d.code];
    lines.push(`  ${i + 1}. [${d.code}] ${d.subject}: ${c.what}${d.detail ? ` — ${d.detail}` : ''}`, `     почему: ${c.why}`, `     как исправить: ${c.fix}`);
  });
  return lines.join('\n');
}

const routes = () => [...fs.readFileSync(SELF, 'utf8').matchAll(/^ \* @route (.+?) — (.+)$/gm)].map((m) => ({ args: m[1], does: m[2] }));
const opsIndex = () => ['| команда | что делает |', '|---|---|', ...routes().map((r) => `| \`${r.args}\` | ${r.does} |`)].join('\n');

/** @returns {string} */
function describe() {
  return `# Как работает скилл aghanim-offer-building

Файл сгенерирован командой \`--sync-docs\` из самого скрипта. Правится скрипт, не этот файл.

## Что он делает

Главное умение: скилл помнит весь стор, настроенный в Aghanim, и создаёт новые позиции по подобию существующих. Новая позиция любого типа — предмет, валюта, бандл или лутбокс — это копия уже настроенной: от образца она наследует картинки, категории, цены по странам и оформление карточки, а своё у неё — SKU, название, количество, состав, изменённые поля и переводы. В одном описании можно завести сразу предмет, бандл с этим предметом и лутбокс с ним же.

Каталог скилл помнит сам, выгрузку каждый раз давать не нужно. Позиции всех типов, их SKU и id ресурсов, состав бандлов, настройки лутбоксов, переводы, категории и шаблоны цен лежат в его папке \`catalog/\`. Файл импорта содержит только новые позиции и только те колонки, которые у них заполнены, — как выгрузка самого Aghanim.

Всё, что скилл собрал, он запоминает как добавленное: следующая позиция может копировать уже добавленную, а занятый SKU второй раз не выдаётся. Пока добавленное не встретилось в выгрузке, каталог помечает его отдельно. Пересборка того же описания заменяет прежние добавления, а не плодит новые.

Память скилла — снимок, а не живой каталог: он знает то, что было в виденных выгрузках, и то, что собрал сам. В плане сборки он пишет дату последней выгрузки и отдельно называет позиции, которые видел больше ${STALE_DAYS} дней назад. Позицию, заведённую в Aghanim руками, он узнает только из новой выгрузки. Если память окружения собрана из частичных выгрузок, SKU, которого скилл не видел, может уже существовать: импорт такую позицию перезапишет, и в результате импорта она помечена Updated, а не Created. Перед заведением новых позиций в таком окружении просят полную выгрузку (\`--learn … --full\`).

Отдельно скилл показывает SKU с обрезанными нулями: позиции вроде \`6015.2\`, у которых есть полный двойник \`6015.2000\` с тем же названием и количеством. Такие двойники появляются, когда таблица по дороге в Aghanim превращает SKU в число. Если образец ссылается на двойника, план сборки называет это прямо.

Выгрузку можно дать и прямо в spec: тогда новые строки дописываются в её копию, а старые переносятся без единой правки. Ни выгрузка, ни память скилла при сборке не меняются. После записи файл читается обратно и сверяется с описанием офферов.

## Что сейчас на хабе и как идут продажи

Команда \`--hub live\` открывает страницу хаба в браузере Chrome так, как её видит гость без входа в аккаунт, и печатает витрину: разделы, офферы, цену и старую цену, скидку, остаток покупок, условие доступа, состав. Снимок страницы она кладёт в файл. Ключ API для этого не нужен. Цены показаны в валюте страны, из которой открыта страница; персональные офферы и то, что видно только после входа, в список не попадают.

Команда \`--sales\` считает аналитику по выгрузке платежей из кабинета Aghanim (файл CSV): выручку в долларах, покупки, покупателей, средний чек, конверсию оплаты, топ офферов, доли по типам позиций и по странам. Покупки за бонусные очки и подарочными картами деньгами не считаются и показаны отдельной строкой. Период задаётся датами \`--from\` и \`--to\`.

Команда \`--audit live\` проверяет настройку хаба целиком: обходит страницы меню и карты сайта, сама находит страницу программы прогрессии (её адрес меняется от сезона к сезону) и пишет три списка — что настроено, что нет и что гостем не проверить. Она ловит пустые страницы меню, блок программы прогрессии, к которому программа не подключена, карточки без цены и офферы из описания, которых нет на витрине. Подключённая программа прогрессии показывает содержимое только после входа в аккаунт, а пустая страница из карты сайта, которой нет в меню, гостю недоступна — оба случая идут в третий список, а не в ошибки. Если страницы программы нет ни в карте сайта, ни в меню гостя, её адрес передаётся через \`--page\`.

## Как идёт работа

1. Вы описываете офферы: блок Google-таблицы или просто текст «копия такого-то оффера, состав такой-то».
2. Агент находит позиции в памяти скилла командой \`--catalog live --find …\` и записывает описание офферов в файл spec (JSON) рядом с остальными материалами запуска, в \`docs/aghanim-conversion/<запуск>/\`.
3. Команда \`--plan\` печатает, что добавится: цену, шаблон цен, состав с пометками «было / стало», переводы. Файл на этом шаге не пишется.
4. Команда \`--build\` пишет файл импорта и сразу сверяет его со spec.
5. Вы импортируете файл в Aghanim (сначала в песочницу) и выставляете скидки.
6. Когда появляется свежая выгрузка каталога, \`--check --against\` сверяет её с тем же spec, а \`--learn\` запоминает.

## Команды

Запуск: \`${CMD} <команда>\`, где \`<workspace>\` — корень проекта pg3d_projects.

${opsIndex()}

## Форма spec

\`\`\`json
${JSON.stringify(SPEC_EXAMPLE, null, 2)}
\`\`\`

- **catalog** — \`live\` или \`sandbox\`: каталог из памяти скилла; в файле импорта будут только новые офферы. Вместо него можно дать **source** — абсолютный путь к выгрузке: новые строки допишутся в её копию.
- **output** — куда писать файл импорта (\`<home>\` в начале пути — домашняя папка того, кто запускает сборку). Без него файл ляжет рядом со spec, а в режиме **source** — рядом с выгрузкой.
- **offers** — новые позиции любого типа: предмет, валюта, бандл, лутбокс. Тип берётся с образца.
- **copy_of** — SKU позиции-образца из каталога, в том числе добавленной скиллом раньше.
- **items** — состав. Строка — точный \`sku\` предмета каталога или \`id\` ресурса из игры: по id скрипт берёт тот предмет, который уже стоит в образце, а если в образце такого ресурса нет — единственный подходящий в каталоге. Без \`items\` состав копируется с образца.
- **count** — сколько единиц получит игрок. Это колонка count листа NestedItem; число в самом SKU (например \`6015.2200\`) на выдачу не влияет — так устроены нынешние стартер-паки каталога.
- **fields** — любые колонки листа Item, которые надо изменить: цена, шаблон цен, категории, описание, картинки, настройки лутбокса (\`lootbox_settings\` можно дать объектом).
- **translations** — переводы названия и описания по всем языкам листа Translations, либо \`"drop"\`. Если текст не менялся, перевод копируется с образца сам.
- **icon** — тег пушки для команды \`--icons\`; нужен, только если иконка не нашлась по индексу и названию.
- **store.discount_pct** — скидка для справки: в формате импорта Aghanim её нет, скрипт только печатает цену для игрока, которую надо выставить вручную.

## Лутбоксы

Лутбокс — строка листа Item с типом \`lootbox\`; весь его состав лежит в колонке \`lootbox_settings\`, строк в NestedItem у него нет.

- **Два вида.** Платный сундук: цена и шаблон цен стоят в самой строке, как у \`hardpity-lb-weapon-*\`. Сундук за ключи: цена 0, валюта \`VC\`, а цена открытия записана в \`lootbox_settings.price_step_up\` (шаги с суммой в виртуальной валюте), как у \`halloween-box\` в живом каталоге и \`black-friday-chest\` в песочнице. Образец в \`copy_of\` берут того же вида.
- **Награды.** \`groups\` — группы с весом; шанс награды равен доле веса группы, умноженной на долю веса награды внутри группы. Равные шансы — одна группа и одинаковые веса. \`count\` — сколько единиц получит игрок. Один SKU стоит в сундуке один раз, поэтому три пачки ключей — это три разных SKU. \`reward_mode\`: \`non_repeating\` — награда выбывает после выпадения, \`repeating\` — может выпасть снова.
- **Гарантия.** \`pity.steps\` — на каком открытии что гарантировано. У настроенных сундуков шаг один: главная награда на последнем открытии (порог равен числу наград), \`repeat_last: true\`, \`mode: "exclusive"\`.
- **Что берётся с образца.** Если в spec заданы свои \`groups\` и \`pity\`, остальные ключи настроек — \`view_type\`, \`price_step_up\`, \`progress_reset_at\`, ролики открытия — переходят с образца, и план это печатает. \`pity\` с образца не берётся: она ссылается на награды образца.
- **Окружение.** SKU наград, \`fallback_item_id\`, id виртуальной валюты, категории и шаблоны цен в песочнице и в живом каталоге разные. Файл для песочницы собирают из каталога или выгрузки песочницы, для живого каталога — из живого. Выгрузка одного лутбокса из Aghanim содержит и всё, на что он ссылается: награды, предметы-замены, виртуальную валюту, категории.
- **Пушка-награда** — отдельная позиция, копия пушки из того же окружения: от образца ей достаются картинка и предмет-замена, поэтому картинку после импорта меняют.
- **Импорт сундук не создаёт.** Aghanim при импорте из таблицы пропускает позиции типов \`lootbox\` и \`virtual_currency\` с предупреждением «cannot be imported from a spreadsheet and were skipped, create them in the dashboard». Из файла встают только предметы: пушки и ресурсы-награды. Сам сундук и валюту ключей заводят в дашборде вручную; план сборки печатает награды, шансы, гарантию и цену открытия — по ним сундук и настраивают. Проверено импортом в песочницу 19.11.2026.
- **Файл.** Собранная книга проверяется как пакет xlsx: корневые связи и типы частей обязаны быть на месте, иначе Aghanim файл не загрузит, хотя сам скрипт его читает.

## Что проверяется

Любой отказ печатается с причиной и готовым исправлением. Пока есть хоть один отказ до записи, файл не пишется.

| Отказ | Почему это важно | Как исправить |
|---|---|---|
${Object.values(CHECKS).map((c) => `| ${c.what} | ${c.why} | ${c.fix} |`).join('\n')}

## Иконки пушек

Сборка \`--build\` сама собирает иконки новых пушек; отдельная команда \`--icons <spec>\` делает то же без пересборки файла. Она берёт из spec позиции-пушки (SKU начинается с индекса пушки, например \`1407001.1\`), находит их иконки в репозитории клиента и копирует в папку \`art/weapons\` рядом со spec под именами \`<SKU>_<тег>.png\`. Иконка пушки лежит в клиенте в \`Assets/AddressableContent/Weapons/Resident/OfferIcons/<тег>_icon1_big.png\`: 256×256, PNG с прозрачным фоном — тот же формат, что у картинок уже заведённых пушек в Aghanim, обрабатывать её не нужно.

Тег пушки берётся по порядку: поле \`icon\` оффера, кеш подбора контента (индекс → тег), название пушки. Ненайденные иконки команда называет поимённо — для них тег задают в поле \`icon\`. Путь к репозиторию клиента — \`--repo\` или файл \`catalog/client.json\`. Загрузить картинку в Aghanim скилл не может: импорт из таблицы принимает только готовую ссылку, файлы загружают в дашборде.

## Что остаётся человеку

- Импорт файла в Aghanim и выставление скидок: в файле импорта скидки нет.
- Новые предметы, категории и шаблоны цен: скрипт их не заводит, а только проверяет, что они есть в выгрузке.
- Тексты переводов: скрипт раскладывает их по языкам, но не пишет и не проверяет смысл.

## Чего скилл не умеет

- Не ходит в Aghanim по API: каталог знает только по выгрузкам, которые ему показали, а удалённую в Aghanim позицию забывает лишь после полной выгрузки (\`--learn … --full\`).
- Не меняет и не удаляет существующие товары.
- Для лутбокса проверяет веса и наличие наград (в том числе в гарантии), печатает шансы и выдаёт группам собственные идентификаторы, но правила гарантии переносит как записано, без расчёта.
- Не создаёт позицию с нуля: всегда нужен образец того же типа в каталоге.
`;
}

// ---------- commands ----------

const WORKSPACE = path.resolve(SKILL_DIR, '..', '..', '..');
const specIdOf = (file) => {
  const rel = path.relative(WORKSPACE, file);
  return rel.startsWith('..') ? path.basename(file) : rel.split(path.sep).join('/');
};

/** @param {string} file @returns {object} */
function readSpec(file) {
  let spec;
  try { spec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Blocked(`spec не читается: ${file} (${e.message})`); }
  // <home> = home dir of whoever runs the build
  for (const k of ['source', 'output']) if (spec && typeof spec[k] === 'string') spec[k] = spec[k].replace(/^<home>(?=[\\/])/, os.homedir());
  if (spec && spec.catalog !== undefined && spec.output === undefined) spec.output = path.join(path.dirname(file), `${path.basename(file, '.json').replace(/-spec$/, '')}-import.xlsx`);
  return spec;
}

/** @param {string} file @param {object} base @param {object|null} snap @param {object} plan @param {Set<string>} mine @returns {boolean} */
function isOurs(file, base, snap, plan, mine) {
  try {
    const old = loadCatalog(file);
    if (!snap) return Object.entries(base.sheets).every(([n, sh]) => old.sheets[n] && sh.rows.every((r, i) => old.sheets[n].rows[i] && old.sheets[n].rows[i].xml === r.xml));
    const allowed = new Set([...mine, ...plan.offers.map((o) => o.sku)]);
    return !!old.sheets.Item && dataRows(old.sheets.Item).every((r) => allowed.has(String(cellv(old.sheets.Item, r, 'sku'))));
  } catch { return false; }
}

/** @param {object} spec @param {boolean} write @param {string} dir @param {string|null} specId @returns {{ok:boolean,text:string,plan?:object}} */
function runBuild(spec, write, dir = CATALOG_DIR, specId = null) {
  const shape = shapeDefects(spec);
  if (shape.length) return { ok: false, text: refusal(shape) };
  const id = specId || path.basename(spec.output || '');
  const { cat, snap, mine } = openSource(spec, dir, id);
  const plan = resolvePlan(cat, spec);
  if (plan.defects.length) return { ok: false, text: refusal(plan.defects) };
  const base = baseFor(cat, snap, plan);
  if (fs.existsSync(plan.output) && !isOurs(plan.output, base, snap, plan, mine)) {
    return { ok: false, text: refusal([defect('output_path', plan.output, 'файл существует и не является прежней сборкой этого же spec')]) };
  }
  const report = planReport(plan, snap);
  if (!write) return { ok: true, plan, text: `${report}\nDone: план — позиций ${plan.offers.length}, отказов нет; файл не записан, запись — командой --build` };
  fs.mkdirSync(path.dirname(plan.output), { recursive: true });
  fs.writeFileSync(plan.output, applyPlan(base, plan, cat));
  const back = verify(loadCatalog(plan.output), plan, base);
  if (back.length) return { ok: false, plan, text: refusal(back, `файл записан, но не сошёлся со spec: ${plan.output}`) };
  let kept = 'старые строки выгрузки не изменены';
  if (snap) {
    rememberAdditions(snap, dir, plan.output, plan, id);
    kept = `в файле только новые позиции; скилл запомнил их как добавленные в каталог ${snap.env}`;
  }
  const n = plan.offers.reduce((s, o) => s + o.nested.length, 0), t = plan.offers.reduce((s, o) => s + o.tr.length, 0);
  return { ok: true, plan, text: `${report}\nDone: записан ${plan.output} — позиций ${plan.offers.length}, строк состава ${n}, строк переводов ${t}; ${kept}, обратное чтение сошлось со spec` };
}

/** @param {object} spec @param {string|null} against @param {string} dir @param {string|null} specId @returns {{ok:boolean,text:string}} */
function runCheck(spec, against, dir = CATALOG_DIR, specId = null) {
  const shape = shapeDefects(spec);
  if (shape.length) return { ok: false, text: refusal(shape) };
  const { cat, snap } = openSource(spec, dir, specId || path.basename(spec.output || ''));
  const plan = resolvePlan(cat, spec);
  if (plan.defects.length) return { ok: false, text: refusal(plan.defects) };
  const target = against || plan.output;
  const D = verify(loadCatalog(target), plan, against ? null : baseFor(cat, snap, plan));
  if (D.length) return { ok: false, text: refusal(D, `расхождения в ${target}`) };
  return { ok: true, text: `Done: ${target} сходится со spec — позиций ${plan.offers.length}${against ? ' (сверены название, описание, тип, цена, шаблон цен, категории, состав, переводы)' : '; строки, которых нет в spec, не изменены'}` };
}

/** @param {string} env @param {string|null} find @param {string} dir @returns {{ok:boolean,text:string}} */
function showCatalog(env, find, dir = CATALOG_DIR) {
  const { cat, snap } = openSource({ catalog: env }, dir, null);
  const pending = Object.values(snap.sheets.Item.rows).filter((r) => r.added).map((r) => r.v.sku);
  const twins = [...twinMap(cat.sheets.Item)].map(([a, b]) => `${a} ← ${b}`);
  const head = [
    `Каталог ${env} — что скилл помнит без выгрузки:`,
    ...snap.sources.map((s) => `  выгрузка ${s.exported.slice(0, 10)} · ${s.file} · позиций ${s.items}`),
    `Позиций ${Object.keys(snap.sheets.Item.rows).length}: ${typeCounts(snap)}`,
    pending.length ? `Добавлено скиллом и ещё не встречалось в выгрузках: ${pending.join(', ')}` : '',
    twins.length ? `SKU с обрезанными нулями, двойники полных (${twins.length}): ${twins.join(', ')}` : '',
  ].filter(Boolean);
  return inspect(cat, `каталог ${env}`, find, head);
}

/** @param {object} cat @param {string} file @param {string|null} find @param {string[]} out @returns {{ok:boolean,text:string}} */
function inspect(cat, file, find, out = []) {
  for (const [name, sh] of Object.entries(cat.sheets)) out.push(`${name}: строк ${dataRows(sh).length} · колонки: ${[...sh.header.keys()].slice(0, 40).join(', ')}${sh.header.size > 40 ? ', …' : ''}`);
  const item = cat.sheets.Item, nested = cat.sheets.NestedItem;
  if (!item || !item.header.has('sku')) return { ok: false, text: `${out.join('\n')}\n${refusal([defect('sheet_missing', 'Item', 'нужна колонка sku')], 'выгрузка не разобрана')}` };
  const skuOf = (r) => String(cellv(item, r, 'sku'));
  const nameOf = new Map(dataRows(item).map((r) => [skuOf(r), cellv(item, r, 'name')]));
  const comp = (sku) => (nested ? dataRows(nested).filter((x) => String(cellv(nested, x, 'parent_sku')) === sku) : []);
  const line = (r) => `${skuOf(r)} «${cellv(item, r, 'name')}» · тип ${cellv(item, r, 'type') || '—'} · quantity ${cellv(item, r, 'quantity')} · цена ${cellv(item, r, 'price')} · шаблон ${cellv(item, r, 'price_template_key') || '—'} · категории ${cellv(item, r, 'categories') || '—'}`;
  if (find) {
    const q = String(find).toLowerCase();
    const hits = dataRows(item).filter((r) => { const s = skuOf(r).toLowerCase(); return s === q || s.startsWith(`${q}.`) || String(cellv(item, r, 'name')).toLowerCase().includes(q); });
    out.push(`\nПоиск «${find}»: ${hits.length}`);
    for (const r of hits) {
      out.push(`  ${line(r)}`);
      for (const c of comp(skuOf(r))) {
        const sku = String(cellv(nested, c, 'sku'));
        out.push(`      ${sku} ×${cellv(nested, c, 'count')}${nameOf.has(sku) ? ` «${nameOf.get(sku)}»` : ' — предмета нет в выгрузке'}`);
      }
      if (cellv(item, r, 'lootbox_settings')) out.push(`      lootbox_settings: ${cellv(item, r, 'lootbox_settings')}`);
    }
  } else {
    out.push('\nБандлы и лутбоксы (состав и настройки — через --find <sku>):');
    for (const r of dataRows(item).filter((x) => ['bundle', 'lootbox'].includes(cellv(item, x, 'type')))) out.push(`  ${line(r)} · в составе ${comp(skuOf(r)).length}`);
  }
  out.push(`Done: прочитан ${file}`);
  return { ok: true, text: out.join('\n') };
}

/** @returns {string} */
function syncDocs() {
  fs.mkdirSync(path.dirname(DOC_PATH), { recursive: true });
  fs.writeFileSync(DOC_PATH, describe());
  let note = 'SKILL.md не найден — таблица команд не обновлена';
  if (fs.existsSync(SKILL_MD)) {
    const md = fs.readFileSync(SKILL_MD, 'utf8'), a = md.indexOf(OPS_OPEN), b = md.indexOf(OPS_CLOSE);
    if (a < 0 || b < a) note = 'в SKILL.md нет меток OPSINDEX — таблица команд не обновлена';
    else { fs.writeFileSync(SKILL_MD, `${md.slice(0, a + OPS_OPEN.length)}\n${opsIndex()}\n${md.slice(b)}`); note = 'таблица команд в SKILL.md обновлена'; }
  }
  return `Done: описание записано в ${DOC_PATH}; ${note}`;
}

// ---------- hub page ----------

const HUBS_FILE = path.join(CATALOG_DIR, 'hubs.json');
const CHROME_PATHS = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

/** @param {string} chunk @param {string} id @param {string} variant @returns {object} */
function parseHubCard(chunk, id, variant) {
  const card = { id, variant, qty: [], badges: {}, texts: {}, strike: {}, price: '' };
  let comp = 'other', badge = '', strike = false, priceNext = false;
  for (const m of chunk.matchAll(/<\/[a-z0-9]+>|<!--[\s\S]*?-->|<([a-z0-9]+)((?:\s[^>]*)?)>|([^<]+)/g)) {
    if (['h1', 'h2', 'section', 'footer', 'nav'].includes(m[1])) break;
    if (m[3] === undefined) {
      const a = m[2] || '', testid = attr(a, 'data-testid');
      if (attr(a, 'data-element-component')) { comp = attr(a, 'data-element-component'); badge = ''; }
      if (attr(a, 'data-badge-key')) badge = attr(a, 'data-badge-key');
      if (comp === 'button-buy' && attr(a, 'data-variant')) card.button = attr(a, 'data-variant');
      if (/\sdata-strikethrough(?:="(?!false")[^"]*")?(?=[\s>]|$)/.test(a)) strike = true;
      else if (testid === 'store-card/price' || testid === 'store-card/price_after_discount') priceNext = true;
      continue;
    }
    const text = decodeXml(m[3].replace(/&nbsp;/g, ' ')).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (strike) { (card.strike[comp] = card.strike[comp] || []).push(text); strike = false; }
    else if (priceNext) { card.price = text; priceNext = false; }
    else if (comp === 'sku-bundle-grid') card.qty.push(text);
    else if (comp === 'sku-badges' && badge) (card.badges[badge] = card.badges[badge] || []).push(text);
    else (card.texts[comp] = card.texts[comp] || []).push(text);
  }
  return card;
}

/** @param {string} html @returns {{slug:string,title:string,cards:object[]}[]} */
function parseHub(html) {
  const body = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '');
  const marks = [];
  for (const m of body.matchAll(/id="category-link-([^"]+)"/g)) {
    const hit = body.indexOf(` id="${m[1]}"`), at = hit < 0 ? -1 : body.lastIndexOf('<', hit);
    if (at >= 0 && !marks.some((x) => x.slug === m[1])) marks.push({ at, slug: m[1] });
  }
  for (const m of body.matchAll(/<[a-z0-9]+\s[^>]*data-card-item-id="([^"]+)"[^>]*>/g)) marks.push({ at: m.index, end: m.index + m[0].length, id: m[1], variant: attr(m[0], 'data-card-variant') || '' });
  marks.sort((a, b) => a.at - b.at);
  const sections = [];
  marks.forEach((mark, i) => {
    if (mark.slug) {
      const title = body.slice(mark.at).match(/>([^<]*)</);
      sections.push({ slug: mark.slug, title: title ? decodeXml(title[1]).trim() : mark.slug, cards: [] });
      return;
    }
    if (!sections.length) sections.push({ slug: '', title: 'без раздела', cards: [] });
    const next = marks[i + 1] ? marks[i + 1].at : body.length;
    sections[sections.length - 1].cards.push(parseHubCard(body.slice(mark.end, next), mark.id, mark.variant));
  });
  return sections;
}

/** @param {object[]} sections @param {string} url @param {object|null} snap @param {string|null} png @returns {{ok:boolean,text:string}} */
function hubReport(sections, url, snap, png) {
  const total = sections.reduce((s, x) => s + x.cards.length, 0);
  if (!total) return { ok: false, text: `Rejected: defects_found — на странице ${url} не найдено ни одной карточки: страница не загрузилась или разметка хаба изменилась` };
  const byName = new Map();
  if (snap) for (const v of recordsOf(snap.sheets.Item)) byName.set(v.name, [...(byName.get(v.name) || []), v.sku]);
  const badgeText = { discount: (t) => t.join(' '), remaining: (t) => t.join(' '), bonus: (t) => t.join(' '), points: (t) => `очки ${t.join(' / ')}` };
  const out = [`Хаб ${url} — как его видит гость без входа в аккаунт; цены в валюте страны, из которой открыта страница`];
  const seen = new Map();
  for (const s of sections) {
    out.push(`\n${s.title}${s.slug ? ` (${s.slug})` : ''}: ${s.cards.length}`);
    for (const c of s.cards) {
      const name = (c.texts['sku-name'] || []).join(' ') || '—';
      const was = (list) => (list && list.length ? ` (было ${list.join(' ')})` : '');
      const buy = c.price || (c.texts['button-buy'] || []).join(' ') || 'цена не показана';
      const skus = byName.get(name) || [];
      const parts = [
        `${name}${was(c.strike['sku-name'])} — ${buy}${was(c.strike['button-buy'])}`,
        ...Object.entries(c.badges).map(([k, t]) => (badgeText[k] ? badgeText[k](t) : `${k}: ${t.join(' ')}`)),
        ...(c.texts['sku-mismatch-description'] || []),
        c.qty.length ? `состав: ${c.qty.join(', ')}` : '',
        skus.length === 1 ? `SKU ${skus[0]}` : '',
        seen.has(c.id) ? `та же карточка, что в разделе «${seen.get(c.id)}»` : '',
      ].filter(Boolean);
      if (!seen.has(c.id)) seen.set(c.id, s.title);
      out.push(`  ${parts.join(' · ')} [${c.id}]`);
    }
  }
  if (png) out.push(`\nСнимок страницы: ${png}`);
  out.push(`Done: на хабе сейчас ${seen.size} разных карточек в ${sections.filter((s) => s.cards.length).length} разделах (всего показов ${total})`);
  return { ok: true, text: out.join('\n') };
}

/** @param {string} target @returns {string} */
function hubUrl(target) {
  const hubs = fs.existsSync(HUBS_FILE) ? JSON.parse(fs.readFileSync(HUBS_FILE, 'utf8')) : {};
  const url = /^https:\/\//.test(target) ? target : hubs[target];
  if (!url) throw new Blocked(`адрес хаба «${target}» не записан (известны: ${Object.keys(hubs).join(', ') || 'нет'}); можно дать адрес целиком: https://…`);
  return url;
}

/** @param {string} url @param {string|null} png @returns {string} */
function dumpPage(url, png) {
  const chrome = CHROME_PATHS.find((p) => p && fs.existsSync(p));
  if (!chrome) throw new Blocked('не найден Google Chrome: нужен установленный Chrome или путь к нему в переменной CHROME_PATH');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aghanim-hub-'));
  const common = ['--headless=new', '--disable-gpu', '--no-first-run', '--lang=en-US', `--user-data-dir=${profile}`, '--window-size=1440,7000', '--virtual-time-budget=25000', '--hide-scrollbars'];
  const dom = spawnSync(chrome, [...common, '--dump-dom', url], { encoding: 'utf8', timeout: 120000, maxBuffer: 256 * 1024 * 1024 });
  if (png) { fs.rmSync(png, { force: true }); spawnSync(chrome, [...common, `--screenshot=${png}`, url], { timeout: 120000 }); }
  fs.rmSync(profile, { recursive: true, force: true });
  if (dom.status !== 0 || !dom.stdout) throw new Error(`страница не открылась за две минуты: ${url}`);
  return dom.stdout;
}

/** @param {string} target @param {string|null} shot @returns {{ok:boolean,text:string}} */
function runHub(target, shot) {
  const url = hubUrl(target);
  const png = shot || path.join(os.tmpdir(), `aghanim-hub-${target.replace(/[^a-z0-9]+/gi, '-')}.png`);
  let html;
  try { html = dumpPage(url, png); } catch (e) { if (e instanceof Blocked) throw e; throw new Blocked(e.message); }
  return hubReport(parseHub(html), url, readSnapshot('live', CATALOG_DIR), fs.existsSync(png) ? png : null);
}

// ---------- hub audit ----------

const STANDARD_PAGES = ['', 'store', 'daily-rewards', 'loyalty-program', 'redeem-coupon', 'news', 'updates', 'events', 'database', 'achievements', 'faq'];

/** @param {string} html @returns {object} */
function pageFacts(html) {
  const body = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '');
  const a = body.indexOf('grid-area:content'), b = body.indexOf('data-testid="shell-sidebar-right"');
  const main = a < 0 ? '' : body.slice(a, b > a ? b : undefined);
  return {
    title: decodeXml((html.match(/<title>([^<]*)/) || [])[1] || '').trim(),
    texts: [...main.matchAll(/>([^<>]+)</g)].map((m) => decodeXml(m[1].replace(/&nbsp;/g, ' ')).trim()).filter((t) => t.length > 1),
    cards: (main.match(/data-card-item-id=/g) || []).length,
    inputs: (main.match(/<input\b/g) || []).length,
    entities: [...body.matchAll(/data-hub-entity="([^"]+)" data-hub-entity-id="([^"]*)">(<\/div>)?/g)].map((m) => ({ name: m[1], id: m[2], empty: !!m[3] })),
  };
}

/** @param {string} origin @param {object[]} pages @param {object[]} sections @param {{label:string,names:string[]}[]} expected @param {string[]} shots @returns {{ok:boolean,text:string}} */
function auditReport(origin, pages, sections, expected, shots) {
  const good = [], bad = [], unseen = [];
  const say = (ok, yes, no) => (ok ? good : bad).push(ok ? yes : no);
  for (const p of pages) {
    if (!p.facts) { bad.push(`страница /${p.path} не открылась`); continue; }
    const label = `страница /${p.path}${p.facts.title ? ` «${p.facts.title}»` : ''}`;
    const program = p.facts.entities.find((e) => e.name === 'progression-program');
    const filled = p.facts.texts.length >= 2 || p.facts.cards > 0 || p.facts.inputs > 0;
    if (program && program.empty && program.id) unseen.push(`${label} — программа прогрессии подключена (${program.id}), но гостю её блок не показывается: содержимое видно после входа в аккаунт`);
    else if (program) say(!program.empty, `${label} — программа прогрессии показывается`, `${label} — блок программы прогрессии пустой и программа к нему не подключена`);
    else if (!filled && p.source === 'sitemap') unseen.push(`${label} — пустая для гостя; в меню её нет, адрес взят из карты сайта`);
    else if (p.path !== 'store') say(filled, `${label} — есть содержимое`, `${label} — пустая`);
  }
  if (!pages.some((p) => p.facts && p.facts.entities.some((e) => e.name === 'progression-program'))) {
    bad.push('страница программы прогрессии не найдена: её нет ни в карте сайта, ни в меню гостя — нужен её адрес (--page https://…)');
  }
  const cards = [...new Map(sections.flatMap((s) => s.cards).map((c) => [c.id, c])).values()];
  const nameOf = (c) => (c.texts['sku-name'] || []).join(' ') || c.id;
  say(cards.length > 0, `витрина /store — ${cards.length} карточек в ${sections.filter((s) => s.cards.length).length} разделах`, 'витрина /store — карточек нет');
  const hollow = sections.filter((s) => !s.cards.length).map((s) => s.title);
  if (hollow.length) bad.push(`пустые разделы витрины: ${hollow.join(', ')}`);
  const noPrice = cards.filter((c) => !c.price && c.button !== 'component-free');
  if (cards.length) say(!noPrice.length, 'у всех платных карточек есть цена', `нет цены, на кнопке другой текст: ${noPrice.map((c) => `${nameOf(c)} — «${(c.texts['button-buy'] || []).join(' ')}»`).join('; ')}`);
  const noOld = cards.filter((c) => c.badges.discount && c.price && !c.strike['button-buy']);
  if (noOld.length) bad.push(`скидка показана без старой цены: ${noOld.map(nameOf).join(', ')}`);
  for (const e of expected) {
    const found = cards.some((c) => e.names.some((n) => nameOf(c).toLowerCase().includes(n.toLowerCase())));
    say(found, `оффер «${e.label}» стоит на витрине`, `оффера «${e.label}» на витрине нет`);
  }
  const out = [
    `Проверка хаба ${origin} — глазами гостя без входа в аккаунт`,
    `\nНастроено (${good.length}):`, ...good.map((t) => `  ✔ ${t}`),
    `\nНе настроено или требует внимания (${bad.length}):`, ...(bad.length ? bad.map((t) => `  ✖ ${t}`) : ['  —']),
    `\nГостем не проверить (${unseen.length}):`, ...(unseen.length ? unseen.map((t) => `  ? ${t}`) : ['  —']),
    '\nГость не видит: персональные офферы, пункты меню и блоки, которые показываются только после входа в аккаунт',
    ...shots.map((s) => `Снимок: ${s}`),
    `Done: проверено страниц ${pages.length}; настроено ${good.length}, требует внимания ${bad.length}, гостем не проверить ${unseen.length}`,
  ];
  return { ok: true, text: out.join('\n') };
}

/** @param {string} target @param {string[]} given @param {string|null} expectFile @returns {Promise<{ok:boolean,text:string}>} */
async function runAudit(target, given, expectFile) {
  const origin = new URL(hubUrl(target)).origin;
  if (!CHROME_PATHS.some((p) => p && fs.existsSync(p))) throw new Blocked('не найден Google Chrome: нужен установленный Chrome или путь к нему в переменной CHROME_PATH');
  const clean = (u) => new URL(u).pathname.replace(/^\/|\/$/g, '').replace(/^[a-z]{2}(-[A-Za-z]+)?\//, '');
  const extra = [];
  const add = (p) => { if (p && !p.includes('/') && !/^[a-z]{2}(-[A-Za-z]+)?$/.test(p) && !STANDARD_PAGES.includes(p) && !extra.includes(p)) extra.push(p); };
  try {
    const xml = await (await fetch(`${origin}/sitemap.xml`)).text();
    for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) add(clean(m[1]));
  } catch { /* the sitemap is optional: standard pages are checked anyway */ }
  const sitemapOnly = new Set(extra);
  for (const u of given) { add(clean(u)); sitemapOnly.delete(clean(u)); }
  let expected = [];
  if (expectFile) {
    const spec = readSpec(expectFile);
    expected = (spec.offers || []).map((o) => ({ label: o.name, names: [o.name, ...Object.values(o.translations && typeof o.translations.name === 'object' ? o.translations.name : {})] }));
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aghanim-audit-'));
  const pages = [], shots = [];
  let sections = [];
  for (const p of [...STANDARD_PAGES, ...extra.slice(0, 12)]) {
    const png = p === 'store' || extra.includes(p) ? path.join(dir, `${p}.png`) : null;
    let html;
    try { html = dumpPage(`${origin}/${p}`, png); } catch (e) { if (e instanceof Blocked) throw e; pages.push({ path: p, facts: null }); continue; }
    if (p === 'store') sections = parseHub(html);
    if (png && fs.existsSync(png)) shots.push(png);
    pages.push({ path: p, source: sitemapOnly.has(p) ? 'sitemap' : 'menu', facts: pageFacts(html) });
  }
  return auditReport(origin, pages, sections, expected, shots);
}

// ---------- weapon icons ----------

const CLIENT_FILE = path.join(CATALOG_DIR, 'client.json');
const WEAPON_ICONS = path.join('Assets', 'AddressableContent', 'Weapons', 'Resident', 'OfferIcons');
const TAGS_CACHE = path.join(WORKSPACE, '.harness', 'state', 'event-content', 'catalog.json');
const tagOfName = (name) => String(name).toLowerCase().replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** @param {string} file @returns {Map<string,string>} */
function weaponTags(file) {
  try { return new Map(JSON.parse(fs.readFileSync(file, 'utf8')).filter((x) => x.kind === 'weapon' && x.tag).map((x) => [String(x.index), String(x.tag)])); } catch { return new Map(); }
}

/** @param {object} spec @param {string} outDir @param {string} repo @param {Map<string,string>} tags @returns {{ok:boolean,text:string}} */
function runIcons(spec, outDir, repo, tags) {
  const from = path.join(repo, WEAPON_ICONS);
  if (!fs.existsSync(from)) throw new Blocked(`в репозитории клиента нет папки иконок: ${from}`);
  const guns = (spec.offers || []).filter((o) => /^\d+001\.\d+/.test(String(o.sku)));
  if (!guns.length) return { ok: false, text: 'Rejected: defects_found — в spec нет пушек: SKU пушки начинается с её индекса, например 1407001.1' };
  const found = [], lost = [];
  for (const o of guns) {
    const index = String(o.sku).match(/^\d+001/)[0];
    const tries = [[o.icon, 'поле icon'], [tags.get(index), 'тег по индексу'], [tagOfName(o.name), 'тег из названия']].filter(([t]) => t);
    const hit = tries.find(([t]) => fs.existsSync(path.join(from, `${t}_icon1_big.png`)));
    if (!hit) { lost.push(`${o.sku} «${o.name}» — искал ${[...new Set(tries.map(([t]) => `${t}_icon1_big.png`))].join(', ')}`); continue; }
    const to = path.join(outDir, `${o.sku}_${hit[0]}.png`);
    fs.mkdirSync(outDir, { recursive: true });
    fs.copyFileSync(path.join(from, `${hit[0]}_icon1_big.png`), to);
    found.push(`${o.sku} «${o.name}» — ${to} (${hit[1]})`);
  }
  const out = [`Иконки пушек из ${from}`, ...found.map((t) => `  ✔ ${t}`), ...lost.map((t) => `  ✖ ${t}`), 'Загрузка в Aghanim — руками: импорт из таблицы принимает ссылку на картинку, а не файл'];
  if (lost.length) return { ok: false, text: `${out.join('\n')}\nRejected: defects_found — иконок найдено ${found.length} из ${guns.length}; для остальных задайте тег пушки в поле "icon" оффера` };
  return { ok: true, text: `${out.join('\n')}\nDone: иконок ${found.length} из ${guns.length} → ${outDir}` };
}

const iconsDir = (specFile) => path.join(path.dirname(specFile), 'art', 'weapons');
const clientRepo = () => (fs.existsSync(CLIENT_FILE) ? JSON.parse(fs.readFileSync(CLIENT_FILE, 'utf8')).repo : null) || null;

/** @param {string} text @param {object} spec @param {string} outDir @param {string|null} repo @param {Map<string,string>} tags @returns {string} */
function withIcons(text, spec, outDir, repo, tags) {
  if (!(spec.offers || []).some((o) => /^\d+001\.\d+/.test(String(o.sku)))) return text;
  let note = `иконки пушек не собраны: путь к репозиторию клиента не записан в ${CLIENT_FILE}`;
  if (repo) {
    try {
      const body = runIcons(spec, outDir, repo, tags).text.split('\n');
      const verdict = body.pop().replace(/^(Done: |Rejected: defects_found — )/, 'иконки пушек: ');
      note = [...body, verdict].join('\n');
    } catch (e) { if (!(e instanceof Blocked)) throw e; note = `иконки пушек не собраны: ${e.message}`; }
  }
  const lines = text.split('\n'), done = lines.pop();
  return [...lines, note, done].join('\n');
}

// ---------- sales ----------

const SALES_COLUMNS = ['payment_date', 'status', 'order_amount', 'price', 'payment_currency', 'psp_name', 'sku', 'item', 'player_id'];
const FAILED = ['failed', 'rejected', 'expired', 'abandoned', 'voided'];

/** @param {string} text @returns {object[]} */
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

const median = (list) => { const s = [...list].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const usd = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : '—');

/** @param {string} text @param {{from?:string,to?:string,top?:number}} opts @param {object|null} snap @returns {{ok:boolean,text:string}} */
function salesReport(text, opts, snap) {
  const all = parseCsv(text);
  const lost = SALES_COLUMNS.filter((c) => !all.length || !(c in all[0]));
  if (lost.length) return { ok: false, text: `Rejected: defects_found — это не выгрузка платежей Aghanim: нет колонок ${lost.join(', ')}` };
  const usdPrice = new Map(), local = new Map();
  for (const r of all) {
    const p = Number(r.price);
    if (!(p > 0)) continue;
    const bucket = r.payment_currency === 'USD' ? usdPrice : local.get(r.payment_currency) || local.set(r.payment_currency, new Map()).get(r.payment_currency);
    bucket.set(r.sku, [...(bucket.get(r.sku) || []), p]);
  }
  const fx = new Map([['USD', 1]]);
  for (const [cur, skus] of local) {
    const rates = [...skus].filter(([sku]) => usdPrice.has(sku)).map(([sku, list]) => median(list) / median(usdPrice.get(sku)));
    if (rates.length) fx.set(cur, median(rates));
  }
  const day = (r) => r.payment_date.slice(0, 10);
  const rows = all.filter((r) => (!opts.from || day(r) >= opts.from) && (!opts.to || day(r) <= opts.to));
  if (!rows.length) return { ok: false, text: 'Rejected: defects_found — в выбранном периоде нет ни одного платежа' };
  const cash = rows.filter((r) => r.payment_currency !== 'RP' && r.psp_name !== 'Gift Cards');
  const paid = cash.filter((r) => r.status === 'succeeded');
  const failed = cash.filter((r) => FAILED.includes(r.status)).length;
  const types = new Map(snap ? recordsOf(snap.sheets.Item).map((v) => [String(v.sku), v.type]) : []);
  const offers = new Map(), countries = new Map(), byType = new Map(), noRate = new Map();
  let total = 0;
  for (const r of paid) {
    if (!fx.has(r.payment_currency)) { noRate.set(r.payment_currency, (noRate.get(r.payment_currency) || 0) + 1); continue; }
    const amount = Number(r.order_amount || 0) / fx.get(r.payment_currency);
    total += amount;
    const o = offers.get(r.sku) || offers.set(r.sku, { n: 0, rev: 0, players: new Set(), names: new Map() }).get(r.sku);
    o.n++; o.rev += amount; o.players.add(r.player_id); o.names.set(r.item, (o.names.get(r.item) || 0) + 1);
    countries.set(r.user_country || '—', (countries.get(r.user_country || '—') || 0) + amount);
    const type = types.get(r.sku) || 'нет в памяти каталога';
    byType.set(type, (byType.get(type) || 0) + amount);
  }
  const days = rows.map(day).sort(), lastDay = days[days.length - 1];
  const lastTime = rows.filter((r) => day(r) === lastDay).map((r) => r.payment_date.slice(11, 16)).sort().pop();
  const buyers = new Set(paid.map((r) => r.player_id)).size, counted = paid.length - [...noRate.values()].reduce((s, n) => s + n, 0);
  const top = [...offers].sort((a, b) => b[1].rev - a[1].rev).slice(0, opts.top || 15);
  const share = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${usd(v)} (${pct(v, total)})`).join(' · ');
  const status = (s) => rows.filter((r) => r.status === s).length;
  const out = [
    `Продажи Aghanim за ${days[0]} … ${lastDay}${lastTime < '23:00' ? ` — последний день неполный (последний платёж в ${lastTime} UTC), с полными днями его не сравнивать` : ''}`,
    `Выручка ${usd(total)} · оплаченных покупок ${counted} · покупателей ${buyers} · средний чек $${counted ? (total / counted).toFixed(2) : '0'} · конверсия оплаты ${pct(paid.length, paid.length + failed)}`,
    `Не деньги, в выручку не входят: за бонусные очки ${rows.filter((r) => r.payment_currency === 'RP' && r.status === 'succeeded').length} покупок, подарочными картами ${rows.filter((r) => r.psp_name === 'Gift Cards' && r.payment_currency !== 'RP' && r.status === 'succeeded').length}`,
    `Возвраты ${status('refunded')} · споры ${status('disputed')} · чарджбэки ${status('chargeback')} · в ожидании ${status('pending')}`,
    noRate.size ? `Без курса валюты (в выручку не вошли): ${[...noRate].map(([c, n]) => `${c} — ${n}`).join(', ')}` : '',
    `\nТоп офферов по выручке:`,
    ...top.map(([sku, o], i) => `  ${i + 1}. ${[...o.names].sort((a, b) => b[1] - a[1])[0][0]} (${sku}${types.has(sku) ? ` · ${types.get(sku)}` : ''}) — ${usd(o.rev)} · ${pct(o.rev, total)} · покупок ${o.n} · покупателей ${o.players.size}`),
    `\nПо типам позиций: ${share(byType)}`,
    `По странам: ${share(countries)}`,
    `Как считается: выручка — оплаченные платежи за деньги, сумма заказа с налогом страны; доллары — по курсу из самой выгрузки (цена оффера в валюте к его цене в USD), погрешность около 3%`,
    `Done: аналитика по ${rows.length} строкам выгрузки, офферов с продажами ${offers.size}`,
  ].filter(Boolean);
  return { ok: true, text: out.join('\n') };
}

// ---------- selftest ----------

const writeFixture = (file, shared, sheets) => fs.writeFileSync(file, workbookBuffer(shared, sheets));

/** @param {boolean} shared @param {object} sheets @returns {Buffer} */
function workbookBuffer(shared, sheets) {
  const st = stringState(shared ? [] : null);
  const names = Object.keys(sheets);
  const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const sheetXml = (rows) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${NS}><sheetData>${rows.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => cellXml(colName(j + 1), i + 1, null, v, st)).join('')}</row>`).join('')}</sheetData></worksheet>`;
  const entries = names.map((n, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(sheetXml(sheets[n])) }));
  entries.push({ name: 'xl/workbook.xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><workbook ${NS} xmlns:r="${R}"><sheets>${names.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`) });
  entries.push({ name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((n, i) => `<Relationship Id="rId${i + 1}" Type="${R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}${shared ? `<Relationship Id="rIdS" Type="${R}/sharedStrings" Target="sharedStrings.xml"/>` : ''}<Relationship Id="rIdT" Type="${R}/styles" Target="styles.xml"/></Relationships>`) });
  entries.push({ name: 'xl/styles.xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet ${NS}><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`) });
  entries.push({ name: '_rels/.rels', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`) });
  if (shared) entries.push({ name: 'xl/sharedStrings.xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><sst ${NS} count="${st.refs}" uniqueCount="${st.added.length}">${st.added.map((s) => `<si>${tXml(s)}</si>`).join('')}</sst>`) });
  const CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
  const part = (name, type) => `<Override PartName="/${name}" ContentType="${CT}.${type}+xml"/>`;
  entries.push({ name: '[Content_Types].xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>${part('xl/workbook.xml', 'sheet.main')}${names.map((n, i) => part(`xl/worksheets/sheet${i + 1}.xml`, 'worksheet')).join('')}${shared ? part('xl/sharedStrings.xml', 'sharedStrings') : ''}${part('xl/styles.xml', 'styles')}</Types>`) });
  return writeZip(entries);
}

/** @returns {{ok:boolean,text:string}} */
function selftest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aghanim-selftest-'));
  const fails = [];
  const expect = (name, cond) => { if (!cond) fails.push(name); };
  const chest = { groups: [{ id: 'g1', weight: 1, name: 'Weapon', nested_items: [{ id: '', weight: 100, count: 1, sku: '7015.300' }] }, { id: 'g2', weight: 99, name: 'Rewards', nested_items: [{ id: '', weight: 10, count: 250, sku: '6015.2000' }, { id: '', weight: 30, count: 100, sku: '2015.1500' }] }] };
  const sheets = {
    Item: [
      ['sku', 'name', 'description', 'price', 'price_point', 'currency', 'price_template_key', 'type', 'quantity', 'is_stackable', 'categories', 'lootbox_settings'],
      ['6015.2000', 'Keys', '', 0, 99, 'USD', '', 'currency', 2000, true, 'for-bundles', ''],
      ['6015.500', 'Keys', '', 0, 99, 'USD', '', 'currency', 500, true, '', ''],
      ['2015.1500', 'Gems', '', 0, 99, 'USD', '', 'currency', 1500, true, 'for-bundles', ''],
      ['7015.300', 'Gallery Coupons', '', 0, 99, 'USD', '', 'item', 300, true, '', ''],
      ['7015.6000', 'Coupons', '', 0, 99, 'USD', '', 'item', 6000, true, 'for-bundles', ''],
      ['kit', "Dominator's Kit", 'Big kit & more', 25000, 25000, 'USD', 'price-250', 'bundle', 1, false, 'bundles', ''],
      ['chest', 'Chest', '', 499, 499, 'USD', '', 'lootbox', 1, false, '', JSON.stringify(chest)],
    ],
    NestedItem: [['sku', 'count', 'parent_sku'], ['6015.2000', 2000, 'kit'], ['2015.1500', 1500, 'kit']],
    Categories: [['slug', 'name'], ['bundles', 'Bundles'], ['for-bundles', 'For Bundles']],
    Translations: [['key', 'object_type', 'object_property', 'de', 'ru'], ['kit', 'Item', 'name', 'Beherrscher-Set', 'Набор Доминатора'], ['kit', 'Item', 'description', 'Gross', 'Большой набор']],
    PriceTemplate: [['price_template_key', 'name', 'price_point'], ['price-250', '250', 25000], ['price-300', '300', 30000]],
  };
  const codes = (r) => [...r.text.matchAll(/\[([a-z_]+)\]/g)].map((m) => m[1]);
  for (const shared of [true, false]) {
    const tag = shared ? 'shared' : 'inline';
    const source = path.join(dir, `export-${tag}.xlsx`), output = path.join(dir, `import-${tag}.xlsx`), foreign = path.join(dir, `foreign-${tag}.xlsx`);
    writeFixture(source, shared, sheets);
    writeFixture(foreign, shared, { Item: [['sku', 'name'], ['other', 'Other']] });
    const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    const before = hash(source), foreignBefore = hash(foreign);
    const items = [{ id: '6015', count: 2200 }, { id: '2015', count: 1600 }, { sku: '7015.300', count: 500 }];
    const offer = (o = {}) => ({ sku: 'bf-kit', name: 'BF Kit <1>', copy_of: 'kit', items, translations: { name: { de: 'BF-Set', ru: 'ЧП: Набор' } }, store: { discount_pct: 91 }, ...o });
    const spec = (o, extra = {}) => ({ source, output, offers: [offer(o)], ...extra });

    const built = runBuild(spec(), true);
    expect(`${tag}: build ok`, built.ok && built.text.includes('игроку 22.50 USD') && built.text.includes('было 2000'));
    expect(`${tag}: source untouched`, hash(source) === before);
    if (built.ok) {
      const out = loadCatalog(output), it = out.sheets.Item, ne = out.sheets.NestedItem, tr = out.sheets.Translations;
      const row = dataRows(it).find((r) => cellv(it, r, 'sku') === 'bf-kit');
      expect(`${tag}: item row`, row && cellv(it, row, 'name') === 'BF Kit <1>' && cellv(it, row, 'price') === 25000 && cellv(it, row, 'description') === 'Big kit & more' && cellv(it, row, 'is_stackable') === false);
      expect(`${tag}: nested`, dataRows(ne).filter((r) => cellv(ne, r, 'parent_sku') === 'bf-kit').map((r) => `${cellv(ne, r, 'sku')}x${cellv(ne, r, 'count')}`).join() === '6015.2000x2200,2015.1500x1600,7015.300x500');
      const t = (p) => dataRows(tr).find((r) => cellv(tr, r, 'key') === 'bf-kit' && cellv(tr, r, 'object_property') === p);
      expect(`${tag}: translations`, t('name') && cellv(tr, t('name'), 'ru') === 'ЧП: Набор' && t('description') && cellv(tr, t('description'), 'ru') === 'Большой набор');
      expect(`${tag}: rows appended only`, dataRows(it).length === 8 && dataRows(ne).length === 5 && dataRows(tr).length === 4);
    }
    expect(`${tag}: rebuild converges`, runBuild(spec(), true).ok);
    expect(`${tag}: check output`, runCheck(spec(), null).ok);
    expect(`${tag}: check against export`, runCheck(spec(), output).ok);
    expect(`${tag}: against source → offer_missing`, codes(runCheck(spec(), source)).includes('offer_missing'));
    expect(`${tag}: tampered count`, codes(runCheck(spec({ items: [{ id: '6015', count: 2201 }, ...items.slice(1)] }), null)).includes('readback_nested'));
    expect(`${tag}: foreign output kept`, codes(runBuild(spec(undefined, { output: foreign }), true)).includes('output_path') && hash(foreign) === foreignBefore);
    expect(`${tag}: output = source`, codes(runBuild(spec(undefined, { output: source }), true)).includes('output_path') && hash(source) === before);

    const refuse = (name, o, code) => expect(`${tag}: ${name} → ${code}`, codes(runBuild(spec(o), false)).includes(code));
    refuse('sku exists', { sku: 'kit' }, 'sku_exists');
    refuse('sku shape', { sku: 'bf kit' }, 'sku_shape');
    refuse('copy_of missing', { copy_of: 'nope' }, 'copy_of_missing');
    refuse('component missing', { items: [{ sku: '9999.1', count: 1 }] }, 'component_missing');
    refuse('component id missing', { items: [{ id: '9999', count: 1 }] }, 'component_missing');
    refuse('component ambiguous', { items: [{ id: '7015', count: 5 }] }, 'component_ambiguous');
    refuse('component count', { items: [{ id: '6015', count: 0 }] }, 'component_count');
    refuse('component repeated', { items: [{ id: '6015', count: 1 }, { sku: '6015.2000', count: 2 }] }, 'component_repeated');
    refuse('translation required', { translations: undefined }, 'translation_required');
    refuse('translation langs', { translations: { name: { de: 'x' } } }, 'translation_langs');
    refuse('unknown field', { fields: { colour: 'red' } }, 'unknown_field');
    refuse('price template missing', { fields: { price_template_key: 'price-999' } }, 'price_template_missing');
    refuse('price point mismatch', { fields: { price_template_key: 'price-300' } }, 'price_point_mismatch');
    refuse('category missing', { fields: { categories: 'bundles,ghost' } }, 'category_missing');
    refuse('unknown offer key', { colour: 'red' }, 'spec_shape');
    const boxOffer = (settings) => ({ sku: 'bf-chest', name: 'Chest', copy_of: 'chest', items: undefined, translations: undefined, store: undefined, fields: { lootbox_settings: settings } });
    refuse('lootbox sku missing', boxOffer({ groups: [{ weight: 1, name: 'W', nested_items: [{ sku: 'ghost', weight: 1, count: 1 }] }] }), 'lootbox_sku_missing');
    refuse('lootbox shape', boxOffer({ groups: [] }), 'lootbox_settings_shape');

    const dropOut = path.join(dir, `drop-${tag}.xlsx`);
    const dropped = runBuild({ source, output: dropOut, offers: [offer({ translations: { name: 'drop' }, fields: { price: 30000, price_point: 30000, price_template_key: 'price-300', categories: 'bundles, for-bundles' } })] }, true);
    const dropTr = dropped.ok ? loadCatalog(dropOut).sheets.Translations : null;
    expect(`${tag}: drop name translation + price override`, dropped.ok && dropped.text.includes('300.00 USD') && !dataRows(dropTr).some((r) => cellv(dropTr, r, 'key') === 'bf-kit' && cellv(dropTr, r, 'object_property') === 'name'));
    const box = { source, output: path.join(dir, `box-${tag}.xlsx`), offers: [{ sku: 'bf-chest', name: 'Chest', copy_of: 'chest', fields: { lootbox_settings: { groups: [{ weight: 1, name: 'Top', nested_items: [{ sku: '7015.300', weight: 1, count: 1 }] }, { weight: 3, name: 'Rest', nested_items: [{ sku: '6015.500', weight: 1, count: 5 }, { sku: '2015.1500', weight: 1, count: 7 }] }] } } }] };
    const boxed = runBuild(box, true);
    expect(`${tag}: lootbox build + chances`, boxed.ok && boxed.text.includes('25.00%') && boxed.text.includes('37.50%') && boxed.text.includes('импорт Aghanim пропускает строки типа lootbox') && runCheck(box, box.output).ok);
  }
  const cdir = path.join(dir, 'catalog'), oldDir = path.join(dir, 'catalog-old'), cout = path.join(dir, 'catalog-import.xlsx');
  const exp = path.join(dir, 'export-shared.xlsx'), part = path.join(dir, 'export-part.xlsx'), extra = path.join(dir, 'export-extra.xlsx');
  const daysAgo = (file, n) => { const d = new Date(Date.now() - n * 864e5); fs.utimesSync(file, d, d); };
  const blocked = (fn) => { try { fn(); return false; } catch (e) { return e instanceof Blocked; } };
  const mem = (d = cdir) => readSnapshot('live', d).sheets;
  const cspec = (o = {}, more = {}) => ({ catalog: 'live', output: cout, offers: [{ sku: 'bf-kit', name: 'BF Kit', copy_of: 'kit', items: [{ id: '6015', count: 2200 }, { sku: '7015.300', count: 500 }], translations: { name: { de: 'BF-Set', ru: 'ЧП: Набор' } }, ...o }], ...more });
  expect('catalog: empty catalog blocks', blocked(() => runBuild(cspec(), false, cdir, 'a')));
  daysAgo(exp, 3);
  expect('catalog: learn', learnExports([exp], 'live', false, cdir).ok);
  expect('catalog: a plan remembers nothing', runBuild(cspec(), false, cdir, 'a').ok && !mem().Item.rows['bf-kit']);
  const cb = runBuild(cspec(), true, cdir, 'a');
  expect('catalog: build without an export', cb.ok && cb.text.includes('каталог live: позиций 7') && !cb.text.includes('старше'));
  if (cb.ok) {
    const out = loadCatalog(cout), it = out.sheets.Item, ne = out.sheets.NestedItem, tr = out.sheets.Translations, row = dataRows(it)[0];
    expect('catalog: file holds only the new offer', dataRows(it).length === 1 && cellv(it, row, 'sku') === 'bf-kit' && cellv(it, row, 'price') === 25000 && cellv(it, row, 'description') === 'Big kit & more' && cellv(it, row, 'is_stackable') === false && cellv(it, row, 'price_template_key') === 'price-250' && !out.sheets.PriceTemplate);
    expect('catalog: empty columns are left out like in an export', !it.header.has('lootbox_settings') && it.header.has('categories'));
    expect('catalog: nested + translations', dataRows(ne).map((r) => `${cellv(ne, r, 'sku')}x${cellv(ne, r, 'count')}`).join() === '6015.2000x2200,7015.300x500' && dataRows(tr).length === 2);
  }
  expect('catalog: the addition is remembered', !!mem().Item.rows['bf-kit'] && mem().Item.rows['bf-kit'].added === 'a' && mem().NestedItem.rows['bf-kit'].v.length === 2 && showCatalog('live', null, cdir).text.includes('ещё не встречалось в выгрузках: bf-kit'));
  expect('catalog: rebuild of the same spec converges', runBuild(cspec(), true, cdir, 'a').ok && runCheck(cspec(), null, cdir, 'a').ok && Object.keys(mem().Item.rows).length === 8);
  expect('catalog: another spec cannot reuse a remembered sku', codes(runBuild(cspec(undefined, { output: path.join(dir, 'b.xlsx') }), false, cdir, 'b')).includes('sku_exists'));
  expect('catalog: refusals still judge', codes(runBuild(cspec({ items: [{ id: '7015', count: 1 }] }), false, cdir, 'a')).includes('component_ambiguous'));
  expect('catalog: source and catalog together', codes(runBuild(cspec(undefined, { source: exp }), false, cdir, 'a')).includes('spec_shape'));
  expect('catalog: listing', showCatalog('live', '6015', cdir).text.includes('6015.500') && showCatalog('live', 'kit', cdir).text.includes('6015.2000 ×2000 «Keys»'));
  const settings = { groups: [{ id: 'g1', weight: 1, name: 'G', nested_items: [{ sku: '6015.3000', weight: 1, count: 1 }] }], pity: { steps: [{ threshold: 5, guaranteed_groups: [{ id: 'g1', weight: 1, name: 'P', nested_items: [{ sku: '7015.300', weight: 1, count: 1 }] }] }] } };
  const chain = { catalog: 'live', output: path.join(dir, 'chain.xlsx'), offers: [
    { sku: '6015.3000', name: 'Keys', copy_of: '6015.2000', fields: { quantity: 3000 } },
    { sku: 'bf-kit-2', name: 'BF Kit', copy_of: 'bf-kit', items: [{ sku: '6015.3000', count: 3000 }] },
    { sku: 'bf-chest', name: 'Chest', copy_of: 'chest', fields: { lootbox_settings: settings } },
  ] };
  const cc = runBuild(chain, true, cdir, 'c');
  expect('catalog: item, bundle and lootbox in one spec, referring to each other', cc.ok);
  if (cc.ok) {
    const it = loadCatalog(chain.output).sheets.Item, get = (sku) => dataRows(it).find((r) => cellv(it, r, 'sku') === sku);
    const ls = JSON.parse(cellv(it, get('bf-chest'), 'lootbox_settings'));
    expect('catalog: new item is like its template', cellv(it, get('6015.3000'), 'quantity') === 3000 && cellv(it, get('6015.3000'), 'type') === 'currency' && cellv(it, get('6015.3000'), 'categories') === 'for-bundles');
    expect('catalog: lootbox groups get their own ids', /^[0-9a-f-]{36}$/.test(ls.groups[0].id) && ls.pity.steps[0].guaranteed_groups[0].id !== ls.groups[0].id && !JSON.stringify(ls).includes('"g1"'));
    expect('catalog: rebuilt lootbox keeps its ids', runBuild(chain, true, cdir, 'c').ok && runCheck(chain, null, cdir, 'c').ok);
    const pack = readZip(fs.readFileSync(chain.output));
    expect('catalog: built file is a valid xlsx package', packageDefects(pack).length === 0 && packageDefects(pack.filter((e) => e.name !== '_rels/.rels')).length === 1 && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(ls.groups[0].id));
    const mine = { groups: [], pity: { steps: [] } };
    expect('lootbox: settings beyond groups and pity come from the sample', keepSampleSettings(mine, JSON.stringify({ groups: [1], pity: { steps: [1] }, view_type: 'default', price_step_up: { steps: [] } })).join() === 'view_type,price_step_up' && mine.groups.length === 0 && mine.pity.steps.length === 0 && mine.view_type === 'default');
    expect('catalog: lootbox reward must exist', codes(runBuild({ ...chain, offers: chain.offers.slice(2) }, false, cdir, 'c')).includes('lootbox_sku_missing'));
  }
  writeFixture(part, true, { Item: [sheets.Item[0], ['kit', "Dominator's Kit", 'Big kit & more', 26000, 26000, 'USD', 'price-250', 'bundle', 1, false, 'bundles', '']], NestedItem: [sheets.NestedItem[0], ['6015.500', 700, 'kit']] });
  daysAgo(part, 1);
  learnExports([part], 'live', false, cdir);
  daysAgo(exp, 90);
  learnExports([exp], 'live', false, cdir);
  expect('catalog: newer partial export updates one item, keeps the rest', mem().Item.rows.kit.v.price === 26000 && Object.keys(mem().Item.rows).length === 11 && mem().NestedItem.rows.kit.v.length === 1);
  expect('catalog: older export does not overwrite newer knowledge', mem().Item.rows['6015.500'].seen < mem().Item.rows.kit.seen && mem().Item.rows['6015.500'].seen > stampOf(new Date(Date.now() - 30 * 864e5)));
  learnExports([exp], 'live', false, oldDir);
  expect('catalog: stale knowledge is named', runBuild(cspec(), false, oldDir, 'a').text.includes(`старше ${STALE_DAYS} дней — kit`));
  writeFixture(extra, true, {
    Item: [['sku', 'name', 'quantity', 'type', 'vc_settings'], ['6015.2', 'Keys', 2000, 'currency', ''], ['6015.2000', 'Keys', 2000, 'currency', ''], ['gold', 'Gold', 1, 'virtual_currency', '{"rate": 1}'], ['kit2', 'Kit 2', 1, 'bundle', '']],
    NestedItem: [['sku', 'count', 'parent_sku', 'is_featured'], ['6015.2', 2000, 'kit2', true]],
  });
  const whole = learnExports([part, extra], 'live', true, oldDir);
  expect('catalog: several exports learned as the whole catalog', whole.ok && Object.keys(mem(oldDir).Item.rows).length === 5 && mem(oldDir).Item.header.includes('vc_settings') && mem(oldDir).Item.header.includes('price') && whole.text.includes('virtual_currency 1'));
  const twinOut = path.join(dir, 'twin.xlsx');
  const twin = runBuild({ catalog: 'live', output: twinOut, offers: [{ sku: 'kit3', name: 'Kit 2', copy_of: 'kit2' }] }, true, oldDir, 't');
  expect('catalog: truncated twin sku is named', twin.ok && twin.text.includes('6015.2 (полный 6015.2000)') && showCatalog('live', null, oldDir).text.includes('6015.2 ← 6015.2000'));
  if (twin.ok) { const ne = loadCatalog(twinOut).sheets.NestedItem; expect('catalog: extra nested columns survive a copy', cellv(ne, dataRows(ne)[0], 'is_featured') === true); }
  const hubDom = `<a id="category-link-top-seller"></a><h2 id="top-seller" data-sticky-top="true">Top Seller </h2>
    <div id="itm_A1" class="x" data-card-variant="default-vertical" data-card-item-id="itm_A1"><div data-element-component="sku-bundle-grid"><div>x750</div><svg><path d="M0"/></svg><div>x5</div></div>
    <div data-element-component="sku-name"><span data-quantity="true">Dominator&#x27;s Kit</span></div><div data-element-component="sku-badges"><span data-badge-key="remaining"><span>1/1</span> left</span><div data-badge-key="discount"><span>-90 %</span> Discount</div></div>
    <div data-element-component="sku-mismatch-description">Available at level 3</div><div data-element-component="button-buy"><button data-variant="component-buy"><span data-testid="store-card/price_after_discount">$25.00</span><span data-strikethrough="true" data-strikethrough-variant="diagonal" data-testid="store-card/price">$249.99</span></button></div>
    <div data-element-component="sku-badges"><div data-badge-key="points"><bdi>+18</bdi><bdi>+22</bdi></div></div></div>
    <div id="itm_B2" data-card-variant="default-vertical" data-card-item-id="itm_B2"><div data-element-component="sku-name"><span>Daily Bonus</span></div><div data-element-component="button-buy"><button data-variant="component-free"><span>Free</span></button></div></div><footer>Operated by Aghanim</footer>`;
  const hub = parseHub(hubDom), hubText = hubReport(hub, 'https://example.test/store', null, null).text;
  expect('hub: sections and cards', hub.length === 1 && hub[0].slug === 'top-seller' && hub[0].title === 'Top Seller' && hub[0].cards.length === 2);
  expect('hub: card line', hubText.includes("Dominator's Kit — $25.00 (было $249.99) · 1/1 left · -90 % Discount · очки +18 / +22 · Available at level 3 · состав: x750, x5 [itm_A1]") && hubText.includes('Daily Bonus — Free [itm_B2]'));
  expect('hub: empty page is refused', !hubReport(parseHub('<html><body>shell</body></html>'), 'u', null, null).ok);
  const csv = ['payment_ID,item,sku,price,status,psp_name,payment_date,order_amount,payment_currency,taxes,promo,player_id,user_country',
    'p1,Kit,kit,250,succeeded,Cards,2026-11-01 10:00:00+00:00,25,USD,0,[],u1,US',
    'p2,Kit,kit,250,succeeded,Cards,2026-11-01 23:30:00+00:00,25,USD,0,[],u2,US',
    'p3,Kit,kit,500,succeeded,Cards,2026-11-02 11:00:00+00:00,50,EUR,0,"[{""type"": ""base_discount"", ""discount"": 90}]",u3,DE',
    'p4,Kit,kit,250,failed,Cards,2026-11-02 12:00:00+00:00,0,USD,0,[],u4,US',
    'p5,Keys,6015.2000,5,succeeded,Reward Points,2026-11-02 13:00:00+00:00,5,RP,0,[],u1,US',
    'p6,Keys,6015.2000,2,succeeded,Gift Cards,2026-11-02 14:00:00+00:00,2,USD,0,[],u1,US',
    'p7,Chest,chest,5,pending,Cards,2026-11-02 15:00:00+00:00,0,USD,0,[],u5,US',
    'p8,Solo,solo,9000,succeeded,Cards,2026-11-02 16:00:00+00:00,900,XXX,0,[],u6,ZZ'].join('\n');
  const sales = salesReport(csv, { top: 5 }, readSnapshot('live', cdir)).text;
  expect('sales: money only, converted to USD', sales.includes('Выручка $75 · оплаченных покупок 3 · покупателей 4 · средний чек $25.00 · конверсия оплаты 80.0%') && sales.includes('за бонусные очки 1 покупок, подарочными картами 1'));
  expect('sales: top offer, type from the catalog, incomplete last day, currency without a rate', sales.includes('1. Kit (kit · bundle) — $75 · 100.0% · покупок 3 · покупателей 3') && sales.includes('последний день неполный') && sales.includes('XXX — 1'));
  expect('sales: period filter', salesReport(csv, { from: '2026-11-01', to: '2026-11-01' }, null).text.includes('Выручка $50 · оплаченных покупок 2') && !salesReport(csv, { from: '2027-01-01' }, null).ok && !salesReport('a,b\n1,2', {}, null).ok);
  const emptyProgram = pageFacts('<title>Old Season</title><main style="grid-area:content"><section accesskey="ProgressionProgramBlock"><div data-hub-entity="progression-program" data-hub-entity-id="pgp_1"></div></section></main><div data-testid="shell-sidebar-right">Events</div>');
  const liveProgram = pageFacts('<title>Frost</title><main style="grid-area:content"><div data-hub-entity="progression-program" data-hub-entity-id="pgp_2"><div>Level 1</div><div>Reward</div></div></main><div data-testid="shell-sidebar-right"></div>');
  expect('audit: empty and live program blocks', emptyProgram.entities[0].empty && emptyProgram.title === 'Old Season' && !liveProgram.entities[0].empty && liveProgram.texts.length === 2);
  const auditPages = [{ path: 'news', facts: pageFacts('<main style="grid-area:content"><p>Patch notes</p><p>More</p></main>') }, { path: 'faq', facts: pageFacts('<main style="grid-area:content"></main>') }, { path: 'first-frost', facts: emptyProgram }, { path: 'updates', facts: null }, { path: 'offer', source: 'sitemap', facts: pageFacts('<main style="grid-area:content"></main>') }, { path: 'old-season', facts: pageFacts('<main style="grid-area:content"><div data-hub-entity="progression-program" data-hub-entity-id=""></div></main>') }];
  const audit = auditReport('https://example.test', auditPages, hub, [{ label: "Dominator's Kit", names: ["Dominator's Kit"] }, { label: 'BF Kit', names: ['BF Kit', 'ЧП: Набор'] }], []).text;
  expect('audit: pages', audit.includes('? страница /first-frost «Old Season» — программа прогрессии подключена (pgp_1)') && audit.includes('? страница /offer — пустая для гостя') && audit.includes('✖ страница /old-season — блок программы прогрессии пустой и программа к нему не подключена') && audit.includes('гостем не проверить 2') && audit.includes('✔ страница /news — есть содержимое') && audit.includes('✖ страница /faq — пустая') && audit.includes('✖ страница /updates не открылась'));
  expect('audit: store', audit.includes("✔ оффер «Dominator's Kit» стоит на витрине") && audit.includes('✖ оффера «BF Kit» на витрине нет') && audit.includes('✔ у всех платных карточек есть цена') && audit.includes('✔ витрина /store — 2 карточек в 1 разделах'));
  const iconRepo = path.join(dir, 'client'), iconFrom = path.join(iconRepo, WEAPON_ICONS);
  fs.mkdirSync(iconFrom, { recursive: true });
  for (const t of ['war_horse', 'deaths_fruit', 'odd tag']) fs.writeFileSync(path.join(iconFrom, `${t}_icon1_big.png`), 'png');
  const iconSpec = { offers: [{ sku: '1326001.1', name: 'Horse' }, { sku: '1875001.1', name: "Death's Fruit" }, { sku: '5001.1', name: 'Odd', icon: 'odd tag' }, { sku: '9001.1', name: 'Ghost' }, { sku: 'bf-chest', name: 'Chest' }] };
  const icons = runIcons(iconSpec, path.join(dir, 'art'), iconRepo, new Map([['1326001', 'war_horse']]));
  expect('icons: by index, by name, by the icon field; a miss is named', !icons.ok && icons.text.includes('найдено 3 из 4') && icons.text.includes('✖ 9001.1') && ['1326001.1_war_horse', '1875001.1_deaths_fruit', '5001.1_odd tag'].every((f) => fs.existsSync(path.join(dir, 'art', `${f}.png`))));
  const built = withIcons('plan\nDone: built', iconSpec, path.join(dir, 'art2'), iconRepo, new Map());
  expect('icons: the build collects them and keeps its own verdict last', built.endsWith('\nDone: built') && built.includes('иконки пушек: иконок найдено 2 из 4') && fs.existsSync(path.join(dir, 'art2', '1875001.1_deaths_fruit.png')) && withIcons('Done: built', { offers: [{ sku: 'bf-kit' }] }, dir, iconRepo, new Map()) === 'Done: built' && withIcons('Done: built', iconSpec, dir, null, new Map()).startsWith('иконки пушек не собраны'));
  expect('audit: missing program page is named', auditReport('https://example.test', auditPages.slice(0, 2), hub, [], []).text.includes('страница программы прогрессии не найдена'));
  const example = JSON.parse(JSON.stringify(SPEC_EXAMPLE).replaceAll('<home>', os.homedir().replace(/\\/g, '/')));
  expect('spec example has a valid shape', shapeDefects(example).length === 0);
  expect('routes are declared in the header', routes().length === 13);
  if (fs.existsSync(SKILL_MD)) expect('SKILL.md command table matches @route tags (run --sync-docs)', fs.readFileSync(SKILL_MD, 'utf8').includes(`${OPS_OPEN}\n${opsIndex()}\n${OPS_CLOSE}`));
  expect('how-it-works exists and matches the script (run --sync-docs)', fs.existsSync(DOC_PATH) && fs.readFileSync(DOC_PATH, 'utf8') === describe());
  fs.rmSync(dir, { recursive: true, force: true });
  return fails.length ? { ok: false, text: `Rejected: defects_found — selftest: ${fails.length} failed\n${fails.map((f) => `  - ${f}`).join('\n')}` } : { ok: true, text: 'Done: selftest passed' };
}

// ---------- entry ----------

async function main() {
  const argv = process.argv.slice(2);
  const values = (n) => argv.flatMap((a, i) => (a === n && argv[i + 1] && !argv[i + 1].startsWith('--') ? [argv[i + 1]] : []));
  const flag = (n) => (argv.includes(n) ? values(n)[0] || true : null);
  const abs = (n, v) => { if (typeof v !== 'string' || !path.isAbsolute(v)) throw new Blocked(`${n} ждёт абсолютный путь`); return v; };
  const need = (n) => abs(n, flag(n));
  const find = typeof flag('--find') === 'string' ? flag('--find') : null;
  let r;
  if (flag('--selftest')) r = selftest();
  else if (flag('--describe')) r = { ok: true, text: describe() };
  else if (flag('--sync-docs')) r = { ok: true, text: syncDocs() };
  else if (flag('--learn') || flag('--catalog')) {
    const env = flag('--learn') ? flag('--env') : flag('--catalog');
    if (!ENVS.includes(env)) throw new Blocked(`окружение каталога — ${ENVS.join(' или ')}`);
    if (flag('--learn') && !values('--learn').length) throw new Blocked('--learn ждёт абсолютный путь к выгрузке');
    r = flag('--learn') ? learnExports(values('--learn').map((v) => abs('--learn', v)), env, !!flag('--full')) : showCatalog(env, find);
  } else if (flag('--inspect')) r = inspect(loadCatalog(need('--inspect')), need('--inspect'), find);
  else if (flag('--hub')) r = runHub(String(flag('--hub')), flag('--shot') ? need('--shot') : null);
  else if (flag('--sales')) {
    let text;
    try { text = fs.readFileSync(need('--sales'), 'utf8'); } catch (e) { if (e instanceof Blocked) throw e; throw new Blocked(`файл не читается: ${flag('--sales')}`); }
    const date = (n) => (typeof flag(n) === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(flag(n)) ? flag(n) : undefined);
    r = salesReport(text, { from: date('--from'), to: date('--to'), top: Number(flag('--top')) || 15 }, readSnapshot('live', CATALOG_DIR));
  }
  else if (flag('--audit')) r = await runAudit(String(flag('--audit')), values('--page'), flag('--expect') ? need('--expect') : null);
  else if (flag('--icons')) {
    const file = need('--icons');
    const repo = flag('--repo') ? need('--repo') : clientRepo();
    if (!repo) throw new Blocked(`путь к репозиторию клиента не записан: дайте --repo <abs> или запишите {"repo": "…"} в ${CLIENT_FILE}`);
    const spec = readSpec(file), shape = shapeDefects(spec);
    r = shape.length ? { ok: false, text: refusal(shape) } : runIcons(spec, iconsDir(file), repo, weaponTags(TAGS_CACHE));
  }
  else if (flag('--plan')) r = runBuild(readSpec(need('--plan')), false, CATALOG_DIR, specIdOf(need('--plan')));
  else if (flag('--build')) {
    const file = need('--build'), spec = readSpec(file);
    r = runBuild(spec, true, CATALOG_DIR, specIdOf(file));
    if (r.ok) r.text = withIcons(r.text, spec, iconsDir(file), clientRepo(), weaponTags(TAGS_CACHE));
  }
  else if (flag('--check')) r = runCheck(readSpec(need('--check')), flag('--against') ? need('--against') : null, CATALOG_DIR, specIdOf(need('--check')));
  else throw new Blocked(`команда не названа:\n${routes().map((x) => `  ${x.args} — ${x.does}`).join('\n')}`);
  console.log(r.text);
  process.exit(r.ok ? 0 : 1);
}

try { await main(); } catch (e) {
  if (!(e instanceof Blocked)) throw e;
  console.log(`Blocked: missing_input — ${e.message}`);
  process.exit(2);
}
