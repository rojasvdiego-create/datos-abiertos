import { mkdir, readFile, writeFile } from 'node:fs/promises';

const paths = ['src/worker.js', 'src/index.html', 'src/xlsx.min.js', 'src/entities.json'];
const [worker, page, xlsx, entities] = await Promise.all(paths.map(path => readFile(path, 'utf8')));
await mkdir('dist/server', { recursive: true });
await writeFile('dist/server/index.js',
  'const PAGE = ' + JSON.stringify(page) + ';\nconst XLSX_JS = ' + JSON.stringify(xlsx) + ';\n' + 'const ENTITIES = ' + entities.trim() + ';\n' + worker);
