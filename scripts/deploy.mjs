// Builds the app and force-pushes dist/ to the gh-pages branch of origin.
// GitHub: Settings -> Pages -> Source: "Deploy from a branch", branch gh-pages / (root).
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const run = (cmd, cwd) => execSync(cmd, { stdio: 'inherit', cwd });
const out = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();

const remote = out('git remote get-url origin');
const rev = out('git rev-parse --short HEAD');

run('npm run build');
writeFileSync('dist/.nojekyll', ''); // keep files starting with "_" etc.
run('git init -q -b gh-pages', 'dist');
run('git add -A', 'dist');
run(`git commit -q -m "Deploy ${rev}"`, 'dist');
run(`git push -f "${remote}" gh-pages`, 'dist');
console.log('\nDeployed to gh-pages.');
