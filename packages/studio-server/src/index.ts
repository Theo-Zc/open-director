import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStudioServer } from './server.js';

export * from './server.js';

const isEntry = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntry) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const defaultProject = resolve(__dirname, '../../../examples/demo-talking-head');
  const projectDir = resolve(process.env.OPEN_DIRECTOR_PROJECT ?? process.argv[2] ?? defaultProject);
  const webDistDir = resolve(__dirname, '../../../apps/studio-web/dist');

  startStudioServer({
    projectDir,
    webDistDir: existsSync(webDistDir) ? webDistDir : undefined,
  })
    .then((handle) => {
      console.log('');
      console.log(`  Open Director Studio -> ${handle.origin}`);
      console.log(`  Active project       -> ${projectDir}`);
      console.log(`  (Internal film stage -> ${handle.filmOrigin})`);
      console.log('');
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
