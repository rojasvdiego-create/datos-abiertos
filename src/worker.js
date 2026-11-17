const LIMIT = 4 * 1024 * 1024;
const MAX_ROWS = 10000;

class InputError extends Error {}

function publicUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new InputError('Ingresa una URL pública válida.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]+$/i.test(url.hostname) ||
      /\.(local|localhost|internal|lan|test|invalid|onion|example|arpa|corp|home)$/i.test(url.hostname)) {
    throw new InputError('Usa una URL web pública con nombre de dominio, sin usuario ni contraseña.');
  }
  url.hash = '';
  return url;
}

async function download(url) {
  const signal = AbortSignal.timeout(18000);
  for (let redirects = 0; redirects <= 4; redirects++) {
    const response = await fetch(url, { redirect: 'manual', signal, headers: {
      Accept: 'text/html, application/json, text/csv, */*;q=0.1',
    } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) break;
      url = publicUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok) throw new InputError('La fuente respondió con el código HTTP ' + response.status + '.');
    if (!response.body || Number(response.headers.get('content-length')) > LIMIT) {
      await response.body?.cancel();
      throw new InputError('La fuente está vacía o supera el límite de 4 MB.');
    }
    const type = response.headers.get('content-type') || '';
    const encoding = type.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] || 'utf-8';
    let decoder;
    try { decoder = new TextDecoder(encoding); } catch { decoder = new TextDecoder(); }
    const reader = response.body.getReader();
    let text = '';
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LIMIT) {
        await reader.cancel();
        throw new InputError('La fuente supera el límite de 4 MB.');
      }
      text += decoder.decode(value, { stream: true });
    }
    return { text: text + decoder.decode(), type, url: url.href };
  }
  throw new InputError('La fuente tiene demasiadas redirecciones o una redirección inválida.');
}

const display = value => value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : value;
const clean = value => value.replace(/\s+/g, ' ').trim();
function htmlText(value) {
  return clean(value.replace(/&(#(?:x[\da-f]+|\d+);?|[a-z][\da-z]*;?)/gi, (full, token) => {
    if (token[0] !== '#') return Object.hasOwn(ENTITIES, token) ? ENTITIES[token] : full;
    const numeric = token.substring(1).replace(/;$/, '');
    const hex = numeric[0].toLowerCase() === 'x';
    const point = Number.parseInt(hex ? numeric.slice(1) : numeric, hex ? 16 : 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ?
      String.fromCodePoint(point) : '\uFFFD';
  }));
}

function jsonTables(data) {
  const tables = [];
  function visit(value, name, depth) {
    if (depth > 5 || tables.length >= 24 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      if (!value.length) return;
      const keys = new Set();
      const entries = value.slice(0, MAX_ROWS).map(row => row?.type === 'Feature' && row.properties ?
        { id: row.id ?? '', ...row.properties, geometria: row.geometry } : row);
      for (const row of entries) {
        if (row && typeof row === 'object') {
          Object.keys(row).forEach(key => { if (keys.size < 100) keys.add(key); });
        } else if (keys.size < 100) keys.add('Valor');
      }
      const headers = [...keys];
      tables.push({ name, headers, total: value.length, rows: entries.map(row =>
        headers.map(key => display(row && typeof row === 'object' ? (Object.hasOwn(row, key) ? row[key] : '') : key === 'Valor' ? row : ''))) });
      return;
    }
    const blocks = Object.entries(value);
    const fields = blocks.filter(([, item]) => item === null || typeof item !== 'object');
    if (fields.length && depth === 0) {
      tables.push({ name: 'Campos principales', headers: fields.slice(0, 100).map(([key]) => key),
        total: 1, rows: [fields.slice(0, 100).map(([, item]) => display(item))] });
    }
    for (const [key, child] of blocks) visit(child, depth ? name + ' › ' + key : key, depth + 1);
    if (!tables.length && depth === 0 && blocks.length) {
      tables.push({ name, headers: ['Campo', 'Valor'], total: blocks.length,
        rows: blocks.slice(0, MAX_ROWS).map(([key, item]) => [key, display(item)]) });
    }
  }
  visit(data, 'Datos JSON', 0);
  return tables;
}

function csvTable(text) {
  const first = text.split(/\r?\n/, 1)[0].replace(/"(?:""|[^"])*"/g, '');
  const delimiters = [',', ';', '\t'];
  const delimiter = delimiters.sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const rows = [];
  let row = [], field = '', quoted = false, total = 0;
  function finishRow() {
    row.push(field);
    if (row.some(value => value !== '')) {
      if (rows.length <= MAX_ROWS) rows.push(row.slice(0, 100));
      total++;
    }
    row = [];
    field = '';
  }
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"' && quoted && text[i + 1] === '"') { field += '"'; i++; }
    else if (char === '"' && (quoted || !field)) quoted = !quoted;
    else if (!quoted && char === delimiter) { row.push(field); field = ''; }
    else if (!quoted && (char === '\n' || char === '\r')) {
      finishRow();
      if (char === '\r' && text[i + 1] === '\n') i++;
    } else field += char;
  }
  if (quoted) throw new InputError('El archivo CSV contiene comillas sin cerrar.');
  if (field || row.length) finishRow();
  const headers = rows.shift();
  if (!headers || !rows.length) return [];
  const width = rows.reduce((max, entry) => Math.max(max, entry.length), headers.length);
  return [{ name: 'Archivo CSV', headers: Array.from({ length: width }, (_, i) => clean(headers[i] || '') || 'Columna ' + (i + 1)),
    rows, total: total - 1 }];
}

async function htmlTables(html) {
  const candidates = [];
  let table, row, cell, caption = false;
  const rewriter = new HTMLRewriter()
    .on('table', { element(el) {
      const previous = table;
      const previousRow = row;
      const previousCell = cell;
      table = { name: '', entries: [], total: 0 };
      row = cell = null;
      const current = table;
      el.onEndTag(() => {
        if (current.entries.length && candidates.length < 24) candidates.push(current);
        table = previous;
        row = previousRow;
        cell = previousCell;
      });
    } })
    .on('table caption', { element(el) { caption = true; el.onEndTag(() => { caption = false; }); },
      text(chunk) { if (caption && table) table.name += chunk.text; } })
    .on('table tr', { element(el) {
      const current = table;
      if (!current) return;
      const entry = { cells: [], headings: true };
      row = entry;
      el.onEndTag(() => {
        if (entry.cells.length) {
          if (current.entries.length <= MAX_ROWS + 10) current.entries.push(entry);
          current.total++;
        }
        row = cell = null;
      });
    } })
    .on('table tr th, table tr td', { element(el) {
      if (!row) return;
      const entry = row;
      const span = name => Math.min(100, Math.max(1, Number.parseInt(el.getAttribute(name), 10) || 1));
      const value = { text: '', columns: span('colspan'), rows: span('rowspan') };
      cell = value;
      if (el.tagName === 'td') entry.headings = false;
      el.onEndTag(() => { if (entry.cells.length < 100) entry.cells.push(value); cell = null; });
    } })
    .on('table tr th, table tr td', { text(chunk) { if (cell) cell.text += chunk.text; } });
  await rewriter.transform(new Response(html)).arrayBuffer();
  return candidates.map((candidate, index) => {
    const grid = [];
    let width = 0;
    for (const [i, entry] of candidate.entries.entries()) {
      const line = grid[i] ||= [];
      let col = 0;
      for (const value of entry.cells) {
        while (line[col] !== undefined && col < 100) col++;
        for (let down = i; down < Math.min(i + value.rows, candidate.entries.length); down++) {
          const target = grid[down] ||= [];
          for (let right = col; right < Math.min(col + value.columns, 100); right++) {
            target[right] ??= htmlText(value.text);
          }
        }
        col += value.columns;
      }
      width = Math.max(width, line.length);
    }
    let headingRows = 0;
    while (candidate.entries[headingRows]?.headings) headingRows++;
    const headers = Array.from({ length: width }, (_, i) =>
      [...new Set(grid.slice(0, headingRows).map(line => line[i]).filter(Boolean))].join(' / ') || 'Columna ' + (i + 1));
    return { name: htmlText(candidate.name) || 'Tabla ' + (index + 1), headers,
      rows: grid.slice(headingRows, headingRows + MAX_ROWS).map(line =>
        Array.from({ length: width }, (_, i) => line[i] ?? '')),
      total: candidate.total - headingRows };
  }).filter(table => table.rows.length);
}

async function extract(url) {
  const resource = await download(publicUrl(url));
  const body = resource.text.replace(/^\uFEFF/, '').trim();
  let tables, format;
  if (/json/i.test(resource.type) || (!/csv|tab-separated/i.test(resource.type) && /^[\[{]/.test(body))) {
    format = 'JSON';
    try { tables = jsonTables(JSON.parse(body)); } catch { throw new InputError('La fuente devolvió un JSON inválido.'); }
  } else if (/^(?:text\/(?:csv|plain|tab-separated-values)|application\/csv)/i.test(resource.type) ||
             /\.(csv|tsv)$/i.test(new URL(resource.url).pathname)) {
    format = 'CSV';
    tables = csvTable(body);
  } else if (/html/i.test(resource.type) || /^</.test(body)) {
    format = 'HTML';
    tables = await htmlTables(body);
  }
  if (!tables?.length) throw new InputError('No se encontraron tablas ni listas compatibles. Prueba con el enlace directo a un CSV o JSON, o con una página que ya incluya tablas en su HTML.');
  return { format, source: resource.url, tables };
}

export default {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/' && request.method === 'GET') return new Response(PAGE, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff' },
    });
    if (path === '/xlsx.js' && request.method === 'GET') return new Response(XLSX_JS, {
      headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'public, max-age=86400' },
    });
    if (path !== '/api/extract' || request.method !== 'POST') return new Response('Ruta no encontrada', { status: 404 });
    try {
      const input = await request.json();
      if (typeof input?.url !== 'string' || input.url.length > 2048) throw new InputError('Ingresa una URL de hasta 2048 caracteres.');
      return Response.json(await extract(input.url), { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      return Response.json({ error: error instanceof InputError ? error.message :
        'No se pudo leer la fuente. Revisa el enlace o intenta nuevamente.' }, { status: error instanceof InputError ? 422 : 502 });
    }
  },
};
